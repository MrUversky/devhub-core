import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  classifyOnboardServiceCoverage,
  formatOnboardPlan,
  ONBOARD_MAX_PLAN_BYTES,
  suggestOnboardHostIdentity,
} from "../lib/onboard.mjs";
import { vercelTaskObservationBridge } from "../lib/setup-connectors/vercel.mjs";
import { resolveDevHubPaths } from "../scripts/devhub-config.mjs";
import { parseOnboardArguments, runOnboard } from "../scripts/onboard.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "scripts/devhub.mjs");
const supportedLocal = process.platform === "darwin" || process.platform === "linux";
const hostKind = process.platform === "darwin" ? "mac" : "linux";
const NOW = "2026-08-20T08:00:00.000Z";

function externalPaths(temporary, catalogDirectory = path.join(temporary, "catalog")) {
  return resolveDevHubPaths(root, {}, {
    pathOptions: {
      catalogDirectory,
      connectionProfilesFile: path.join(temporary, "connection-profiles.json"),
      generatedDirectory: path.join(temporary, "generated"),
    },
  });
}

function quietPlanning(temporary) {
  return {
    cwd: temporary,
    homeDirectory: temporary,
    pathValue: "",
    platform: process.platform,
    async access() { throw Object.assign(new Error("absent"), { code: "ENOENT" }); },
    async lstat() { throw Object.assign(new Error("absent"), { code: "ENOENT" }); },
  };
}

test("health coverage classifies reviewed runtime contracts without claiming a live observation", () => {
  const base = {
    name: "Fixture service",
    kind: "web",
    environment: "production",
    visibility: "internal",
    runtime: "fixture",
  };
  const coverage = classifyOnboardServiceCoverage({
    hosts: [
      { id: "reviewed-cloud", kind: "cloud" },
      { id: "reviewed-server", kind: "linux" },
      { id: "reviewed-workstation", kind: "mac" },
    ],
    projects: [{ manifest: {
      id: "coverage-fixture",
      lifecycle: "production",
      services: [
        { ...base, id: "direct", host: "reviewed-server", mode: "always-on", probe: { type: "http", url: "https://service.example.test/health", successStatuses: [200] } },
        { ...base, id: "protected", host: "reviewed-cloud", mode: "managed", probe: { type: "http", url: "https://protected.example.test/health", successStatuses: [200, 401] } },
        { ...base, id: "publisher", host: "reviewed-workstation", mode: "always-on", probe: { type: "http", url: "https://workstation.example.test/health/app", successStatuses: [200], publish: { type: "tailscale-serve" } } },
        { ...base, id: "provider-only", host: "reviewed-cloud", mode: "managed", readiness: { deployment: { source: "integration", provider: "Example Cloud", revision: "release-1" }, evidence: [] } },
        { ...base, id: "on-demand", host: "reviewed-workstation", mode: "on-demand", probe: { type: "http", url: "http://127.0.0.1:3000/health", successStatuses: [200] } },
        { ...base, id: "internal", host: "reviewed-server", mode: "internal", reported: { state: "up" } },
        { ...base, id: "missing", host: "reviewed-cloud", mode: "managed", reported: { state: "up" } },
      ],
    } }],
  });

  assert.deepEqual(coverage.counts, {
    "direct-https-probe": 2,
    "reviewed-tailnet-publisher": 1,
    "provider-evidence-only": 1,
    "intentionally-not-checked": 2,
    "missing-health-contract": 1,
  });
  assert.equal(coverage.observation, "catalog-contracts-only");
  assert.equal(coverage.semantics.providerDeploymentIsRuntimeLive, false);
  assert.equal(coverage.services.find((service) => service.serviceId === "protected").expectedAccess, "protected-or-success");
  assert.equal(coverage.services.find((service) => service.serviceId === "missing").statusEvidence, "reported-only");
  assert.deepEqual(coverage.publisherHosts, [{
    hostId: "reviewed-workstation",
    serviceKeys: ["coverage-fixture/publisher"],
    preview: { command: "setup-host-monitoring", apply: false },
    applyRequiresExplicitApproval: true,
    centralVerification: "required-after-device-local-publication",
  }]);
});

async function writeCatalog(catalogDirectory, { project = null } = {}) {
  await mkdir(path.join(catalogDirectory, "projects"), { recursive: true });
  await writeFile(path.join(catalogDirectory, "hosts.yaml"), `version: 1
hosts:
  - id: reviewed-host
    name: Reviewed host
    kind: ${hostKind}
    location: local
`);
  if (project) await writeFile(path.join(catalogDirectory, `projects/${project.id}.yaml`), project.yaml);
}

async function waitForPid(filename, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number((await readFile(filename, "utf8")).trim());
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // The hostile child has not published its descendant yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${filename}`);
}

async function waitForExit(pid) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { process.kill(pid, 0); } catch (error) { if (error?.code === "ESRCH") return; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`process ${pid} was not reaped`);
}

test("empty catalog preview composes init, setup-run, local Discovery Inbox and stays deterministic with no writes", { skip: !supportedLocal }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-onboard-empty-"));
  const selectedRoot = path.join(temporary, "selected");
  try {
    await mkdir(selectedRoot);
    await writeFile(path.join(selectedRoot, "package.json"), `${JSON.stringify({
      name: "new-tool",
      scripts: { start: "node index.js PRIVATE_SCRIPT_VALUE_MUST_NOT_APPEAR" },
    })}\n`);
    const paths = externalPaths(temporary);
    const args = ["--sources", "github", "--root", selectedRoot, "--host-id", "reviewed-host", "--json"];
    const options = {
      paths,
      environment: {},
      platform: process.platform,
      hostname: "reviewed-host.example",
      now: NOW,
      runtimeVersion: "0.7.0-alpha.2",
      planning: quietPlanning(temporary),
    };
    const first = (await runOnboard(root, args, options)).plan;
    const second = (await runOnboard(root, args, options)).plan;

    assert.deepEqual(second, first);
    assert.match(first.planId, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(first.diff, { changed: false, state: "none", reason: "preview-only" });
    assert.equal(first.provenance.catalog.state, "starter-preview");
    assert.equal(first.provenance.localDiscovery.status, "complete");
    assert.match(first.provenance.setupArtifactId, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(first.authority.sources, ["github"]);
    assert.equal(first.authority.localRoots.count, 1);
    assert.ok(first.candidateDecisions.some((decision) => decision.source === "local-host" && decision.decision === "review-new"));
    assert.ok(first.intendedWrites.some((write) => write.kind === "starter-catalog"));
    await assert.rejects(readdir(paths.catalogDirectory), { code: "ENOENT" });
    await assert.rejects(readdir(paths.generatedDirectory), { code: "ENOENT" });
    assert.match(await readFile(path.join(selectedRoot, "package.json"), "utf8"), /PRIVATE_SCRIPT_VALUE_MUST_NOT_APPEAR/);
    assert.doesNotMatch(JSON.stringify(first), /PRIVATE_SCRIPT_VALUE_MUST_NOT_APPEAR/);
    assert.doesNotMatch(JSON.stringify(first), new RegExp(temporary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("existing reviewed catalog is validated and exact local evidence is not duplicated or replaced", { skip: !supportedLocal }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-onboard-existing-"));
  const catalogDirectory = path.join(temporary, "catalog");
  const workspace = path.join(temporary, "known-project");
  try {
    await mkdir(workspace);
    await writeFile(path.join(workspace, "package.json"), `${JSON.stringify({ name: "known-project", scripts: {} })}\n`);
    const projectText = `version: 1
id: known-project
title: Known Project
registration: overlay
description: Existing onboard fixture.
lifecycle: active
kind: product
workspaces:
  - host: reviewed-host
    path: ${JSON.stringify(workspace)}
services:
  - id: dashboard
    name: Dashboard
    kind: web
    environment: production
    host: reviewed-host
    runtime: fixture
    mode: always-on
    visibility: internal
    probe:
      type: http
      url: https://known-project.example.test/health
      successStatuses: [200]
`;
    await writeCatalog(catalogDirectory, { project: { id: "known-project", yaml: projectText } });
    const beforeHosts = await readFile(path.join(catalogDirectory, "hosts.yaml"), "utf8");
    const beforeProject = await readFile(path.join(catalogDirectory, "projects/known-project.yaml"), "utf8");
    const paths = externalPaths(temporary, catalogDirectory);
    const plan = (await runOnboard(root, [
      "--sources", "github", "--root", workspace, "--host-id", "reviewed-host", "--json",
    ], {
      paths,
      environment: {},
      platform: process.platform,
      hostname: "reviewed-host.example",
      now: NOW,
      runtimeVersion: "0.7.0-alpha.2",
      planning: quietPlanning(temporary),
    })).plan;

    assert.deepEqual({ ...plan.provenance.catalog, binding: undefined }, {
      state: "reviewed-existing",
      destinationState: "nonempty",
      hosts: 1,
      projects: 1,
      binding: undefined,
    });
    assert.ok(plan.candidateDecisions.some((decision) => decision.source === "local-host" && decision.state === "exact-match" && decision.decision === "preserve-existing"));
    assert.deepEqual(plan.healthCoverage.services.map((service) => [service.key, service.classification]), [
      ["known-project/dashboard", "direct-https-probe"],
    ]);
    assert.equal(plan.intendedWrites.some((write) => write.kind === "starter-catalog"), false);
    assert.equal(plan.intendedWrites.some((write) => write.kind === "catalog-candidate-proposals"), false);
    assert.equal(await readFile(path.join(catalogDirectory, "hosts.yaml"), "utf8"), beforeHosts);
    assert.equal(await readFile(path.join(catalogDirectory, "projects/known-project.yaml"), "utf8"), beforeProject);
    assert.deepEqual(await readdir(path.join(catalogDirectory, "projects")), ["known-project.yaml"]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("mixed selected sources keep successful evidence while leaving only the unresolved source actionable", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-onboard-mixed-"));
  const catalogDirectory = path.join(temporary, "catalog");
  const calls = [];
  try {
    await writeCatalog(catalogDirectory);
    const profileDocument = { version: 1, profiles: [{
      version: 1,
      id: "internal-github-profile",
      connectorId: "github",
      authorization: { method: "cli-session" },
      scope: { kind: "user", login: "fictional-builder" },
      owner: "Fictional builder",
      state: "connected",
      lastObservedAt: "2026-08-20T07:30:00.000Z",
      freshForSeconds: 3600,
    }] };
    const plan = (await runOnboard(root, ["--sources", "github,vercel", "--json"], {
      paths: externalPaths(temporary, catalogDirectory),
      environment: {},
      platform: process.platform,
      hostname: "reviewed-host.example",
      now: NOW,
      runtimeVersion: "0.7.0-alpha.2",
      profileDocument,
      planning: quietPlanning(temporary),
      connectors: [
        {
          connectorId: "github",
          collect() {
            calls.push("github");
            return { state: "connected", observedAt: NOW, observations: [] };
          },
        },
        {
          connectorId: "railway",
          collect() {
            calls.push("railway");
            throw new Error("unselected connector must not run");
          },
        },
      ],
    })).plan;

    assert.deepEqual(calls, ["github"]);
    assert.deepEqual(plan.sourceResults.map((source) => [source.id, source.checked, source.result]), [
      ["github", true, "connected"],
      ["vercel", false, "needs-scope"],
    ]);
    assert.deepEqual(plan.unresolvedQuestions.filter((question) => question.source !== "this-computer").map((question) => question.source), ["vercel"]);
    assert.doesNotMatch(JSON.stringify(plan), /internal-github-profile|fictional-builder/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("one transient task observation flows through setup-run into the same onboard review plan", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-onboard-task-observation-"));
  const catalogDirectory = path.join(temporary, "catalog");
  const observationPath = path.join(temporary, "task-observation.json");
  try {
    await writeCatalog(catalogDirectory);
    await writeFile(observationPath, `${JSON.stringify({
      version: 1,
      selectedConnectorIds: ["vercel"],
      observations: [{
        connectorId: "vercel",
        bridgeId: vercelTaskObservationBridge.id,
        observedAt: "2026-08-20T07:59:00.000Z",
        scope: { kind: "team", label: "Fictional Studio" },
        resources: [{ kind: "project", label: "Task Project" }],
      }],
    })}\n`);
    const plan = (await runOnboard(root, [
      "--sources", "vercel", "--task-observation", observationPath, "--json",
    ], {
      paths: externalPaths(temporary, catalogDirectory),
      environment: {},
      platform: process.platform,
      hostname: "reviewed-host.example",
      now: NOW,
      runtimeVersion: "0.7.0-alpha.2",
      planning: quietPlanning(temporary),
    })).plan;

    assert.deepEqual(plan.sourceResults.map((source) => [source.id, source.checked, source.result]), [["vercel", true, "checked-this-task"]]);
    assert.ok(plan.candidateDecisions.some((decision) => decision.source === "vercel" && decision.label === "Task Project" && decision.decision === "review-new"));
    assert.doesNotMatch(JSON.stringify(plan), new RegExp(observationPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("ambiguous host identity remains an explicit question and blocks local enumeration", { skip: !supportedLocal }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-onboard-ambiguous-"));
  const selectedRoot = path.join(temporary, "selected");
  try {
    await mkdir(selectedRoot);
    const plan = (await runOnboard(root, ["--sources", "github", "--root", selectedRoot, "--json"], {
      paths: externalPaths(temporary),
      environment: {},
      platform: process.platform,
      hostname: "localhost",
      now: NOW,
      runtimeVersion: "0.7.0-alpha.2",
      planning: quietPlanning(temporary),
      localDiscoveryChildPath: path.join(temporary, "must-not-run.mjs"),
    })).plan;

    assert.equal(plan.provenance.hostSuggestion.ambiguous, true);
    assert.equal(plan.provenance.localDiscovery.status, "not-run");
    assert.equal(plan.provenance.localDiscovery.reason, "host-identity-review-required");
    assert.ok(plan.unresolvedQuestions.some((question) => question.id === "onboard-host-identity"));
    assert.equal(plan.candidateDecisions.filter((decision) => decision.source === "local-host").length, 0);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("onboard deadline kills and reaps local discovery descendants before returning a partial no-write plan", { skip: !supportedLocal || process.platform === "win32" }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-onboard-deadline-"));
  const catalogDirectory = path.join(temporary, "catalog");
  const selectedRoot = path.join(temporary, "selected");
  const pidFile = path.join(temporary, "descendant.pid");
  const childPath = path.join(temporary, "hostile-child.mjs");
  try {
    await Promise.all([writeCatalog(catalogDirectory), mkdir(selectedRoot)]);
    await writeFile(childPath, `
      import { spawn } from "node:child_process";
      import { writeFile } from "node:fs/promises";
      process.on("SIGTERM", () => {});
      const child = spawn(process.execPath, ["--input-type=module", "--eval", "process.on('SIGTERM',()=>{});setInterval(()=>{},10000)"], { stdio: "ignore" });
      await writeFile(${JSON.stringify(pidFile)}, String(child.pid));
      await new Promise(() => {});
    `);
    const operation = runOnboard(root, [
      "--sources", "github", "--root", selectedRoot, "--host-id", "reviewed-host", "--deadline-ms", "300", "--json",
    ], {
      paths: externalPaths(temporary, catalogDirectory),
      environment: {},
      platform: process.platform,
      hostname: "reviewed-host.example",
      now: NOW,
      runtimeVersion: "0.7.0-alpha.2",
      planning: quietPlanning(temporary),
      localDiscoveryChildPath: childPath,
    });
    const descendant = await waitForPid(pidFile);
    const { plan } = await operation;
    await waitForExit(descendant);
    assert.equal(plan.provenance.localDiscovery.status, "unknown");
    assert.ok(new Set(["local-discovery-aborted", "local-discovery-deadline"]).has(plan.provenance.localDiscovery.reason));
    assert.deepEqual(plan.diff, { changed: false, state: "none", reason: "preview-only" });
    assert.equal(plan.safety.repositoryWrites, false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("hostile roots, profile internals and secret-shaped hostnames stay out of bounded JSON and human output", { skip: !supportedLocal }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-onboard-private-"));
  const catalogDirectory = path.join(temporary, "catalog");
  const secretPrefix = ["s", "k-", "proj-"].join("");
  const selectedRoot = path.join(temporary, `${secretPrefix}private-root`);
  const profileDocument = { version: 1, profiles: [{
    version: 1,
    id: "internal-railway-profile",
    connectorId: "railway",
    authorization: { method: "secret-reference", credentialRef: { kind: "environment", locator: "PRIVATE_RAILWAY_LOCATOR" } },
    scope: { workspaceId: "fictional-workspace" },
    owner: "Fictional operator",
    state: "connected",
    lastObservedAt: "2026-08-20T07:30:00.000Z",
    freshForSeconds: 3600,
  }] };
  try {
    await Promise.all([writeCatalog(catalogDirectory), mkdir(selectedRoot)]);
    await writeFile(path.join(selectedRoot, "package.json"), `${JSON.stringify({
      name: "safe-name",
      scripts: { start: `${secretPrefix}this-value-must-never-appear` },
    })}\n`);
    const plan = (await runOnboard(root, [
      "--sources", "railway", "--root", selectedRoot, "--host-id", "reviewed-host", "--json",
    ], {
      paths: externalPaths(temporary, catalogDirectory),
      environment: {},
      platform: process.platform,
      hostname: `${secretPrefix}host-secret-shaped-value`,
      now: NOW,
      runtimeVersion: "0.7.0-alpha.2",
      profileDocument,
      planning: quietPlanning(temporary),
      connectors: [{ connectorId: "railway", collect() { return { state: "connected", observedAt: NOW, observations: [] }; } }],
      resolveCredential() { return "ephemeral-secret-value"; },
    })).plan;
    const json = JSON.stringify(plan);
    const human = formatOnboardPlan(plan);

    assert.ok(Buffer.byteLength(json) <= ONBOARD_MAX_PLAN_BYTES);
    assert.equal(plan.provenance.hostSuggestion.name, "This computer");
    for (const hidden of [temporary, selectedRoot, "internal-railway-profile", "PRIVATE_RAILWAY_LOCATOR", "ephemeral-secret-value", `${secretPrefix}this-value-must-never-appear`]) {
      assert.doesNotMatch(json, new RegExp(hidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(human, new RegExp(hidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.doesNotMatch(human, /[{}]|"command"|locator|absolute path/i);
    assert.equal(plan.safety.absolutePathsReturned, false);
    assert.equal(plan.safety.credentialValuesReturned, false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("authority and hostile CLI input fail closed before discovery or provider work", async () => {
  assert.throws(() => parseOnboardArguments(["--sources", "github,github"]), (error) => error.code === "onboard-arguments-invalid");
  assert.throws(() => parseOnboardArguments(["--sources", "cloudflare"]), (error) => error.code === "onboard-arguments-invalid");
  assert.throws(() => parseOnboardArguments(["--sources", "github", "--root", "relative/path"]), (error) => error.code === "onboard-arguments-invalid");
  assert.throws(() => parseOnboardArguments(["--sources", "github", "--task-observation", "relative.json"]), (error) => error.code === "onboard-arguments-invalid");
  assert.throws(() => parseOnboardArguments(["--sources", "github", "--apply"]), (error) => error.code === "onboard-arguments-invalid");
  const first = suggestOnboardHostIdentity({ platform: process.platform, hostname: "stable-host.example" });
  const second = suggestOnboardHostIdentity({ platform: process.platform, hostname: "stable-host.example" });
  assert.deepEqual(second, first);
  assert.match(first.id, /^stable-host-example-[a-f0-9]{10}$/);
});

test("CLI human preview uses stable external paths from an unrelated cwd and writes nothing", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-onboard-cli-"));
  const caller = path.join(temporary, "unrelated-cwd");
  try {
    await mkdir(caller);
    const catalogDirectory = path.join(temporary, "external-catalog");
    const profiles = path.join(temporary, "external-config/profiles.json");
    const generated = path.join(temporary, "external-generated");
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      cli, "onboard", "--sources", "github",
      "--catalog-dir", catalogDirectory,
      "--connection-profiles-file", profiles,
      "--generated-dir", generated,
    ], { cwd: caller, env: { ...process.env, DEVHUB_HOST_ID: "" }, timeout: 5_000 });
    assert.equal(stderr, "");
    assert.match(stdout, /^DevHub onboard preview sha256:/);
    assert.match(stdout, /Current diff: none\./);
    assert.doesNotMatch(stdout, new RegExp(temporary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.deepEqual(await readdir(caller), []);
    await assert.rejects(readdir(catalogDirectory), { code: "ENOENT" });
    await assert.rejects(readdir(generated), { code: "ENOENT" });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
