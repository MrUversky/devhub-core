import { randomUUID } from "node:crypto";
import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";
import { CatalogSourceError, readSourceCatalog, reconcileProject } from "./catalog-tools.mjs";
import { validateHostsDocument, validateProjectDocument } from "./catalog-validation.mjs";
import { resolveDevHubPaths } from "./devhub-config.mjs";
import { semanticDiff } from "./semantic-diff.mjs";

const stableIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const RECONCILIATION_EXIT = Object.freeze({
  clean: 0,
  drift: 2,
  invalid: 3,
});

export class ReconciliationApplyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReconciliationApplyError";
    this.code = code;
  }
}

function humanizeStableId(id) {
  return id
    .split("-")
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function packageTitle(packageName) {
  if (typeof packageName !== "string" || !packageName.trim()) return null;
  return packageName.replace(/^@[^/]+\//, "").trim() || null;
}

function repositoryTitle(repository) {
  if (typeof repository !== "string") return null;
  return repository.split("/").at(-1)?.trim() || null;
}

function overlayResultError(target, error) {
  return {
    version: 1,
    command: "propose-overlay",
    readOnly: true,
    status: "invalid",
    exitCode: RECONCILIATION_EXIT.invalid,
    target: path.resolve(target),
    registration: "overlay",
    catalogMutation: false,
    externalRepositoryMutation: false,
    candidate: null,
    evidence: null,
    defaults: [],
    unknowns: [],
    error,
  };
}

export function formatOverlayProposal(result) {
  const lines = [
    `DevHub overlay proposal for ${result.target}`,
    `Status: ${result.status}`,
    "Writes: none — candidate is printed outside the live catalog",
  ];
  if (result.error) {
    lines.push(`Cannot propose: ${result.error.code} — ${result.error.message}`);
    return lines.join("\n");
  }
  lines.push(`Stable ID: ${result.candidate.id}`);
  lines.push(`Review destination: ${result.candidate.reviewDestination}`);
  lines.push(`Existing overlay: ${result.existingOverlay ? result.existingOverlay.source : "none"}`);
  lines.push("Evidence:");
  lines.push(`- repository: ${result.evidence.repository.repository ?? "not observed"}`);
  lines.push(`- package: ${result.evidence.package?.name ?? "not observed"}`);
  lines.push(`- compose files: ${result.evidence.composeFiles.join(", ") || "none observed"}`);
  lines.push(`- workspace: ${result.evidence.workspace ? `${result.evidence.workspace.host}:${result.evidence.workspace.path}` : "not proposed"}`);
  lines.push("Explicit unknowns:");
  for (const unknown of result.unknowns) lines.push(`- ${unknown.field}: ${unknown.reason}`);
  lines.push("Candidate YAML (review only):");
  lines.push(result.candidate.yaml.trimEnd());
  return lines.join("\n");
}

export async function createOverlayProposal(root, target, runtimeHostId, {
  paths = resolveDevHubPaths(root),
  proposedId = null,
} = {}) {
  const resolvedTarget = path.resolve(target);
  if (proposedId !== null && !stableIdPattern.test(proposedId)) {
    return overlayResultError(resolvedTarget, {
      code: "invalid-overlay-id",
      message: "The proposed overlay id must use stable lowercase kebab-case.",
    });
  }

  let base;
  let sourceCatalog;
  try {
    [base, sourceCatalog] = await Promise.all([
      reconcileProject(paths.root, resolvedTarget, runtimeHostId, { paths }),
      readSourceCatalog(paths.root, { paths }),
    ]);
  } catch (error) {
    return overlayResultError(resolvedTarget, {
      code: error instanceof CatalogSourceError ? error.code : "catalog-read-failed",
      source: error instanceof CatalogSourceError ? error.source : paths.catalogDirectory,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  if (base.ambiguity) {
    return overlayResultError(resolvedTarget, {
      code: base.ambiguity.code,
      message: base.ambiguity.message,
      candidates: base.ambiguity.candidates,
    });
  }
  if (base.evidence.nativeManifest) {
    return overlayResultError(resolvedTarget, {
      code: "registration-boundary",
      message: "This project contains a project-owned .devhub/project.yaml; resolve the native ownership record instead of creating an overlay proposal.",
    });
  }

  const requestedRecord = proposedId
    ? sourceCatalog.projects.find(({ manifest }) => manifest.id === proposedId) ?? null
    : null;
  const matchedRecord = base.match
    ? sourceCatalog.projects.find(({ manifest }) => manifest.id === base.match.project.id) ?? null
    : null;

  if (requestedRecord && requestedRecord.manifest.registration !== "overlay") {
    return overlayResultError(resolvedTarget, {
      code: "registration-boundary",
      message: `${proposedId} is an existing native record; it cannot be proposed as an overlay.`,
    });
  }
  if (matchedRecord && matchedRecord.manifest.registration !== "overlay") {
    return overlayResultError(resolvedTarget, {
      code: "registration-boundary",
      message: `${matchedRecord.manifest.id} already matches this project as a native record.`,
    });
  }
  if (requestedRecord && matchedRecord && requestedRecord.manifest.id !== matchedRecord.manifest.id) {
    return overlayResultError(resolvedTarget, {
      code: "overlay-identity-conflict",
      message: `The proposed id ${proposedId} conflicts with reviewed overlay ${matchedRecord.manifest.id}.`,
    });
  }

  const existing = requestedRecord ?? matchedRecord;
  if (!existing && !proposedId) {
    return overlayResultError(resolvedTarget, {
      code: "overlay-id-required",
      message: "No existing overlay matches this project; provide a proposed stable ID.",
    });
  }

  const id = existing?.manifest.id ?? proposedId;
  const runtimeHostKnown = runtimeHostId && sourceCatalog.hostIds.has(runtimeHostId);
  const observedTitle = packageTitle(base.evidence.package?.name)
    ?? repositoryTitle(base.repository.repository);
  const title = observedTitle ?? humanizeStableId(id);
  const defaults = [];
  let manifest;

  if (existing) {
    manifest = structuredClone(existing.manifest);
  } else {
    defaults.push(
      { field: "title", value: title, reason: observedTitle ? "Derived from observed package or repository identity." : "Derived from the explicit stable ID for review." },
      { field: "description", value: `Overlay proposal for ${title}.`, reason: "Neutral proposal scaffolding; replace with reviewed project context." },
      { field: "lifecycle", value: "discovery", reason: "A new proposal is not assumed to be active or production." },
      { field: "kind", value: "project", reason: "Generic proposal scaffolding; replace when the project kind is reviewed." },
    );
    manifest = {
      version: 1,
      id,
      title,
      registration: "overlay",
      description: `Overlay proposal for ${title}.`,
      lifecycle: "discovery",
      kind: "project",
      ...(base.repository.repository ? { repository: base.repository.repository } : {}),
      ...(runtimeHostKnown ? { workspaces: [{ host: runtimeHostId, path: resolvedTarget }] } : {}),
      services: [],
    };
  }

  const unknowns = [];
  if (!base.repository.repository && !manifest.repository) {
    unknowns.push({ field: "repository", reason: "No normalized GitHub origin was observed." });
  }
  if (!existing && !runtimeHostKnown) {
    unknowns.push({
      field: "workspaces",
      reason: runtimeHostId
        ? `Runtime host ${runtimeHostId} is not in the reviewed host catalog.`
        : "No reviewed runtime host ID was supplied.",
    });
  }
  unknowns.push({
    field: "services",
    reason: existing
      ? "Repository inspection did not establish any change to the reviewed service definitions."
      : base.evidence.composeFiles.length
        ? "Compose files were observed, but service identity, lifecycle and ownership require review."
        : "No reviewed runnable-service definitions were observed.",
  });
  unknowns.push(
    {
      field: "services[].host",
      reason: existing
        ? "No change to reviewed service hosts is inferred from a checkout path."
        : "No service host is inferred from a checkout path.",
    },
    {
      field: "services[].url/probe",
      reason: existing
        ? "No change to reviewed URLs or probes was observed."
        : "No URLs or health probes are inferred or probed.",
    },
    {
      field: "services[].commands",
      reason: existing
        ? "No change to reviewed commands was observed from package or Compose metadata."
        : "Package scripts and Compose filenames are evidence only; commands are not promoted automatically.",
    },
  );
  if (existing) {
    unknowns.push({
      field: "reviewed overlay drift",
      reason: "The existing overlay remains authoritative; repository inspection alone cannot prove operational fields changed.",
    });
  }

  try {
    validateProjectDocument(manifest, {
      source: `overlay proposal ${id}`,
      hostIds: sourceCatalog.hostIds,
      expectedId: id,
    });
  } catch (error) {
    return overlayResultError(resolvedTarget, {
      code: "invalid-overlay-candidate",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    version: 1,
    command: "propose-overlay",
    readOnly: true,
    status: "review-required",
    exitCode: RECONCILIATION_EXIT.drift,
    target: resolvedTarget,
    registration: "overlay",
    catalogMutation: false,
    externalRepositoryMutation: false,
    existingOverlay: existing ? {
      id: existing.manifest.id,
      source: existing.source,
      matchType: base.match?.project.id === existing.manifest.id ? base.match.matchType : "explicit-id",
    } : null,
    evidence: {
      target: resolvedTarget,
      repository: base.repository,
      package: base.evidence.package,
      composeFiles: base.evidence.composeFiles,
      nativeManifest: base.evidence.nativeManifest,
      workspace: runtimeHostKnown ? { host: runtimeHostId, path: resolvedTarget } : null,
    },
    defaults,
    unknowns,
    candidate: {
      id,
      transport: "stdout",
      reviewDestination: path.join(paths.projectDirectory, `${id}.yaml`),
      manifest,
      yaml: stringify(manifest, { lineWidth: 0 }),
    },
    error: null,
  };
}

function displayValue(value) {
  return value === undefined ? "(absent)" : JSON.stringify(value);
}

export function formatReconciliation(result, { diffOnly = false } = {}) {
  const lines = [];
  if (!diffOnly) {
    lines.push(`DevHub reconciliation plan for ${result.target}`);
    lines.push(`Status: ${result.status}`);
    lines.push(`Registration: ${result.registration.recommendation} — ${result.registration.reason}`);
    lines.push(`Catalog match: ${result.match ? `${result.match.project.id} (${result.match.source})` : "none"}`);
    lines.push(`Action: ${result.plan.action}`);
    lines.push(`Review required: ${result.reviewRequired ? "yes" : "no"}`);
  } else {
    lines.push(`DevHub semantic diff for ${result.target}`);
    lines.push(`Status: ${result.status}`);
  }

  if (result.diff.length === 0) {
    lines.push("No semantic field changes.");
  } else {
    lines.push("Semantic field changes:");
    for (const change of result.diff) {
      if (change.state === "changed") {
        lines.push(`~ ${change.path}: ${displayValue(change.catalog)} -> ${displayValue(change.project)}`);
      } else if (change.state === "added") {
        lines.push(`+ ${change.path}: ${displayValue(change.project)}`);
      } else {
        lines.push(`- ${change.path}: ${displayValue(change.catalog)}`);
      }
    }
  }

  if (!diffOnly) {
    lines.push(`Plan: ${result.plan.reason}`);
    if (result.error) lines.push(`Cannot apply: ${result.error.code} — ${result.error.message}`);
    if (result.proposal) {
      lines.push(`Proposal: ${result.proposal.note}`);
      lines.push(`Unverified fields omitted: ${result.proposal.omittedUnverifiedFields.join(", ")}`);
    }
    if (result.plan.applicable) lines.push("Apply only after review with: devhub reconcile <project> --apply");
  }
  return lines.join("\n");
}

async function optionalRead(filename) {
  try {
    return await readFile(filename, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function parseManifest(contents, source) {
  try {
    return { manifest: parse(contents), error: null };
  } catch (error) {
    return {
      manifest: null,
      error: {
        code: "invalid-yaml",
        source,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function strictContext(paths, target) {
  const nativePath = path.join(target, ".devhub/project.yaml");
  const nativeContents = await optionalRead(nativePath);
  if (nativeContents === null) {
    return {
      nativePath,
      nativeContents: null,
      nativeManifest: null,
      catalogContents: null,
      catalogManifest: null,
      catalogPath: null,
      error: {
        code: "native-manifest-missing",
        source: nativePath,
        message: "The project does not contain .devhub/project.yaml.",
      },
    };
  }

  const parsedNative = parseManifest(nativeContents, nativePath);
  if (parsedNative.error) {
    return {
      nativePath,
      nativeContents,
      nativeManifest: null,
      catalogContents: null,
      catalogManifest: null,
      catalogPath: null,
      error: parsedNative.error,
    };
  }

  const manifestId = parsedNative.manifest?.id;
  if (typeof manifestId !== "string" || !stableIdPattern.test(manifestId)) {
    return {
      nativePath,
      nativeContents,
      nativeManifest: parsedNative.manifest,
      catalogContents: null,
      catalogManifest: null,
      catalogPath: null,
      error: {
        code: "invalid-native-id",
        source: nativePath,
        message: "The native manifest id must use stable lowercase kebab-case.",
      },
    };
  }
  const catalogPath = path.join(paths.projectDirectory, `${manifestId}.yaml`);
  const catalogContents = catalogPath ? await optionalRead(catalogPath) : null;
  const parsedCatalog = catalogContents === null
    ? { manifest: null, error: null }
    : parseManifest(catalogContents, catalogPath);

  return {
    nativePath,
    nativeContents,
    nativeManifest: parsedNative.manifest,
    catalogPath,
    catalogContents,
    catalogManifest: parsedCatalog.manifest,
    error: parsedCatalog.error,
  };
}

function evidenceProposal(base) {
  return {
    status: "review-required",
    registration: base.match?.project.registration ?? null,
    evidence: {
      repository: base.repository?.repository ?? null,
      nativeManifest: base.evidence.nativeManifest,
      package: base.evidence.package,
      composeFiles: base.evidence.composeFiles,
    },
    omittedUnverifiedFields: ["id", "hosts", "service URLs", "commands"],
    note: "This proposal contains observations only. Review ownership and supply all unverified fields manually.",
  };
}

function fallbackBase(target, runtimeHostId) {
  const resolvedTarget = path.resolve(target);
  return {
    target: resolvedTarget,
    runtimeHostId,
    repository: { remote: null, repository: null },
    evidence: {
      nativeManifest: null,
      package: null,
      composeFiles: [],
    },
    registration: {
      recommendation: "review-required",
      reason: "The reviewed catalog could not be read safely.",
    },
    match: null,
    ambiguity: null,
    drift: "invalid-catalog",
    findings: [],
    nextSteps: [],
  };
}

function reviewPlan(base, context, action, reason) {
  return {
    ...base,
    version: 2,
    command: "reconcile",
    readOnly: true,
    status: "review-required",
    exitCode: RECONCILIATION_EXIT.drift,
    diff: [],
    reviewRequired: true,
    plan: {
      action,
      source: context.nativePath,
      destination: context.catalogPath,
      applicable: false,
      reason,
      preconditions: [
        "A human confirms the native or overlay ownership boundary.",
        "Only reviewed evidence is added; hosts, URLs and commands are never invented.",
        "Shared and external repositories remain unchanged.",
      ],
    },
    error: null,
    proposal: evidenceProposal(base),
  };
}

function invalidPlan(base, context, error) {
  return {
    ...base,
    version: 2,
    command: "reconcile",
    readOnly: true,
    status: "invalid",
    exitCode: RECONCILIATION_EXIT.invalid,
    diff: [],
    reviewRequired: true,
    plan: {
      action: base.match?.project.registration === "overlay" ? "review-overlay" : "review-registration",
      source: context.nativePath,
      destination: context.catalogPath,
      applicable: false,
      reason: error.message,
      preconditions: [
        "A valid project-owned native manifest exists.",
        "Its stable id matches an existing native catalog record.",
        "A human reviews the semantic diff before explicit apply.",
      ],
    },
    error,
    proposal: evidenceProposal(base),
  };
}

export async function createReconciliationPlan(root, target, runtimeHostId, { paths = resolveDevHubPaths(root) } = {}) {
  const resolvedRoot = paths.root;
  const resolvedTarget = path.resolve(target);
  let base;
  try {
    base = await reconcileProject(resolvedRoot, resolvedTarget, runtimeHostId, { paths });
  } catch (error) {
    const catalogError = error instanceof CatalogSourceError
      ? { code: error.code, source: error.source, message: error.message }
      : {
        code: "catalog-read-failed",
        source: paths.catalogDirectory,
        message: error instanceof Error ? error.message : String(error),
      };
    return invalidPlan(fallbackBase(resolvedTarget, runtimeHostId), {
      nativePath: path.join(resolvedTarget, ".devhub/project.yaml"),
      catalogPath: null,
    }, catalogError);
  }

  if (base.ambiguity) {
    return invalidPlan(base, {
      nativePath: path.join(resolvedTarget, ".devhub/project.yaml"),
      catalogPath: null,
    }, {
      code: base.ambiguity.code,
      source: paths.projectDirectory,
      message: base.ambiguity.message,
      candidates: base.ambiguity.candidates,
    });
  }

  const nativePath = path.join(resolvedTarget, ".devhub/project.yaml");
  const nativeContents = await optionalRead(nativePath);
  if (nativeContents === null && base.match?.project.registration === "overlay") {
    return reviewPlan(base, { nativePath, catalogPath: base.match.source }, "review-overlay",
      `The reviewed overlay ${base.match.project.id} remains the only source of truth; the external project is intentionally unchanged.`);
  }
  if (nativeContents === null && !base.match) {
    return reviewPlan(base, { nativePath, catalogPath: null }, "review-registration",
      "No reviewed record or project-owned manifest exists. Review ownership before creating a native record or overlay.");
  }
  const context = await strictContext(paths, resolvedTarget);

  if (context.error) return invalidPlan(base, context, context.error);

  const hostsPath = paths.hostsPath;
  let hostIds;
  try {
    const hostsDocument = parse(await readFile(hostsPath, "utf8"));
    ({ hostIds } = validateHostsDocument(hostsDocument, hostsPath));
  } catch (error) {
    return invalidPlan(base, context, {
      code: "invalid-hosts-catalog",
      source: hostsPath,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    validateProjectDocument(context.nativeManifest, {
      source: context.nativePath,
      hostIds,
      expectedId: context.nativeManifest?.id,
    });
  } catch (error) {
    return invalidPlan(base, context, {
      code: "invalid-native-manifest",
      source: context.nativePath,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  if (context.catalogContents === null) {
    return reviewPlan(base, context, "review-registration",
      `The valid project-owned manifest ${context.nativeManifest.id} is not registered yet; review it before first registration.`);
  }

  if (!context.catalogManifest) {
    return invalidPlan(base, context, context.error ?? {
      code: "invalid-catalog-manifest",
      source: context.catalogPath,
      message: "The reviewed catalog record is invalid.",
    });
  }

  try {
    validateProjectDocument(context.catalogManifest, {
      source: context.catalogPath,
      hostIds,
      expectedId: context.nativeManifest.id,
    });
  } catch (error) {
    return invalidPlan(base, context, {
      code: "invalid-catalog-manifest",
      source: context.catalogPath,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  if (context.nativeManifest.id !== context.catalogManifest.id) {
    return invalidPlan(base, context, {
      code: "stable-id-mismatch",
      source: context.nativePath,
      message: "The native manifest id does not match the reviewed catalog id.",
    });
  }

  if (context.nativeManifest.registration !== "native" || context.catalogManifest.registration !== "native") {
    return invalidPlan(base, context, {
      code: "registration-boundary",
      source: context.nativePath,
      message: "Reconciliation apply is allowed only when both records declare registration: native.",
    });
  }

  const changes = semanticDiff(context.catalogManifest, context.nativeManifest);
  const clean = changes.length === 0;
  return {
    ...base,
    version: 2,
    command: "reconcile",
    readOnly: true,
    status: clean ? "clean" : "drift",
    exitCode: clean ? RECONCILIATION_EXIT.clean : RECONCILIATION_EXIT.drift,
    diff: changes,
    reviewRequired: !clean,
    plan: {
      action: clean ? "none" : "update-catalog-from-native",
      source: context.nativePath,
      destination: context.catalogPath,
      applicable: !clean,
      reason: clean
        ? "The native manifest and reviewed catalog record are semantically equal."
        : `${changes.length} semantic field change${changes.length === 1 ? "" : "s"} require review.`,
      preconditions: [
        "The stable project id matches the existing catalog filename and manifest id.",
        "Both manifests declare registration: native.",
        "The native manifest passes strict schema validation against reviewed hosts.",
        "A human reviews this semantic diff and invokes reconcile --apply explicitly.",
      ],
    },
    error: null,
    proposal: null,
  };
}

async function atomicWrite(filename, contents) {
  const temporary = `${filename}.devhub-${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, "utf8");
    await rename(temporary, filename);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function restoreSnapshot(snapshot, expectedCurrent) {
  const current = await optionalRead(snapshot.filename);
  if (current !== expectedCurrent) {
    throw new ReconciliationApplyError(
      "rollback-conflict",
      `${snapshot.filename} changed outside the active DevHub transaction; it was not overwritten during rollback`,
    );
  }
  if (snapshot.contents === null) {
    await unlink(snapshot.filename).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  } else {
    await atomicWrite(snapshot.filename, snapshot.contents);
  }
}

export async function withCatalogMutationLock(paths, operation) {
  const lockPath = path.join(paths.catalogDirectory, ".devhub-mutation.lock");
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() })}\n`);
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
      await unlink(lockPath).catch(() => {});
    }
    if (error?.code === "EEXIST") {
      throw new ReconciliationApplyError(
        "catalog-locked",
        `Another DevHub catalog mutation is active (${lockPath}). If no process owns it, remove the stale lock after review`,
      );
    }
    throw error;
  }

  try {
    return await operation();
  } finally {
    await handle.close().catch(() => {});
    await unlink(lockPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

function resolvedOutputs(root, outputFiles) {
  return [...new Set(outputFiles.map((filename) => path.isAbsolute(filename) ? filename : path.resolve(root, filename)))];
}

async function snapshotFiles(filenames) {
  return Promise.all(filenames.map(async (filename) => ({ filename, contents: await optionalRead(filename) })));
}

async function requireUnchanged(filename, expected, code) {
  if (await optionalRead(filename) !== expected) {
    throw new ReconciliationApplyError(code, `${filename} changed after the reviewed plan was created`);
  }
}

async function rollbackTransaction(snapshots, expectedCurrentByFile) {
  const rollbackErrors = [];
  for (const snapshot of [...snapshots].reverse()) {
    try {
      await restoreSnapshot(snapshot, expectedCurrentByFile.get(snapshot.filename));
    } catch (error) {
      rollbackErrors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return rollbackErrors;
}

async function captureTransactionOutputs(snapshots, expectedCurrentByFile) {
  for (const snapshot of snapshots) {
    if (!expectedCurrentByFile.has(snapshot.filename)) {
      expectedCurrentByFile.set(snapshot.filename, await optionalRead(snapshot.filename));
    }
  }
}

function transactionFailure(code, error, rollbackErrors) {
  const conflict = rollbackErrors.length > 0;
  const suffix = conflict
    ? ` Rollback conflicts: ${rollbackErrors.join("; ")}`
    : " Changes were rolled back.";
  return new ReconciliationApplyError(
    conflict ? "rollback-conflict" : error instanceof ReconciliationApplyError ? error.code : code,
    `${error instanceof Error ? error.message : String(error)}.${suffix}`,
  );
}

export async function registerNativeManifest({
  root,
  target,
  runCompiler,
  outputFiles,
  paths = resolveDevHubPaths(root),
}) {
  if (typeof runCompiler !== "function") throw new TypeError("registerNativeManifest requires a runCompiler function");
  const resolvedRoot = paths.root;
  const outputs = resolvedOutputs(resolvedRoot, outputFiles ?? paths.generatedOutputs);

  return withCatalogMutationLock(paths, async () => {
    const source = path.join(path.resolve(target), ".devhub/project.yaml");
    const sourceContents = await readFile(source, "utf8");
    const parsedSource = parseManifest(sourceContents, source);
    if (parsedSource.error) throw new ReconciliationApplyError(parsedSource.error.code, parsedSource.error.message);

    let hostIds;
    try {
      const hostsDocument = parse(await readFile(paths.hostsPath, "utf8"));
      ({ hostIds } = validateHostsDocument(hostsDocument, paths.hostsPath));
      validateProjectDocument(parsedSource.manifest, {
        source,
        hostIds,
        expectedId: parsedSource.manifest?.id,
      });
    } catch (error) {
      throw new ReconciliationApplyError("invalid-native-manifest", error instanceof Error ? error.message : String(error));
    }
    if (parsedSource.manifest.registration !== "native") {
      throw new ReconciliationApplyError(
        "registration-boundary",
        "register accepts only a project-owned manifest declaring registration: native; create overlays inside DevHub",
      );
    }

    const destination = path.join(paths.projectDirectory, `${parsedSource.manifest.id}.yaml`);
    if (await optionalRead(destination) !== null) {
      throw new ReconciliationApplyError(
        "already-registered",
        `${parsedSource.manifest.id} already has a reviewed catalog record; use diff/reconcile instead of overwriting it`,
      );
    }

    const normalizedSource = sourceContents.endsWith("\n") ? sourceContents : `${sourceContents}\n`;
    const outputSnapshots = await snapshotFiles(outputs);
    const snapshots = [{ filename: destination, contents: null }, ...outputSnapshots];
    const expectedCurrent = new Map([[destination, null]]);
    try {
      await requireUnchanged(source, sourceContents, "native-source-changed");
      await requireUnchanged(destination, null, "catalog-destination-changed");
      await atomicWrite(destination, normalizedSource);
      expectedCurrent.set(destination, normalizedSource);
      await runCompiler();
      await captureTransactionOutputs(outputSnapshots, expectedCurrent);
      const verification = await createReconciliationPlan(resolvedRoot, target, null, { paths });
      if (verification.status !== "clean") throw new Error(`post-register verification returned ${verification.status}`);
      return { id: parsedSource.manifest.id, source, destination, refreshed: outputs };
    } catch (error) {
      await captureTransactionOutputs(outputSnapshots, expectedCurrent);
      const rollbackErrors = await rollbackTransaction(snapshots, expectedCurrent);
      throw transactionFailure("register-failed", error, rollbackErrors);
    }
  });
}

export async function applyNativeReconciliation({
  root,
  target,
  runtimeHostId,
  runCompiler,
  outputFiles,
  paths = resolveDevHubPaths(root),
}) {
  if (typeof runCompiler !== "function") {
    throw new TypeError("applyNativeReconciliation requires a runCompiler function");
  }

  const resolvedRoot = paths.root;
  const outputs = resolvedOutputs(resolvedRoot, outputFiles ?? paths.generatedOutputs);

  return withCatalogMutationLock(paths, async () => {
    const plan = await createReconciliationPlan(resolvedRoot, target, runtimeHostId, { paths });
    if (plan.status === "clean") {
      return {
        ...plan,
        readOnly: false,
        reviewRequired: false,
        application: { applied: false, reason: "already-in-sync", rolledBack: false },
      };
    }
    if (plan.status !== "drift" || !plan.plan.applicable) {
      throw new ReconciliationApplyError(plan.error?.code ?? "not-applicable", plan.plan.reason);
    }

    const sourceContents = await readFile(plan.plan.source, "utf8");
    const normalizedSource = sourceContents.endsWith("\n") ? sourceContents : `${sourceContents}\n`;
    const destinationSnapshot = { filename: plan.plan.destination, contents: await optionalRead(plan.plan.destination) };
    const outputSnapshots = await snapshotFiles(outputs);
    const snapshots = [destinationSnapshot, ...outputSnapshots];
    const expectedCurrent = new Map([[plan.plan.destination, destinationSnapshot.contents]]);

    try {
      await requireUnchanged(plan.plan.source, sourceContents, "native-source-changed");
      await requireUnchanged(plan.plan.destination, destinationSnapshot.contents, "catalog-destination-changed");
      await atomicWrite(plan.plan.destination, normalizedSource);
      expectedCurrent.set(plan.plan.destination, normalizedSource);
      await runCompiler();
      await captureTransactionOutputs(outputSnapshots, expectedCurrent);
      const verification = await createReconciliationPlan(resolvedRoot, target, runtimeHostId, { paths });
      if (verification.status !== "clean") {
        throw new Error(`post-apply verification returned ${verification.status}`);
      }
      return {
        ...verification,
        readOnly: false,
        reviewRequired: false,
        appliedDiff: plan.diff,
        application: {
          applied: true,
          reason: "explicit-apply",
          rolledBack: false,
          refreshed: outputs.map((filename) => path.relative(resolvedRoot, filename)),
        },
      };
    } catch (error) {
      await captureTransactionOutputs(outputSnapshots, expectedCurrent);
      const rollbackErrors = await rollbackTransaction(snapshots, expectedCurrent);
      throw transactionFailure("apply-failed", error, rollbackErrors);
    }
  });
}
