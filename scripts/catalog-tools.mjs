import { access, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { parse } from "yaml";
import { validateHostsDocument, validateProjectDocument } from "./catalog-validation.mjs";
import { resolveDevHubPaths } from "./devhub-config.mjs";

const execFileAsync = promisify(execFile);

async function optionalRead(filename) {
  try {
    return await readFile(filename, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function exists(filename) {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObject(value[key])]));
}

export function semanticEqual(left, right) {
  return JSON.stringify(sortObject(left)) === JSON.stringify(sortObject(right));
}

export class CatalogSourceError extends Error {
  constructor(code, source, message) {
    super(`${source}: ${message}`);
    this.name = "CatalogSourceError";
    this.code = code;
    this.source = source;
  }
}

function parseCatalogYaml(contents, source, code) {
  try {
    return parse(contents);
  } catch (error) {
    throw new CatalogSourceError(code, source, error instanceof Error ? error.message : String(error));
  }
}

export async function readSourceCatalog(root, { paths = resolveDevHubPaths(root) } = {}) {
  const hostsPath = paths.hostsPath;
  let hostsDocument;
  try {
    hostsDocument = parseCatalogYaml(await readFile(hostsPath, "utf8"), hostsPath, "invalid-hosts-yaml");
  } catch (error) {
    if (error?.code === "ENOENT") throw new CatalogSourceError("hosts-missing", hostsPath, "is missing");
    throw error;
  }
  let hostIds;
  try {
    ({ hostIds } = validateHostsDocument(hostsDocument, hostsPath));
  } catch (error) {
    throw new CatalogSourceError("invalid-hosts-catalog", hostsPath, error instanceof Error ? error.message : String(error));
  }
  const hosts = hostsDocument.hosts;
  const projectDirectory = paths.projectDirectory;
  let files;
  try {
    files = (await readdir(projectDirectory)).filter((file) => file.endsWith(".yaml")).sort();
  } catch (error) {
    if (error?.code === "ENOENT") throw new CatalogSourceError("projects-missing", projectDirectory, "is missing");
    throw error;
  }
  const projects = [];
  const projectIds = new Set();

  for (const file of files) {
    const source = path.join(projectDirectory, file);
    const manifest = parseCatalogYaml(await readFile(source, "utf8"), source, "invalid-project-yaml");
    try {
      validateProjectDocument(manifest, { source, hostIds, expectedId: file.replace(/\.yaml$/, "") });
    } catch (error) {
      throw new CatalogSourceError("invalid-project-catalog", source, error instanceof Error ? error.message : String(error));
    }
    if (projectIds.has(manifest.id)) throw new CatalogSourceError("duplicate-project-id", source, `duplicates project ${manifest.id}`);
    projectIds.add(manifest.id);
    projects.push({ file, source, manifest });
  }

  return { hosts, hostIds, projects };
}

export function collectDoctorFindings({ hosts, projects }, runtimeHostId) {
  const findings = [];
  const hostIds = new Set(hosts.map((host) => host.id));
  const now = Date.now();
  const reportedFreshnessMs = 7 * 24 * 60 * 60 * 1000;

  if (runtimeHostId && !hostIds.has(runtimeHostId)) {
    findings.push({
      severity: "error",
      code: "unknown-runtime-host",
      message: `DEVHUB_HOST_ID references unknown host ${runtimeHostId}.`,
      subject: runtimeHostId,
    });
  }

  for (const { manifest: project } of projects) {
    for (const service of project.services ?? []) {
      const subject = `${project.id}/${service.id}`;
      if (service.mode === "always-on" && !service.probe && !service.commands?.restart && !service.commands?.start && !service.commands?.logs) {
        findings.push({
          severity: "warning",
          code: "always-on-without-evidence-or-recovery",
          message: "Always-on service has neither a live probe nor recovery guidance.",
          subject,
        });
      } else if (service.mode === "always-on" && !service.probe) {
        findings.push({
          severity: "warning",
          code: "always-on-without-probe",
          message: "Always-on service relies on a reported or catalog-only state.",
          subject,
        });
      }

      if (service.mode === "on-demand" && !service.commands?.start) {
        findings.push({
          severity: "warning",
          code: "on-demand-without-start",
          message: "On-demand service has no reviewed start command.",
          subject,
        });
      }

      if (service.reported && ["up", "down", "degraded"].includes(service.reported.state) && !service.reported.observedAt) {
        findings.push({
          severity: "warning",
          code: "reported-state-without-date",
          message: `Reported ${service.reported.state} state has no observation date.`,
          subject,
        });
      } else if (service.reported?.observedAt && ["up", "down", "degraded"].includes(service.reported.state)) {
        const observedAt = Date.parse(service.reported.observedAt);
        if (Number.isFinite(observedAt) && now - observedAt > reportedFreshnessMs) {
          findings.push({
            severity: "warning",
            code: "reported-state-stale",
            message: `Reported ${service.reported.state} state is more than seven days old.`,
            subject,
            observedAt: service.reported.observedAt,
          });
        }
      }
    }
  }

  return findings;
}

function normalizeRepository(value) {
  if (!value) return null;
  const trimmed = value.trim().replace(/\.git$/, "");
  const ssh = trimmed.match(/^git@github\.com:(.+\/.+)$/);
  if (ssh) return ssh[1];
  try {
    const url = new URL(trimmed);
    if (url.hostname === "github.com") return url.pathname.replace(/^\//, "");
  } catch {
    // Non-GitHub remotes remain useful as raw evidence but cannot match repository fields.
  }
  return null;
}

async function inspectGitRepository(target) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", target, "config", "--get", "remote.origin.url"]);
    const remote = stdout.trim();
    return { remote, repository: normalizeRepository(remote) };
  } catch {
    return { remote: null, repository: null };
  }
}

async function inspectPackage(target) {
  const packagePath = path.join(target, "package.json");
  const contents = await optionalRead(packagePath);
  if (!contents) return null;
  try {
    const packageDocument = JSON.parse(contents);
    return {
      name: packageDocument.name ?? null,
      scripts: Object.keys(packageDocument.scripts ?? {}).sort(),
    };
  } catch {
    return { invalid: true, scripts: [] };
  }
}

async function findComposeFiles(target) {
  const candidates = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
  const results = [];
  for (const candidate of candidates) {
    if (await exists(path.join(target, candidate))) results.push(candidate);
  }
  return results;
}

function projectSummary(project) {
  return {
    id: project.id,
    title: project.title,
    registration: project.registration,
    repository: project.repository ?? null,
    workspaces: project.workspaces ?? [],
    services: (project.services ?? []).map((service) => ({
      id: service.id,
      name: service.name,
      host: service.host,
      runtime: service.runtime,
      mode: service.mode,
      url: service.url ?? null,
    })),
  };
}

async function canonicalPath(filename) {
  try {
    return await realpath(filename);
  } catch {
    return path.resolve(filename);
  }
}

function matchSummary(candidate, matchType) {
  return { source: candidate.source, matchType, project: projectSummary(candidate.manifest) };
}

export async function reconcileProject(root, target, runtimeHostId, { paths = resolveDevHubPaths(root) } = {}) {
  const resolvedTarget = path.resolve(target);
  const canonicalTarget = await canonicalPath(resolvedTarget);
  const sourceCatalog = await readSourceCatalog(root, { paths });
  const git = await inspectGitRepository(resolvedTarget);
  const packageEvidence = await inspectPackage(resolvedTarget);
  const composeFiles = await findComposeFiles(resolvedTarget);
  const nativePath = path.join(resolvedTarget, ".devhub/project.yaml");
  const nativeContents = await optionalRead(nativePath);
  let nativeManifest = null;
  let nativeError = null;

  if (nativeContents) {
    try {
      nativeManifest = parse(nativeContents);
    } catch (error) {
      nativeError = error instanceof Error ? error.message : String(error);
    }
  }

  const workspaceCandidates = sourceCatalog.projects.filter(({ manifest }) =>
    (manifest.workspaces ?? []).some((workspace) => {
      const candidatePath = path.resolve(workspace.path);
      return candidatePath === resolvedTarget || candidatePath === canonicalTarget;
    }));
  const matchTiers = [
    {
      type: "native-id",
      candidates: sourceCatalog.projects.filter(({ manifest }) => nativeManifest?.id && manifest.id === nativeManifest.id),
    },
    {
      type: "repository",
      candidates: sourceCatalog.projects.filter(({ manifest }) =>
        git.repository && manifest.repository?.toLowerCase() === git.repository.toLowerCase()),
    },
    {
      type: "workspace",
      candidates: workspaceCandidates,
    },
  ];
  const selectedTier = matchTiers.find((tier) => tier.candidates.length > 0) ?? null;
  const ambiguity = selectedTier && selectedTier.candidates.length > 1
    ? {
      code: "ambiguous-catalog-match",
      matchType: selectedTier.type,
      message: `Multiple reviewed records match by ${selectedTier.type}: ${selectedTier.candidates.map(({ manifest }) => manifest.id).join(", ")}.`,
      candidates: selectedTier.candidates.map((candidate) => matchSummary(candidate, selectedTier.type)),
    }
    : null;
  const match = ambiguity ? null : selectedTier?.candidates[0] ?? null;
  const matchType = match ? selectedTier.type : null;

  let drift = "not-applicable";
  if (nativeManifest && match) drift = semanticEqual(nativeManifest, match.manifest) ? "in-sync" : "drift";
  else if (nativeContents && nativeError) drift = "invalid-native-manifest";
  else if (nativeManifest && !match) drift = "native-not-registered";

  const recommendation = ambiguity ? "review-required" : match?.manifest.registration
    ?? (nativeManifest ? "native" : "review-required");
  const reason = ambiguity
    ? ambiguity.message
    : match
      ? `Matched the reviewed ${match.manifest.registration} record ${match.manifest.id} by ${matchType}.`
    : nativeManifest
      ? "A project-owned .devhub/project.yaml already exists."
      : "Ownership cannot be inferred safely. Use native only for repositories we control; otherwise create an overlay.";

  const allFindings = collectDoctorFindings(sourceCatalog, runtimeHostId);
  const relevantPrefix = match ? `${match.manifest.id}/` : null;
  const findings = allFindings.filter((finding) => !finding.subject || finding.subject === runtimeHostId || finding.subject.startsWith(relevantPrefix ?? "\0"));

  const nextSteps = [];
  if (ambiguity) nextSteps.push("Resolve the ambiguous catalog identity before proposing or applying any change.");
  else if (nativeError) nextSteps.push(`Fix invalid YAML in ${nativePath}.`);
  else if (drift === "drift") nextSteps.push(`Review the difference between ${nativePath} and ${match.source}; do not overwrite either copy blindly.`);
  else if (drift === "native-not-registered") nextSteps.push(`Review and register it with: npm --prefix ${JSON.stringify(root)} run devhub -- register ${JSON.stringify(resolvedTarget)}`);
  else if (!match) nextSteps.push("Inspect the repository and choose the native or overlay ownership boundary before creating a reviewed proposal.");
  else nextSteps.push(`Update the existing ${match.manifest.registration} record ${match.source} instead of creating a duplicate.`);
  nextSteps.push(`Validate generated output with: npm --prefix ${JSON.stringify(root)} run devhub -- validate --check`);

  return {
    version: 1,
    command: "reconcile",
    readOnly: true,
    target: resolvedTarget,
    runtimeHostId,
    repository: git,
    evidence: {
      nativeManifest: nativeContents ? { path: nativePath, id: nativeManifest?.id ?? null, error: nativeError } : null,
      package: packageEvidence,
      composeFiles,
    },
    registration: { recommendation, reason },
    match: match ? matchSummary(match, matchType) : null,
    ambiguity,
    drift,
    findings,
    nextSteps,
  };
}
