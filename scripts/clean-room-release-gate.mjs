#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import {
  lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { calculateOnboardPlanId } from "../lib/onboard.mjs";
import { vercelTaskObservationBridge } from "../lib/setup-connectors/vercel.mjs";
import { inspectRuntimeArchive } from "./devhub-install.mjs";
import { verifyReleaseArtifacts } from "./release-artifacts.mjs";
import { scanPublicExport } from "./scan-public-export.mjs";
import { verifyPublicManifest } from "./verify-public-manifest.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const reportName = "RC-GATE-EVIDENCE.json";
const priorRelease = Object.freeze({
  tag: "v0.7.0-alpha.2",
  version: "0.7.0-alpha.2",
  sourceCommit: "510f1b508dc3ce5facf0b70a03e8a70a5945c4c6",
  runtimeSha256: "d4e72a268d4a99a008186e34059e15f1d019062e98b42880b94d539f573d6014",
});

function fail(message) {
  throw new Error(message);
}

function digest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function parseArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!new Set(["--evidence", "--output", "--expected-commit", "--prior-runtime"]).has(option)
        || values.has(option)) {
      fail(`Unsupported or duplicate clean-room gate option: ${option}`);
    }
    const value = args[++index];
    if (!value || value.startsWith("--")) fail(`${option} requires one value`);
    values.set(option, value);
  }
  if (!values.has("--evidence") || !values.has("--output") || !values.has("--prior-runtime")) {
    fail("Usage: clean-room-release-gate --evidence <candidate-assets> --prior-runtime <published-runtime-archive> --output <empty-report-directory> [--expected-commit <sha>]");
  }
  const expectedCommit = values.get("--expected-commit") ?? null;
  if (expectedCommit !== null && !/^[a-f0-9]{40,64}$/.test(expectedCommit)) {
    fail("--expected-commit must be one full hexadecimal Git commit");
  }
  return Object.freeze({
    evidenceRoot: path.resolve(values.get("--evidence")),
    output: path.resolve(values.get("--output")),
    priorRuntime: path.resolve(values.get("--prior-runtime")),
    expectedCommit,
  });
}

async function run(file, args, options = {}) {
  return execFileAsync(file, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 60_000,
    maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
  });
}

async function runJson(file, args, options = {}) {
  const { stdout, stderr } = await run(file, args, options);
  if (stderr) fail(`${path.basename(file)} wrote unexpected stderr: ${stderr}`);
  try {
    return JSON.parse(stdout);
  } catch {
    fail(`${path.basename(file)} did not return one JSON document`);
  }
}

async function expectJsonFailure(file, args, expectedCode, options = {}) {
  try {
    await run(file, args, options);
  } catch (error) {
    let payload;
    try {
      payload = JSON.parse(error.stdout ?? "");
    } catch {
      fail(`${path.basename(file)} failed without bounded JSON evidence for ${expectedCode}`);
    }
    if (payload?.error?.code !== expectedCode) {
      fail(`${path.basename(file)} failed with ${payload?.error?.code ?? "unknown"}, expected ${expectedCode}`);
    }
    return payload;
  }
  fail(`${path.basename(file)} unexpectedly passed; expected ${expectedCode}`);
}

async function git(repository, ...args) {
  const { stdout } = await run("git", ["-C", repository, ...args], { timeout: 30_000 });
  return stdout.trim();
}

async function gitStatusBytes(repository) {
  const { stdout } = await execFileAsync("git", [
    "-C", repository, "status", "--porcelain=v1", "-z", "--untracked-files=all",
  ], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
}

async function workingTreeState(repository) {
  const entries = [];
  async function walk(directory, relativeDirectory = "") {
    const children = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => !(relativeDirectory === "" && entry.name === ".git"))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const child of children) {
      const relative = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      const absolute = path.join(directory, child.name);
      const details = await lstat(absolute);
      if (details.isSymbolicLink()) fail(`Dirty repository fixture contains an unexpected symbolic link: ${relative}`);
      if (details.isDirectory()) {
        entries.push({ path: `${relative}/`, mode: details.mode & 0o777 });
        await walk(absolute, relative);
      } else if (details.isFile()) {
        entries.push({ path: relative, mode: details.mode & 0o777, sha256: digest(await readFile(absolute)) });
      } else fail(`Dirty repository fixture contains an unsupported file: ${relative}`);
    }
  }
  await walk(repository);
  return Object.freeze({
    entries,
    sha256: digest(JSON.stringify(entries)),
    status: await gitStatusBytes(repository),
  });
}

async function assertWorkingTreeUnchanged(repository, before) {
  const after = await workingTreeState(repository);
  if (after.sha256 !== before.sha256 || !after.status.equals(before.status)) {
    fail("The unrelated dirty repository changed during the clean-room transaction");
  }
  return after.sha256;
}

function collectChild(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function waitForPath(filename, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      return await lstat(filename);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  fail(`Timed out waiting for clean-room transaction boundary ${path.basename(filename)}`);
}

function cliPaths(catalogDirectory, profiles, generated) {
  return [
    "--catalog-dir", catalogDirectory,
    "--connection-profiles-file", profiles,
    "--generated-dir", generated,
  ];
}

function approvedReview(preview, now) {
  const candidate = preview.candidateDecisions.find((entry) => entry.source === "local-host" && entry.kind === "project");
  if (!candidate) fail("Approved-root discovery did not produce a local project candidate");
  return Object.freeze({
    candidate,
    document: {
      version: 1,
      artifactId: preview.provenance.setupArtifactId,
      decisions: [{
        candidateId: candidate.id,
        reviewedAt: now,
        reviewedBy: "RC gate reviewer",
        disposition: "new",
        answers: { productIdentity: "RC Gate Project", operatingIntent: "discovery" },
      }],
    },
  });
}

function stalePlan(plan) {
  const stale = structuredClone(plan);
  const changedCandidates = new Set();
  for (const operation of stale.application.operations) {
    if (!operation.evidence?.validUntil || !operation.candidateId) continue;
    operation.evidence.validUntil = "2000-01-01T00:00:00.000Z";
    changedCandidates.add(operation.candidateId);
  }
  for (const candidate of stale.candidateDecisions) {
    if (changedCandidates.has(candidate.id) && candidate.evidence?.validUntil) {
      candidate.evidence.validUntil = "2000-01-01T00:00:00.000Z";
    }
  }
  if (!changedCandidates.size) fail("Approved plan has no candidate evidence to expire");
  stale.planId = calculateOnboardPlanId(stale);
  return stale;
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!port) fail("Unable to reserve a dashboard verification port");
  return port;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function mcpRequest(baseUrl, id, method, params = {}) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) fail(`MCP ${method} returned HTTP ${response.status}`);
  return response.json();
}

async function verifyDashboardAndMcp(catalogDirectory, profiles, hostId) {
  const environment = {
    ...process.env,
    DEVHUB_CATALOG_DIR: catalogDirectory,
    DEVHUB_CONNECTION_PROFILES_FILE: profiles,
    DEVHUB_HOST_ID: hostId,
    DEVHUB_INSTANCE_MODE: "private",
    DEVHUB_INSTANCE_LABEL: "RC clean room",
    DEVHUB_MCP_AUTH_MODE: "network",
    WRANGLER_WRITE_LOGS: "false",
    WRANGLER_LOG_PATH: path.join(root, ".rc-gate-wrangler.log"),
    MINIFLARE_REGISTRY_PATH: path.join(root, ".rc-gate-miniflare"),
  };
  delete environment.DEVHUB_GENERATED_DIR;
  await run("npm", ["ci"], { cwd: root, env: environment, timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024 });
  await run("npm", ["run", "build"], { cwd: root, env: environment, timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024 });

  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(root, "dist/standalone/server.js")], {
    cwd: root,
    env: { ...environment, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  let exited = false;
  const appendLog = (chunk) => { logs = `${logs}${chunk.toString("utf8")}`.slice(-64 * 1024); };
  child.stdout.on("data", appendLog);
  child.stderr.on("data", appendLog);
  const completion = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
    child.once("error", (error) => {
      exited = true;
      resolve({ error });
    });
  });
  try {
    const deadline = Date.now() + 60_000;
    let dashboard = null;
    while (Date.now() < deadline) {
      if (exited) fail(`Dashboard exited before readiness\n${logs}`);
      try {
        const response = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(2_000) });
        if (response.ok) {
          dashboard = await response.text();
          break;
        }
      } catch {
        // The candidate server may still be starting.
      }
      await delay(250);
    }
    if (!dashboard) fail(`Dashboard did not become ready\n${logs}`);
    if (!dashboard.includes("DevHub")) fail("Dashboard response did not contain the DevHub application shell");

    const initialized = await mcpRequest(baseUrl, "rc-initialize", "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "devhub-rc-gate", version: "1.0.0" },
    });
    if (initialized?.result?.serverInfo?.name !== "devhub") fail("MCP initialization did not identify DevHub");
    const listed = await mcpRequest(baseUrl, "rc-list-projects", "tools/call", {
      name: "list_projects",
      arguments: {},
    });
    const projects = listed?.result?.structuredContent?.projects;
    if (!Array.isArray(projects) || !projects.some((project) => project.id === "rc-gate-project")) {
      fail("MCP did not expose the reviewed onboarding project");
    }
    return Object.freeze({ dashboardProject: "rc-gate-project", mcpTool: "list_projects" });
  } finally {
    if (!exited) child.kill("SIGTERM");
    await Promise.race([completion, delay(5_000)]);
    if (!exited) {
      child.kill("SIGKILL");
      await completion;
    }
  }
}

const parsed = parseArguments(process.argv.slice(2));
if (!new Set(["darwin", "linux"]).has(process.platform)) {
  fail("The full clean-room transaction is release-gated only on macOS and Linux");
}
const outputEntries = await readdir(parsed.output).catch((error) => {
  if (error?.code === "ENOENT") return null;
  throw error;
});
if (outputEntries?.length) fail(`Clean-room report directory must be empty: ${parsed.output}`);
await mkdir(parsed.output, { recursive: true });

const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-rc-clean-room-"));
const checks = [];
function passed(id, evidence = null) {
  checks.push(Object.freeze({ id, state: "passed", ...(evidence === null ? {} : { evidence }) }));
}

try {
  const verification = await verifyReleaseArtifacts(parsed.evidenceRoot);
  const evidenceContents = await readFile(path.join(parsed.evidenceRoot, "RELEASE-EVIDENCE.json"));
  const evidence = JSON.parse(evidenceContents);
  const checksumsContents = await readFile(path.join(parsed.evidenceRoot, "SHA256SUMS"));
  if (evidence.formatVersion !== 3) {
    fail("RC gate requires release evidence format version 3 with privacy provenance");
  }
  if (evidence.source.state !== "clean") fail("RC gate requires a clean exact-commit public candidate");
  if (parsed.expectedCommit && evidence.source.commit !== parsed.expectedCommit) {
    fail(`Candidate commit ${evidence.source.commit} does not match expected commit ${parsed.expectedCommit}`);
  }
  if (!/^[a-f0-9]{64}$/.test(evidence.privacy?.fingerprintPolicySha256 ?? "")) {
    fail("RC gate requires candidate evidence from the private fingerprint privacy policy");
  }
  await verifyPublicManifest(root);
  await scanPublicExport(root);
  const sourceManifest = JSON.parse(await readFile(path.join(root, "PUBLIC_EXPORT_MANIFEST.json"), "utf8"));
  if (sourceManifest.source.commit !== evidence.source.commit || sourceManifest.source.state !== "clean") {
    fail("Extracted candidate source does not match the exact release evidence");
  }
  passed("exact-candidate", evidence.source.commit);
  passed("checksums-and-sbom", `${verification.files} files`);
  passed("sanitized-public-source", sourceManifest.files.length);
  passed("privacy-scan", evidence.privacy.fingerprintPolicySha256);

  const homeDirectory = path.join(temporary, "home");
  const dataHome = path.join(homeDirectory, ".local/share");
  const configHome = path.join(homeDirectory, ".config");
  const dataRoot = path.join(dataHome, "devhub");
  const binDirectory = path.join(homeDirectory, ".local/bin");
  const catalogSentinel = path.join(dataRoot, "catalog/preserve-me.txt");
  const configSentinel = path.join(configHome, "devhub/preserve-me.json");
  await mkdir(path.dirname(catalogSentinel), { recursive: true });
  await mkdir(path.dirname(configSentinel), { recursive: true });
  await writeFile(catalogSentinel, "preserve catalog\n");
  await writeFile(configSentinel, "{\"preserve\":true}\n");

  const candidateArchivePath = path.join(parsed.evidenceRoot, evidence.runtime.file);
  const candidateArchive = await readFile(candidateArchivePath);
  const installerAsset = path.join(parsed.evidenceRoot, evidence.installer.file);
  const priorArchive = await readFile(parsed.priorRuntime);
  if (digest(priorArchive) !== priorRelease.runtimeSha256) {
    fail(`Published prior runtime digest does not match ${priorRelease.tag}`);
  }
  const priorRuntime = inspectRuntimeArchive(priorArchive);
  if (priorRuntime.manifest.version !== priorRelease.version
      || priorRuntime.manifest.source?.state !== "clean"
      || priorRuntime.manifest.source?.commit !== priorRelease.sourceCommit) {
    fail(`Published prior runtime manifest does not match ${priorRelease.tag}`);
  }
  if (priorRuntime.manifest.version === evidence.version
      || priorRuntime.manifest.source.commit === evidence.source.commit
      || priorRelease.runtimeSha256 === evidence.runtime.sha256) {
    fail("Published prior runtime must differ from the exact candidate version, source, and bytes");
  }
  const priorVersion = priorRuntime.manifest.version;
  passed("published-prior-runtime", `${priorVersion} ${priorRuntime.manifest.source.commit}`);

  const environment = {
    ...process.env,
    XDG_DATA_HOME: dataHome,
    XDG_CONFIG_HOME: configHome,
    PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  const installBase = [
    "install", "--archive", parsed.priorRuntime, "--sha256", priorRelease.runtimeSha256,
    "--data-root", dataRoot, "--bin-dir", binDirectory, "--json",
  ];

  await expectJsonFailure(process.execPath, [
    installerAsset, "install", "--archive", candidateArchivePath, "--sha256", "0".repeat(64),
    "--data-root", dataRoot, "--bin-dir", binDirectory, "--json",
  ], "runtime-checksum-mismatch", { env: environment });
  const truncatedPath = path.join(temporary, "truncated-runtime.tar.gz");
  const truncated = candidateArchive.subarray(0, Math.max(1, Math.floor(candidateArchive.length / 2)));
  await writeFile(truncatedPath, truncated);
  await expectJsonFailure(process.execPath, [
    installerAsset, "install", "--archive", truncatedPath, "--sha256", digest(truncated),
    "--data-root", dataRoot, "--bin-dir", binDirectory, "--json",
  ], "runtime-archive-invalid", { env: environment });
  passed("bad-checksum-fails-closed");
  passed("truncated-artifact-fails-closed");

  const interruptedEnvironment = {
    ...environment,
    NODE_ENV: "test",
    DEVHUB_TEST_INSTALL_ACTIVATION: "pause-after-first",
  };
  const interrupted = spawn(process.execPath, [installerAsset, ...installBase], {
    env: interruptedEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const interruptedCompletion = collectChild(interrupted);
  await waitForPath(path.join(dataRoot, "runtime", priorVersion));
  await waitForPath(path.join(binDirectory, "devhub"));
  if (!interrupted.kill("SIGKILL")) fail("Unable to interrupt the installer transaction");
  const interruptedResult = await interruptedCompletion;
  if (interruptedResult.signal !== "SIGKILL") fail("Installer did not stop at the controlled process interruption");
  const installedPrior = await runJson(process.execPath, [installerAsset, ...installBase], { env: environment, timeout: 30_000 });
  if (installedPrior.runtimeVersion !== priorVersion) fail("Interrupted install retry did not activate the prior runtime");
  passed("interrupted-install-recovers", "SIGKILL then exact retry");

  const devhub = path.join(binDirectory, "devhub");
  const devhubInstall = path.join(binDirectory, "devhub-install");
  const priorWorkflow = await runJson(devhub, ["doctor", "--workflow", "--json"], { cwd: temporary, env: environment });
  if (priorWorkflow.runtimeVersion !== priorVersion || priorWorkflow.contractVersion !== 2) {
    fail("Prior installed runtime did not pass workflow doctor");
  }
  const upgraded = await runJson(devhubInstall, [
    "install", "--archive", candidateArchivePath, "--sha256", evidence.runtime.sha256, "--json",
  ], { cwd: temporary, env: environment, timeout: 30_000 });
  if (upgraded.runtimeVersion !== evidence.version) fail("Exact candidate upgrade did not activate vN+1");
  const workflow = await runJson(devhub, ["doctor", "--workflow", "--json"], { cwd: temporary, env: environment });
  if (workflow.runtimeVersion !== evidence.version || workflow.contractVersion !== 2
      || JSON.stringify(workflow.capabilities) !== JSON.stringify({
        setupRun: 1,
        connectionReview: 1,
        guidedConfirmation: 1,
        taskObservation: 1,
      })) {
    fail("Exact candidate workflow contract is incompatible");
  }
  passed("install-and-workflow-doctor", evidence.version);
  passed("upgrade-vn-to-vn-plus-one", `${priorVersion} -> ${evidence.version}`);

  const dirtyRepository = path.join(temporary, "unrelated-dirty-repository");
  await mkdir(dirtyRepository);
  await git(dirtyRepository, "init", "-b", "main");
  await git(dirtyRepository, "config", "user.name", "DevHub RC gate");
  await git(dirtyRepository, "config", "user.email", "devhub-rc-gate@example.invalid");
  await writeFile(path.join(dirtyRepository, "tracked.txt"), "clean base\n");
  await git(dirtyRepository, "add", "--", "tracked.txt");
  await git(dirtyRepository, "commit", "-m", "fixture: unrelated base");
  await writeFile(path.join(dirtyRepository, "tracked.txt"), "dirty tracked bytes\n");
  await writeFile(path.join(dirtyRepository, "untracked.bin"), Buffer.from([0x00, 0x10, 0x20, 0xff]));
  const dirtyBefore = await workingTreeState(dirtyRepository);

  const catalogRepository = path.join(temporary, "catalog-repository");
  const catalogDirectory = path.join(catalogRepository, "catalog");
  const generatedDirectory = path.join(temporary, "generated");
  const profiles = path.join(configHome, "devhub/connection-profiles.json");
  await mkdir(catalogRepository);
  await writeFile(path.join(catalogRepository, "README.md"), "RC gate catalog repository\n");
  await git(catalogRepository, "init", "-b", "main");
  await git(catalogRepository, "config", "user.name", "DevHub RC gate");
  await git(catalogRepository, "config", "user.email", "devhub-rc-gate@example.invalid");
  await git(catalogRepository, "add", "--", "README.md");
  await git(catalogRepository, "commit", "-m", "fixture: empty catalog base");
  const catalogBase = await git(catalogRepository, "rev-parse", "HEAD");
  try {
    await lstat(catalogDirectory);
    fail("Clean-room catalog must start absent");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  passed("empty-catalog", catalogBase);

  const approvedRoot = path.join(temporary, "approved-root");
  await mkdir(approvedRoot);
  await writeFile(path.join(approvedRoot, "package.json"), `${JSON.stringify({
    name: "rc-gate-project",
    version: "1.0.0",
    scripts: {},
  }, null, 2)}\n`);
  await writeFile(path.join(approvedRoot, "README.md"), "RC gate project\n");
  const taskObservationPath = path.join(temporary, "task-observation.json");
  await writeFile(taskObservationPath, `${JSON.stringify({
    version: 1,
    selectedConnectorIds: ["vercel"],
    observations: [{
      connectorId: "vercel",
      bridgeId: vercelTaskObservationBridge.id,
      observedAt: new Date().toISOString(),
      scope: { kind: "team", label: "RC gate task scope" },
      resources: [],
    }],
  }, null, 2)}\n`);
  const commonOnboard = [
    "onboard", "--sources", "vercel", "--task-observation", taskObservationPath, "--root", approvedRoot,
    "--host-id", "rc-gate-host", "--json",
    ...cliPaths(catalogDirectory, profiles, generatedDirectory),
  ];
  const preview = await runJson(devhub, commonOnboard, { cwd: dirtyRepository, env: environment, timeout: 30_000 });
  if (preview.command !== "onboard" || preview.diff?.state !== "none" || preview.provenance.catalog.state !== "starter-preview") {
    fail("First onboarding preview did not preserve the empty catalog boundary");
  }
  const now = new Date().toISOString();
  const review = approvedReview(preview, now);
  const reviewPath = path.join(temporary, "review.json");
  await writeFile(reviewPath, `${JSON.stringify(review.document, null, 2)}\n`);
  const approvedPlan = await runJson(devhub, [
    ...commonOnboard.slice(0, -cliPaths(catalogDirectory, profiles, generatedDirectory).length),
    "--review", reviewPath,
    ...cliPaths(catalogDirectory, profiles, generatedDirectory),
  ], { cwd: dirtyRepository, env: environment, timeout: 30_000 });
  if (!approvedPlan.application?.eligible
      || !approvedPlan.application.operations.some((operation) => operation.kind === "create-starter-catalog")
      || !approvedPlan.application.operations.some((operation) => operation.kind === "create-overlay-project")) {
    fail(`Reviewed onboarding plan is not eligible for the exact starter-catalog transaction: ${JSON.stringify({
      blockers: approvedPlan.application?.blockers,
      unresolved: approvedPlan.unresolvedQuestions?.map((question) => [question.source, question.kind]),
      candidates: approvedPlan.candidateDecisions?.map((candidate) => [candidate.source, candidate.state, candidate.decision]),
      sources: approvedPlan.sourceResults,
    })}`);
  }
  const planPath = path.join(temporary, "approved-plan.json");
  await writeFile(planPath, `${JSON.stringify(approvedPlan, null, 2)}\n`);
  passed("approved-root-discovery", review.candidate.id);
  passed("onboard-preview", approvedPlan.planId);

  const applyPaths = cliPaths(catalogDirectory, profiles, generatedDirectory);
  const applyPreview = await runJson(devhub, ["onboard-apply", planPath, "--json", ...applyPaths], {
    cwd: dirtyRepository,
    env: environment,
    timeout: 30_000,
  });
  if (applyPreview.status !== "ready" || !applyPreview.readOnly) fail("Onboarding apply preview was not ready and read-only");

  const stalePath = path.join(temporary, "stale-plan.json");
  await writeFile(stalePath, `${JSON.stringify(stalePlan(approvedPlan), null, 2)}\n`);
  await expectJsonFailure(devhub, ["onboard-apply", stalePath, "--apply", "--json", ...applyPaths], "onboard-apply-blocked", {
    cwd: dirtyRepository,
    env: environment,
    timeout: 30_000,
  });
  passed("stale-plan-fails-closed");

  const applied = await runJson(devhub, ["onboard-apply", planPath, "--apply", "--json", ...applyPaths], {
    cwd: dirtyRepository,
    env: environment,
    timeout: 60_000,
  });
  if (applied.status !== "committed" || applied.proposal?.parent !== catalogBase) {
    fail("Reviewed apply did not create the exact isolated proposal");
  }
  if (await git(catalogRepository, "rev-parse", "HEAD") !== catalogBase
      || await git(catalogRepository, "status", "--porcelain") !== "") {
    fail("Reviewed apply changed the active catalog checkout");
  }
  const repeated = await runJson(devhub, ["onboard-apply", planPath, "--apply", "--json", ...applyPaths], {
    cwd: dirtyRepository,
    env: environment,
    timeout: 60_000,
  });
  if (repeated.status !== "already-committed" || repeated.proposal?.commit !== applied.proposal.commit) {
    fail("Second onboarding apply produced a new diff");
  }
  passed("reviewed-isolated-apply", applied.proposal.commit);
  passed("second-onboarding-pass-no-diff", repeated.proposal.commit);

  const verificationWorktree = path.join(temporary, "proposal-verification");
  await git(catalogRepository, "worktree", "add", "--detach", verificationWorktree, applied.proposal.commit);
  const proposalCatalog = path.join(verificationWorktree, "catalog");
  const proposalGenerated = path.join(temporary, "proposal-generated");
  await run(devhub, ["validate", ...cliPaths(proposalCatalog, profiles, proposalGenerated)], {
    cwd: dirtyRepository,
    env: environment,
    timeout: 60_000,
  });
  await run(devhub, ["validate", "--check", ...cliPaths(proposalCatalog, profiles, proposalGenerated)], {
    cwd: dirtyRepository,
    env: environment,
    timeout: 60_000,
  });
  passed("proposal-validate-and-check");

  const dashboardEvidence = await verifyDashboardAndMcp(proposalCatalog, profiles, "rc-gate-host");
  passed("dashboard-and-mcp", dashboardEvidence);

  await writeFile(path.join(catalogRepository, "README.md"), "RC gate catalog repository\ncatalog drift\n");
  await git(catalogRepository, "add", "--", "README.md");
  await git(catalogRepository, "commit", "-m", "fixture: catalog drift");
  await expectJsonFailure(devhub, ["onboard-apply", planPath, "--apply", "--json", ...applyPaths], "onboard-catalog-drift", {
    cwd: dirtyRepository,
    env: environment,
    timeout: 30_000,
  });
  passed("catalog-drift-fails-closed");

  const dirtyDigest = await assertWorkingTreeUnchanged(dirtyRepository, dirtyBefore);
  passed("dirty-unrelated-repository-unchanged", dirtyDigest);

  const rollback = await runJson(devhubInstall, ["rollback", "--version", priorVersion, "--json"], {
    cwd: dirtyRepository,
    env: environment,
    timeout: 30_000,
  });
  if (rollback.runtimeVersion !== priorVersion) fail("Rollback did not reactivate vN");
  const reupgrade = await runJson(devhubInstall, [
    "install", "--archive", candidateArchivePath, "--sha256", evidence.runtime.sha256, "--json",
  ], { cwd: dirtyRepository, env: environment, timeout: 30_000 });
  if (reupgrade.runtimeVersion !== evidence.version) fail("Candidate could not be reactivated after rollback");
  passed("rollback-and-reupgrade", `${evidence.version} -> ${priorVersion} -> ${evidence.version}`);

  const uninstall = await runJson(devhubInstall, ["uninstall", "--json"], {
    cwd: dirtyRepository,
    env: environment,
    timeout: 30_000,
  });
  if (uninstall.status !== "uninstalled"
      || await readFile(catalogSentinel, "utf8") !== "preserve catalog\n"
      || await readFile(configSentinel, "utf8") !== "{\"preserve\":true}\n") {
    fail("Uninstall did not preserve catalog and configuration by default");
  }
  passed("uninstall-preserves-catalog-and-config");

  const report = {
    formatVersion: 1,
    gate: "devhub-clean-room-rc",
    status: "passed",
    candidate: {
      version: evidence.version,
      sourceCommit: evidence.source.commit,
      sourceState: evidence.source.state,
      evidenceSha256: digest(evidenceContents),
      checksumsSha256: digest(checksumsContents),
      sourceArchiveSha256: evidence.archive.sha256,
      runtimeSha256: evidence.runtime.sha256,
      installerSha256: evidence.installer.sha256,
      sbomSha256: evidence.sbom.sha256,
      privacyFingerprintPolicySha256: evidence.privacy.fingerprintPolicySha256,
    },
    prior: {
      releaseTag: priorRelease.tag,
      version: priorVersion,
      sourceCommit: priorRuntime.manifest.source.commit,
      sourceState: priorRuntime.manifest.source.state,
      runtimeSha256: priorRelease.runtimeSha256,
    },
    platform: { os: process.platform, arch: process.arch, node: process.version },
    checks,
    limitations: [
      "Windows is limited to separate source-asset CLI and path CI; this gate does not claim Windows installation, local discovery, dashboard service operation, or a Windows service installer.",
      "No provider call, credential, browser authorization, daemon, updater, public ingress, merge, release, deployment, or production system is exercised.",
      "Pull-request candidate evidence may name GitHub's synthetic merge commit; only evidence rebuilt from the exact merged main commit can support a tag review.",
    ],
  };
  await writeFile(path.join(parsed.output, reportName), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(`clean-room RC gate: passed ${checks.length} checks for ${evidence.source.commit} on ${process.platform}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
