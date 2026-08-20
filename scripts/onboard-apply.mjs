import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";

import packageDocument from "../package.json" with { type: "json" };
import { validateOnboardPlanDocument } from "../lib/onboard.mjs";
import { collectDoctorFindings, readSourceCatalog } from "./catalog-tools.mjs";
import { inspectCatalogRevision } from "./catalog-revision.mjs";
import { validateHostsDocument, validateProjectDocument } from "./catalog-validation.mjs";
import { resolveDevHubPaths } from "./devhub-config.mjs";
import { initializeCatalog, inspectCatalogDestination } from "./catalog-init.mjs";
import { ReconciliationApplyError, withCatalogMutationLock } from "./reconciliation.mjs";

const execFileAsync = promisify(execFile);
const maximumPlanBytes = 1024 * 1024;
const stableIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class OnboardApplyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OnboardApplyError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new OnboardApplyError(code, message);
}

function option(argument) {
  const separator = argument.indexOf("=");
  return separator === -1 ? { name: argument, value: null } : { name: argument.slice(0, separator), value: argument.slice(separator + 1) };
}

export function parseOnboardApplyArguments(args) {
  if (!Array.isArray(args)) fail("onboard-apply-arguments-invalid", "onboard-apply arguments must be an array");
  const positionals = [];
  let apply = false;
  let json = false;
  for (const argument of args) {
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const parsed = option(argument);
    if (parsed.value !== null || !new Set(["--apply", "--json"]).has(parsed.name)) {
      fail("onboard-apply-arguments-invalid", `onboard-apply does not support ${argument}`);
    }
    if (parsed.name === "--apply") {
      if (apply) fail("onboard-apply-arguments-invalid", "--apply may be supplied once");
      apply = true;
    } else {
      if (json) fail("onboard-apply-arguments-invalid", "--json may be supplied once");
      json = true;
    }
  }
  if (positionals.length !== 1 || !path.isAbsolute(positionals[0])) {
    fail("onboard-apply-arguments-invalid", "onboard-apply requires one absolute approved plan JSON path");
  }
  return Object.freeze({ planPath: path.normalize(positionals[0]), apply, json });
}

async function readPlan(filename) {
  let details;
  try {
    details = await stat(filename);
  } catch (error) {
    if (error?.code === "ENOENT") fail("onboard-plan-missing", "approved onboarding plan file is missing");
    throw error;
  }
  if (!details.isFile() || details.size > maximumPlanBytes) fail("onboard-plan-invalid", `approved onboarding plan must be a JSON file no larger than ${maximumPlanBytes} bytes`);
  try {
    return validateOnboardPlanDocument(JSON.parse(await readFile(filename, "utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) fail("onboard-plan-invalid", "approved onboarding plan must contain valid JSON");
    throw error;
  }
}

async function runGit(cwd, args, options = {}) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
  return stdout.trim();
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function sameBinding(expected, actual) {
  return JSON.stringify(canonical(expected)) === JSON.stringify(canonical(actual));
}

async function repositoryStatus(repositoryRoot) {
  const output = await runGit(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]);
  return output ? output.split("\0").filter(Boolean) : [];
}

function cleanExceptLock(records, lockRelativePath = null) {
  return records.filter((record) => {
    if (!lockRelativePath) return true;
    return !(record.startsWith("?? ") && record.slice(3) === lockRelativePath);
  });
}

function checkEvidenceFreshness(plan, now) {
  const stale = [];
  for (const operation of plan.application.operations) {
    if (operation.kind !== "create-overlay-project") continue;
    const validUntil = Date.parse(operation.evidence?.validUntil);
    if (operation.evidence?.freshness !== "fresh" || !Number.isFinite(validUntil) || validUntil <= now.getTime()) stale.push(operation.candidateId);
  }
  return stale;
}

function proposalBranch(planId) {
  return `codex/onboard-${planId.slice("sha256:".length, "sha256:".length + 16)}`;
}

function catalogRepositoryPath(catalogPath, relative) {
  return catalogPath === "." ? relative : `${catalogPath}/${relative}`;
}

function plannedRepositoryPaths(plan) {
  if (plan.provenance.catalog.binding.state !== "bound") return [];
  const catalogPath = plan.provenance.catalog.binding.catalogPath;
  const paths = [];
  for (const operation of plan.application.operations) {
    if (operation.kind === "create-starter-catalog") paths.push(catalogRepositoryPath(catalogPath, "hosts.yaml"));
    if (operation.kind === "create-overlay-project") paths.push(catalogRepositoryPath(catalogPath, `projects/${operation.projectId}.yaml`));
    if (operation.kind === "refresh-generated-catalog" && operation.generated.mode === "repository") paths.push(...operation.generated.paths);
  }
  return [...new Set(paths)].sort();
}

async function existingProposal(repositoryRoot, branch, plan, expectedPaths) {
  let commit;
  try {
    commit = await runGit(repositoryRoot, ["show-ref", "--verify", "--hash", `refs/heads/${branch}`]);
  } catch {
    return null;
  }
  const [parents, body, changed] = await Promise.all([
    runGit(repositoryRoot, ["show", "-s", "--format=%P", commit]),
    runGit(repositoryRoot, ["show", "-s", "--format=%B", commit]),
    runGit(repositoryRoot, ["diff", "--name-only", "--format=", `${plan.provenance.catalog.binding.baseRevision}..${commit}`]),
  ]);
  const changedPaths = changed ? changed.split("\n").filter(Boolean).sort() : [];
  const trailersMatch = body.includes(`DevHub-Onboard-Plan: ${plan.planId}`)
    && body.includes(`DevHub-Catalog-Fingerprint: ${plan.provenance.catalog.binding.catalogFingerprint}`);
  if (parents !== plan.provenance.catalog.binding.baseRevision || !trailersMatch || JSON.stringify(changedPaths) !== JSON.stringify(expectedPaths)) {
    fail("onboard-proposal-branch-conflict", `proposal branch ${branch} already exists but does not match the exact approved plan`);
  }
  for (const operation of plan.application.operations) {
    if (operation.kind === "create-overlay-project") {
      const contents = await runGit(repositoryRoot, ["show", `${commit}:${catalogRepositoryPath(plan.provenance.catalog.binding.catalogPath, `projects/${operation.projectId}.yaml`)}`]);
      if (`${contents}\n` !== operation.yaml && contents !== operation.yaml) fail("onboard-proposal-branch-conflict", `proposal branch ${branch} contains different YAML for ${operation.projectId}`);
    }
    if (operation.kind === "create-starter-catalog") {
      const contents = await runGit(repositoryRoot, ["show", `${commit}:${catalogRepositoryPath(plan.provenance.catalog.binding.catalogPath, "hosts.yaml")}`]);
      const expected = stringify({ version: 1, hosts: [operation.host] });
      if (`${contents}\n` !== expected && contents !== expected) fail("onboard-proposal-branch-conflict", `proposal branch ${branch} contains a different starter catalog`);
    }
  }
  return Object.freeze({ branch, commit });
}

async function createLockDirectories(catalogDirectory) {
  const created = [];
  let current = path.resolve(catalogDirectory);
  const missing = [];
  while (true) {
    try {
      const details = await stat(current);
      if (!details.isDirectory()) fail("catalog-path-invalid", "catalog path must be a directory");
      break;
    } catch (error) {
      if (error instanceof OnboardApplyError) throw error;
      if (error?.code !== "ENOENT") throw error;
      missing.push(current);
      const parent = path.dirname(current);
      if (parent === current) fail("catalog-path-invalid", "catalog directory has no existing parent");
      current = parent;
    }
  }
  try {
    for (const directory of missing.reverse()) {
      await mkdir(directory);
      created.push(directory);
    }
  } catch (error) {
    await removeLockDirectories(created);
    if (error?.code === "EEXIST") fail("catalog-locked", "another catalog transaction created the planned catalog destination first");
    throw error;
  }
  return created;
}

async function removeLockDirectories(created) {
  const errors = [];
  for (const directory of [...created].reverse()) {
    try {
      await rmdir(directory);
    } catch (error) {
      if (error?.code !== "ENOENT") errors.push(`${directory}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (errors.length) fail("onboard-cleanup-conflict", `temporary catalog lock directories could not be removed: ${errors.join("; ")}`);
}

function transactionPaths(worktreeRoot, generatedTemporary, binding) {
  const catalogDirectory = path.join(worktreeRoot, binding.catalogPath);
  let generatedDirectory = null;
  if (binding.generated.mode === "ephemeral") generatedDirectory = generatedTemporary;
  else if (binding.generated.configuredDirectory) generatedDirectory = path.join(worktreeRoot, binding.generated.configuredDirectory);
  const connectionProfilesFile = binding.connectionProfiles.mode === "repository"
    ? path.join(worktreeRoot, binding.connectionProfiles.path)
    : path.join(generatedTemporary, "no-connection-profiles.json");
  return resolveDevHubPaths(worktreeRoot, {}, {
    pathOptions: {
      catalogDirectory,
      connectionProfilesFile,
      ...(generatedDirectory ? { generatedDirectory } : {}),
    },
  });
}

async function runCompiler(runtimeRoot, worktreeRoot, paths, { check = false, signal } = {}) {
  const environment = { ...process.env };
  environment.DEVHUB_CATALOG_DIR = paths.catalogDirectory;
  environment.DEVHUB_CONNECTION_PROFILES_FILE = paths.connectionProfilesPath;
  if (paths.generatedDirectory) environment.DEVHUB_GENERATED_DIR = paths.generatedDirectory;
  else delete environment.DEVHUB_GENERATED_DIR;
  if (check) environment.DEVHUB_CATALOG_CHECK = "1";
  else delete environment.DEVHUB_CATALOG_CHECK;
  delete environment.DEVHUB_INSTANCE_LABEL;
  delete environment.DEVHUB_INSTANCE_MODE;
  try {
    await execFileAsync(process.execPath, [path.join(runtimeRoot, "scripts/compile-catalog.mjs")], {
      cwd: worktreeRoot,
      env: environment,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) fail("onboard-apply-interrupted", "onboard apply was interrupted; the isolated transaction was removed");
    throw error;
  }
}

async function cleanupTemporaryWorktree(repositoryRoot, temporary, worktreeRoot, worktreeCreated) {
  const errors = [];
  if (worktreeCreated) {
    try {
      await runGit(repositoryRoot, ["worktree", "remove", "--force", "--force", worktreeRoot]);
    } catch {
      try {
        await rm(worktreeRoot, { recursive: true, force: true });
        await runGit(repositoryRoot, ["worktree", "prune", "--expire", "now"]);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  try {
    await rm(temporary, { recursive: true, force: true });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (worktreeCreated) {
    try {
      const registered = await runGit(repositoryRoot, ["worktree", "list", "--porcelain"]);
      if (registered.split("\n").includes(`worktree ${worktreeRoot}`)) errors.push(`temporary worktree is still registered: ${worktreeRoot}`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return errors;
}

async function removeProposalBranch(repositoryRoot, branch) {
  try {
    await runGit(repositoryRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  } catch {
    return null;
  }
  try {
    await runGit(repositoryRoot, ["branch", "-D", branch]);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) fail("onboard-apply-interrupted", "onboard apply was interrupted; the isolated transaction was removed");
}

async function applyCatalogOperations(plan, paths) {
  const starter = plan.application.operations.find((operation) => operation.kind === "create-starter-catalog");
  if (starter) {
    validateHostsDocument({ version: 1, hosts: [starter.host] }, "approved onboard starter host");
    await initializeCatalog({ destination: paths.catalogDirectory, host: starter.host, apply: true });
  } else {
    try {
      const details = await stat(paths.projectDirectory);
      if (!details.isDirectory()) fail("onboard-proposal-conflict", "catalog projects path is not a directory in the exact base revision");
    } catch (error) {
      if (error instanceof OnboardApplyError) throw error;
      if (error?.code !== "ENOENT") throw error;
      await mkdir(paths.projectDirectory);
    }
  }
  const sourceCatalog = await readSourceCatalog(paths.root, { paths });
  for (const operation of plan.application.operations) {
    if (operation.kind !== "create-overlay-project") continue;
    if (!stableIdPattern.test(operation.projectId)) fail("onboard-plan-invalid", `approved project ID is invalid: ${operation.projectId}`);
    let manifest;
    try {
      manifest = parse(operation.yaml);
      validateProjectDocument(manifest, {
        source: `approved onboarding candidate ${operation.candidateId}`,
        hostIds: sourceCatalog.hostIds,
        expectedId: operation.projectId,
      });
    } catch (error) {
      fail("onboard-proposal-invalid", error instanceof Error ? error.message : String(error));
    }
    if (manifest.registration !== "overlay" || (manifest.workspaces?.length ?? 0) > 0) {
      fail("onboard-proposal-boundary", "onboard apply accepts only DevHub-owned overlay proposals without project-workspace edits");
    }
    const destination = path.join(paths.projectDirectory, `${operation.projectId}.yaml`);
    try {
      await writeFile(destination, operation.yaml.endsWith("\n") ? operation.yaml : `${operation.yaml}\n`, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (error?.code === "EEXIST") fail("onboard-proposal-conflict", `catalog project ${operation.projectId} already exists in the exact base revision`);
      throw error;
    }
  }
}

async function verifyAndCommit({ runtimeRoot, worktreeRoot, generatedTemporary, plan, branch, signal, lifecycle }) {
  const binding = plan.provenance.catalog.binding;
  const paths = transactionPaths(worktreeRoot, generatedTemporary, binding);
  throwIfAborted(signal);
  await applyCatalogOperations(plan, paths);
  await lifecycle?.("after-catalog-writes", { worktreeRoot, branch });
  throwIfAborted(signal);
  await runCompiler(runtimeRoot, worktreeRoot, paths, { signal });
  await lifecycle?.("after-generation", { worktreeRoot, branch });
  throwIfAborted(signal);
  const sourceCatalog = await readSourceCatalog(paths.root, { paths });
  const findings = collectDoctorFindings(sourceCatalog, null);
  const doctorErrors = findings.filter((finding) => finding.severity === "error");
  if (doctorErrors.length) fail("onboard-doctor-failed", `DevHub doctor found ${doctorErrors.length} catalog error${doctorErrors.length === 1 ? "" : "s"}`);
  await runCompiler(runtimeRoot, worktreeRoot, paths, { check: true, signal });
  throwIfAborted(signal);

  const expectedPaths = plannedRepositoryPaths(plan);
  const records = await repositoryStatus(worktreeRoot);
  const changedPaths = records.map((record) => record.slice(3));
  const unexpected = changedPaths.filter((filename) => !expectedPaths.includes(filename));
  if (unexpected.length) fail("onboard-transaction-scope-conflict", `isolated verification produced files outside the approved plan: ${unexpected.join(", ")}`);
  if (!changedPaths.length) fail("onboard-transaction-empty", "approved onboarding plan produced no catalog diff");
  await runGit(worktreeRoot, ["diff", "--check", "--", ...expectedPaths]);
  await runGit(worktreeRoot, ["add", "--", ...expectedPaths]);
  await runGit(worktreeRoot, ["diff", "--cached", "--check"]);
  const stagedPathsOutput = await runGit(worktreeRoot, ["diff", "--cached", "--name-only"]);
  const stagedPaths = stagedPathsOutput ? stagedPathsOutput.split("\n").filter(Boolean).sort() : [];
  if (JSON.stringify(stagedPaths) !== JSON.stringify(expectedPaths)) fail("onboard-transaction-scope-conflict", "staged onboarding diff does not match the exact approved paths");
  await lifecycle?.("before-commit", { worktreeRoot, branch });
  throwIfAborted(signal);
  const message = [
    `chore(devhub): apply onboarding plan ${plan.planId.slice(7, 19)}`,
    "",
    `DevHub-Onboard-Plan: ${plan.planId}`,
    `DevHub-Catalog-Fingerprint: ${binding.catalogFingerprint}`,
  ].join("\n");
  await runGit(worktreeRoot, ["-c", "core.hooksPath=/dev/null", "commit", "--no-gpg-sign", "-m", message]);
  throwIfAborted(signal);
  const commit = await runGit(worktreeRoot, ["rev-parse", "HEAD"]);
  const parent = await runGit(worktreeRoot, ["show", "-s", "--format=%P", commit]);
  if (parent !== binding.baseRevision) fail("onboard-commit-verification-failed", "proposal commit is not based on the exact approved revision");
  return Object.freeze({
    branch,
    commit,
    parent,
    files: Object.freeze(expectedPaths),
    doctorFindings: Object.freeze(findings),
  });
}

async function verifyExistingProposal({ runtimeRoot, repositoryRoot, proposal, plan, signal }) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-onboard-verify-"));
  const worktreeRoot = path.join(temporary, "worktree");
  const generatedTemporary = path.join(temporary, "generated");
  let worktreeCreated = false;
  let findings = [];
  let verificationError = null;
  try {
    await mkdir(generatedTemporary);
    await runGit(repositoryRoot, ["worktree", "add", "--detach", worktreeRoot, proposal.commit]);
    worktreeCreated = true;
    const paths = transactionPaths(worktreeRoot, generatedTemporary, plan.provenance.catalog.binding);
    throwIfAborted(signal);
    const sourceCatalog = await readSourceCatalog(paths.root, { paths });
    findings = collectDoctorFindings(sourceCatalog, null);
    const doctorErrors = findings.filter((finding) => finding.severity === "error");
    if (doctorErrors.length) fail("onboard-doctor-failed", `DevHub doctor found ${doctorErrors.length} catalog error${doctorErrors.length === 1 ? "" : "s"} in the existing proposal`);
    if (plan.provenance.catalog.binding.generated.mode === "ephemeral") {
      await runCompiler(runtimeRoot, worktreeRoot, paths, { signal });
    }
    await runCompiler(runtimeRoot, worktreeRoot, paths, { check: true, signal });
    await runGit(worktreeRoot, ["diff", "--check", `${plan.provenance.catalog.binding.baseRevision}..${proposal.commit}`, "--", ...plannedRepositoryPaths(plan)]);
    const records = await repositoryStatus(worktreeRoot);
    if (records.length) fail("onboard-proposal-branch-conflict", `proposal branch ${proposal.branch} is not clean after exact verification`);
  } catch (error) {
    verificationError = error;
  }
  const cleanupErrors = await cleanupTemporaryWorktree(repositoryRoot, temporary, worktreeRoot, worktreeCreated);
  if (cleanupErrors.length) fail("onboard-cleanup-conflict", `existing proposal verification cleanup failed: ${cleanupErrors.join("; ")}`);
  if (verificationError) throw verificationError;
  return Object.freeze(findings);
}

function verificationEvidence(plan, repository, extra = {}) {
  return Object.freeze([
    { id: "plan-integrity", state: "passed", evidence: plan.planId },
    { id: "catalog-repository", state: "passed", evidence: repository.repositoryId },
    { id: "catalog-base-revision", state: "passed", evidence: repository.baseRevision },
    { id: "catalog-fingerprint", state: "passed", evidence: repository.catalogFingerprint },
    ...(extra.committed ? [
      { id: "catalog-source-validation", state: "passed" },
      { id: "catalog-secret-policy", state: "passed" },
      { id: "plan-privacy-boundary", state: "passed" },
      { id: "doctor", state: extra.doctorFindings.length ? "passed-with-findings" : "passed", findings: extra.doctorFindings.length },
      { id: "generated-catalog-refresh", state: "passed" },
      { id: "generated-catalog-freshness", state: "passed" },
      { id: "git-diff-check", state: "passed" },
    ] : []),
  ]);
}

function previewResult(plan, branch, checks, blockers) {
  return Object.freeze({
    version: 1,
    command: "onboard-apply",
    readOnly: true,
    status: blockers.length ? "blocked" : "ready",
    planId: plan.planId,
    proposal: { branch, commit: null, files: plannedRepositoryPaths(plan) },
    blockers: Object.freeze(blockers),
    verification: Object.freeze([
      { id: "plan-integrity", state: "passed", evidence: plan.planId },
      { id: "catalog-revision", state: checks.catalogRevisionMatches ? "passed" : "blocked" },
      { id: "runtime-version", state: checks.runtimeVersionMatches ? "passed" : "blocked" },
      { id: "catalog-base-clean", state: checks.cleanCatalogBase ? "passed" : "blocked" },
      { id: "candidate-evidence-fresh", state: checks.staleCandidateIds.length ? "blocked" : "passed" },
    ]),
    rollback: { required: false, sourceCheckoutChanged: false, temporaryWorktreeCreated: false },
    nextAction: blockers.length ? "Resolve the reported blocker and create a fresh approved plan." : "Review this exact transaction, then repeat with --apply.",
    checks,
  });
}

async function inspectSourceCheckout(paths, plannedBinding, repositoryRoot, catalogRevisionOptions) {
  const catalogState = await inspectCatalogDestination(paths.catalogDirectory);
  const [revision, status] = await Promise.all([
    inspectCatalogRevision(paths, catalogState, catalogRevisionOptions),
    repositoryStatus(repositoryRoot),
  ]);
  return Object.freeze({
    revisionMatches: catalogState === plannedBinding.catalogState && sameBinding(plannedBinding, revision.binding),
    clean: status.length === 0,
  });
}

export async function runOnboardApply(runtimeRoot, args, options = {}) {
  const parsed = parseOnboardApplyArguments(args);
  const plan = await readPlan(parsed.planPath);
  const paths = options.paths ?? resolveDevHubPaths(runtimeRoot, options.environment ?? process.env);
  const now = new Date(options.now ?? Date.now());
  if (!Number.isFinite(now.getTime())) fail("onboard-apply-clock-invalid", "onboard apply requires a valid clock");
  const runtimeVersion = options.runtimeVersion ?? packageDocument.version;
  const plannedBinding = plan.provenance.catalog.binding;
  const actualCatalogState = await inspectCatalogDestination(paths.catalogDirectory);
  const current = await inspectCatalogRevision(paths, actualCatalogState, options.catalogRevision);
  const blockers = [...plan.application.blockers];
  if (actualCatalogState !== plannedBinding.catalogState) blockers.push("catalog-revision-drift");
  if (!sameBinding(plannedBinding, current.binding)) blockers.push("catalog-revision-drift");
  if (!current.repositoryRoot) blockers.push("catalog-git-binding-required");
  if (plan.provenance.runtimeVersion !== runtimeVersion) blockers.push("runtime-version-drift");
  const staleCandidates = checkEvidenceFreshness(plan, now);
  if (staleCandidates.length) blockers.push("approved-evidence-stale");
  const status = current.repositoryRoot ? await repositoryStatus(current.repositoryRoot) : [];
  const plannedLockPath = plannedBinding.state === "bound"
    ? catalogRepositoryPath(plannedBinding.catalogPath, ".devhub-mutation.lock")
    : null;
  const lockActive = status.some((record) => record.startsWith("?? ") && record.slice(3) === plannedLockPath);
  if (lockActive) blockers.push("catalog-locked");
  if (cleanExceptLock(status, plannedLockPath).length) blockers.push("catalog-base-not-clean");
  const uniqueBlockers = [...new Set(blockers)];
  const branch = proposalBranch(plan.planId);
  const checks = Object.freeze({
    catalogRevisionMatches: sameBinding(plannedBinding, current.binding),
    runtimeVersionMatches: plan.provenance.runtimeVersion === runtimeVersion,
    cleanCatalogBase: status.length === 0,
    staleCandidateIds: Object.freeze(staleCandidates),
  });
  if (!parsed.apply) return Object.freeze({ parsed, result: previewResult(plan, branch, checks, uniqueBlockers) });
  if (uniqueBlockers.length) {
    const code = uniqueBlockers.includes("catalog-revision-drift")
      ? "onboard-catalog-drift"
      : uniqueBlockers.includes("catalog-locked")
        ? "catalog-locked"
        : uniqueBlockers.includes("runtime-version-drift")
          ? "onboard-runtime-drift"
          : "onboard-apply-blocked";
    fail(code, `onboard apply is blocked: ${uniqueBlockers.join(", ")}`);
  }
  throwIfAborted(options.signal);

  const expectedPaths = plannedRepositoryPaths(plan);
  const existing = await existingProposal(current.repositoryRoot, branch, plan, expectedPaths);
  if (existing) {
    const doctorFindings = await verifyExistingProposal({
      runtimeRoot,
      repositoryRoot: current.repositoryRoot,
      proposal: existing,
      plan,
      signal: options.signal,
    });
    const finalSource = await inspectSourceCheckout(paths, plannedBinding, current.repositoryRoot, options.catalogRevision);
    if (!finalSource.revisionMatches) fail("onboard-catalog-drift", "catalog repository, base revision or fingerprint changed during existing proposal verification");
    if (!finalSource.clean) fail("onboard-cleanup-conflict", "source catalog checkout is not clean after existing proposal verification");
    return Object.freeze({
      parsed,
      result: Object.freeze({
        version: 1,
        command: "onboard-apply",
        readOnly: false,
        status: "already-committed",
        planId: plan.planId,
        proposal: { ...existing, files: expectedPaths },
        blockers: [],
        verification: verificationEvidence(plan, plannedBinding, { committed: true, doctorFindings }),
        rollback: { required: false, sourceCheckoutChanged: false, temporaryWorktreeRemoved: true, failureBranchRemoved: false },
        nextAction: `Review local proposal branch ${branch}; push it only as a separate explicit action.`,
      }),
    });
  }

  const createdLockDirectories = await createLockDirectories(paths.catalogDirectory);
  if (plannedBinding.catalogState === "absent" && !createdLockDirectories.includes(path.resolve(paths.catalogDirectory))) {
    await removeLockDirectories(createdLockDirectories);
    fail("catalog-locked", "another catalog transaction created the planned catalog destination first");
  }
  let transaction = null;
  let applyError = null;
  let proposalBranchCreated = false;
  try {
    transaction = await withCatalogMutationLock(paths, async () => {
      const lockRelativePath = catalogRepositoryPath(plannedBinding.catalogPath, ".devhub-mutation.lock");
      const [lockedRevision, lockedStatus] = await Promise.all([
        inspectCatalogRevision(paths, plannedBinding.catalogState, options.catalogRevision),
        repositoryStatus(current.repositoryRoot),
      ]);
      if (!sameBinding(plannedBinding, lockedRevision.binding)) fail("onboard-catalog-drift", "catalog repository, base revision or fingerprint changed before the isolated transaction");
      const conflicts = cleanExceptLock(lockedStatus, lockRelativePath);
      if (conflicts.length) fail("onboard-catalog-drift", "catalog repository changed before the isolated transaction");
      throwIfAborted(options.signal);

      const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-onboard-apply-"));
      const worktreeRoot = path.join(temporary, "worktree");
      const generatedTemporary = path.join(temporary, "generated");
      await mkdir(generatedTemporary);
      let worktreeCreated = false;
      let branchCreated = false;
      let committed = false;
      let proposal = null;
      let transactionError = null;
      try {
        await runGit(current.repositoryRoot, ["worktree", "add", "--detach", worktreeRoot, plannedBinding.baseRevision]);
        worktreeCreated = true;
        await runGit(worktreeRoot, ["switch", "-c", branch]);
        branchCreated = true;
        proposalBranchCreated = true;
        proposal = await verifyAndCommit({
          runtimeRoot,
          worktreeRoot,
          generatedTemporary,
          plan,
          branch,
          signal: options.signal,
          lifecycle: options.lifecycle,
        });
        committed = true;
      } catch (error) {
        transactionError = error;
      }
      const cleanupErrors = await cleanupTemporaryWorktree(current.repositoryRoot, temporary, worktreeRoot, worktreeCreated);
      if (branchCreated && (!committed || cleanupErrors.length)) {
        const branchError = await removeProposalBranch(current.repositoryRoot, branch);
        if (branchError) cleanupErrors.push(branchError);
        else proposalBranchCreated = false;
      }
      if (cleanupErrors.length) fail("onboard-cleanup-conflict", `isolated Git cleanup failed: ${cleanupErrors.join("; ")}`);
      if (transactionError) throw transactionError;
      return proposal;
    });
  } catch (error) {
    applyError = error;
  }
  let lockCleanupError = null;
  try {
    await removeLockDirectories(createdLockDirectories);
  } catch (error) {
    lockCleanupError = error;
  }
  if (lockCleanupError) {
    if (proposalBranchCreated) {
      const branchError = await removeProposalBranch(current.repositoryRoot, branch);
      if (branchError) fail("onboard-cleanup-conflict", `${lockCleanupError.message}; proposal rollback failed: ${branchError}`);
      proposalBranchCreated = false;
    }
    throw lockCleanupError;
  }
  if (applyError) {
    if (proposalBranchCreated) {
      const branchError = await removeProposalBranch(current.repositoryRoot, branch);
      if (branchError) fail("onboard-cleanup-conflict", `isolated transaction failed and proposal rollback failed: ${branchError}`);
      proposalBranchCreated = false;
    }
    const rollbackStatus = await repositoryStatus(current.repositoryRoot);
    if (rollbackStatus.length) fail("onboard-cleanup-conflict", "source catalog checkout is not clean after isolated transaction rollback");
    const error = applyError;
    if (options.signal?.aborted && !(error instanceof OnboardApplyError && error.code === "onboard-cleanup-conflict")) {
      fail("onboard-apply-interrupted", "onboard apply was interrupted; the isolated transaction was removed");
    }
    const code = error instanceof OnboardApplyError || error instanceof ReconciliationApplyError
      ? error.code
      : "onboard-transaction-failed";
    const detail = error instanceof OnboardApplyError || error instanceof ReconciliationApplyError
      ? error.message
      : "isolated catalog validation or Git transaction failed";
    const failure = new OnboardApplyError(code, `${detail}; rollback verified: the temporary worktree and proposal branch were removed and the source checkout was not changed`);
    failure.cause = error;
    throw failure;
  }

  let finalSource;
  try {
    finalSource = await inspectSourceCheckout(paths, plannedBinding, current.repositoryRoot, options.catalogRevision);
  } catch {
    const branchError = await removeProposalBranch(current.repositoryRoot, transaction.branch);
    fail("onboard-cleanup-conflict", `source catalog checkout could not be rebound after the isolated transaction; proposal branch rollback ${branchError ? `failed: ${branchError}` : "passed"}`);
  }
  if (!finalSource.revisionMatches) {
    const branchError = await removeProposalBranch(current.repositoryRoot, transaction.branch);
    fail("onboard-catalog-drift", `catalog repository, base revision or fingerprint changed during the isolated transaction; proposal branch rollback ${branchError ? `failed: ${branchError}` : "passed"}`);
  }
  if (!finalSource.clean) {
    const branchError = await removeProposalBranch(current.repositoryRoot, transaction.branch);
    fail("onboard-cleanup-conflict", `source catalog checkout is not clean after the isolated transaction; proposal branch rollback ${branchError ? `failed: ${branchError}` : "passed"}`);
  }
  return Object.freeze({
    parsed,
    result: Object.freeze({
      version: 1,
      command: "onboard-apply",
      readOnly: false,
      status: "committed",
      planId: plan.planId,
      proposal: {
        branch: transaction.branch,
        commit: transaction.commit,
        parent: transaction.parent,
        files: transaction.files,
      },
      blockers: [],
      verification: verificationEvidence(plan, plannedBinding, { committed: true, doctorFindings: transaction.doctorFindings }),
      rollback: { required: false, sourceCheckoutChanged: false, temporaryWorktreeRemoved: true, failureBranchRemoved: false },
      nextAction: `Review local proposal branch ${branch}; push it only as a separate explicit action.`,
    }),
  });
}

export function formatOnboardApply(result) {
  if (result.status === "blocked") {
    return [
      `DevHub onboarding apply preview is blocked for ${result.planId}.`,
      `Blockers: ${result.blockers.join(", ")}.`,
      "No worktree, branch, commit, catalog file or generated output was created.",
      result.nextAction,
    ].join("\n");
  }
  if (result.readOnly) {
    return [
      `DevHub onboarding apply preview is ready for ${result.planId}.`,
      `Proposal branch: ${result.proposal.branch}.`,
      `Exact files: ${result.proposal.files.join(", ")}.`,
      "No worktree, branch, commit, catalog file or generated output was created.",
      result.nextAction,
    ].join("\n");
  }
  return [
    `DevHub onboarding plan ${result.status === "already-committed" ? "already has" : "created"} a verified local proposal.`,
    `Branch: ${result.proposal.branch}`,
    `Commit: ${result.proposal.commit}`,
    `Files: ${result.proposal.files.join(", ")}`,
    "The source checkout is clean and unchanged; the temporary worktree and generated scratch output were removed.",
    result.nextAction,
  ].join("\n");
}
