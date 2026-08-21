import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  buildConnectedSetupAgentPrompt,
  CONNECTED_SETUP_STEPS,
  CONNECTOR_CATALOG,
  validateConnectorCatalog,
} from "../lib/connectors.mjs";
import { createConnectedSetup, formatConnectedSetup } from "../scripts/connected-setup.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "scripts/devhub.mjs");

async function temporaryProbeChild(source) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "devhub-marker-probe-child-"));
  const filename = path.join(directory, "probe-child.mjs");
  await writeFile(filename, source);
  return { directory, filename };
}

function fixtureProbes() {
  const inspected = [];
  return {
    inspected,
    access: async (filename) => {
      inspected.push({ kind: "cli", filename });
      if (!["/fixture/bin/gh", "/fixture/bin/docker"].includes(filename)) throw Object.assign(new Error("absent"), { code: "ENOENT" });
    },
    lstat: async (filename) => {
      inspected.push({ kind: "filesystem", filename });
      if (!["/fixture/project/.git/config", "/fixture/project/package.json"].includes(filename)) throw Object.assign(new Error("absent"), { code: "ENOENT" });
      return { isFile: () => true };
    },
  };
}

test("connected setup deterministically overlays local markers onto the canonical connector catalog", async () => {
  const probes = fixtureProbes();
  const options = {
    cwd: "/fixture/project",
    homeDirectory: "/fixture/home",
    pathValue: "/fixture/bin",
    platform: "darwin",
    access: probes.access,
    lstat: probes.lstat,
  };
  const first = await createConnectedSetup(options);
  const second = await createConnectedSetup({ ...options, ...fixtureProbes() });

  assert.deepEqual(first, second);
  assert.equal(first.command, "setup");
  assert.equal(first.readOnly, true);
  assert.equal(first.selectedOnly, false);
  assert.deepEqual(first.safety, {
    localMarkersOnly: true,
    credentialsRead: false,
    configContentsRead: false,
    commandsExecuted: false,
    networkAccess: false,
    catalogWrites: false,
    markerIsolation: "injected-library-probes",
  });
  assert.equal(first.connectors.length, 15);
  assert.deepEqual(first.recommendedConnectors, ["github", "local-host", "vercel", "railway", "sentry", "openai"]);
  assert.ok(first.connectors.filter((item) => item.availability === "planned").every((item) => item.roadmap?.milestone));
  assert.equal(first.connectors.find((item) => item.id === "github").detection.state, "detected");
  assert.equal(first.connectors.find((item) => item.id === "local-host").detection.state, "detected");
  assert.equal(first.connectors.find((item) => item.id === "openai").detection.state, "not-detectable");
  assert.equal(first.connectors.find((item) => item.id === "railway").availability, "available");
  const githubConnection = first.connectors.find((item) => item.id === "github").connection;
  assert.deepEqual(Object.keys(githubConnection), ["method", "alternatives", "summary", "implementedOnboarding", "nextStep"]);
  assert.equal(githubConnection.method, "secret-reference");
  assert.deepEqual(githubConnection.alternatives, ["github-app", "cli-session", "anonymous"]);
  assert.match(githubConnection.summary, /advertised by the connector catalog[\s\S]*do not prove an implemented/i);
  assert.deepEqual(githubConnection.implementedOnboarding, {
    acquisition: "existing-session",
    title: "Connect GitHub",
    summary: "Choose the GitHub account or organization you recognize.",
  });
  assert.deepEqual(first.connectors.find((item) => item.id === "vercel").connection.implementedOnboarding, {
    acquisition: "secure-stored-access",
    title: "Connect Vercel",
    summary: "Choose the Vercel account or team you recognize.",
  });
  assert.deepEqual(first.connectors.find((item) => item.id === "openai").connection.implementedOnboarding, {
    acquisition: "secure-stored-access",
    title: "Connect OpenAI",
    summary: "Choose the OpenAI workspace and project you recognize.",
  });
  assert.equal(first.connectors.find((item) => item.id === "sentry").connection.implementedOnboarding, null);
  assert.equal(first.connectors.find((item) => item.id === "cloudflare").connection.implementedOnboarding, null);
  assert.equal(first.connectors.find((item) => item.id === "vercel").availability, "available");
  assert.deepEqual(first.connectors.find((item) => item.id === "vercel").capabilities, ["inventory", "deployments", "environments", "domains"]);
  assert.deepEqual(first.connectors.find((item) => item.id === "sentry").capabilities, ["deployments", "monitoring"]);
  assert.deepEqual(first.buildMyMap.steps.map((step) => step.id), ["connect-tools", "build-my-map", "review-unclear", "done"]);
  assert.deepEqual(first.nextActions.map((action) => action.id), ["refresh-my-devhub", "connect-another-source"]);

  const human = formatConnectedSetup(first);
  assert.match(human, /GitHub:[\s\S]*Advertised methods: secret-reference, github-app, cli-session, anonymous\.[\s\S]*Implemented setup: existing-session/);
  assert.match(human, /Sentry:[\s\S]*Implemented setup: not available/);
  assert.doesNotMatch(human, /Connect via secret-reference|supported connection method/i);

  const inspected = probes.inspected.map((item) => item.filename).join("\n");
  assert.doesNotMatch(inspected, /token|secret|credential|\.env/i);
});

test("selected setup planning probes only available canonical sources while standalone planning remains complete", async () => {
  const inspected = [];
  const result = await createConnectedSetup({
    selectedConnectorIds: ["github"],
    cwd: "/fixture/project",
    homeDirectory: "/fixture/home",
    pathValue: "/fixture/bin",
    platform: "darwin",
    deadlineMs: 100,
    access: async (filename) => {
      inspected.push(filename);
      throw Object.assign(new Error("absent"), { code: "ENOENT" });
    },
    lstat: async (filename) => {
      inspected.push(filename);
      if (/\.vercel|railway|package\.json|compose\.yaml/.test(filename)) return new Promise(() => {});
      throw Object.assign(new Error("absent"), { code: "ENOENT" });
    },
  });

  assert.equal(result.selectedOnly, true);
  assert.equal(result.execution.state, "complete");
  assert.deepEqual(result.connectors.map((connector) => connector.id), ["github"]);
  assert.deepEqual(inspected, ["/fixture/bin/gh", "/fixture/project/.git/config"]);
  await assert.rejects(createConnectedSetup({ selectedConnectorIds: ["github", "github"] }), /must be unique/);
  await assert.rejects(createConnectedSetup({ selectedConnectorIds: ["not-real"] }), /available canonical/);
  await assert.rejects(createConnectedSetup({ selectedConnectorIds: ["cloudflare"] }), /available canonical/);
});

test("connected setup keeps the two-step UI handoff separate from four bounded runner stages", async () => {
  assert.deepEqual(CONNECTED_SETUP_STEPS.map((step) => step.id), ["choose-sources", "run-with-agent"]);
  const setup = await createConnectedSetup({
    cwd: "/fixture/project",
    homeDirectory: "/fixture/home",
    pathValue: "",
    platform: "darwin",
    access: async () => { throw new Error("absent"); },
    lstat: async () => { throw new Error("absent"); },
  });
  assert.deepEqual(setup.buildMyMap.steps.map((step) => step.id), ["connect-tools", "build-my-map", "review-unclear", "done"]);
});

test("agent handoff prompt is short, human and selected-only", () => {
  const prompt = buildConnectedSetupAgentPrompt(["local-host", "github"]);
  assert.ok(prompt.length >= 400 && prompt.length <= 900, `prompt length ${prompt.length}`);
  assert.ok(prompt.split("\n").length <= 6);
  assert.match(prompt, /selected sources: GitHub, This computer\./);
  assert.match(prompt, /configured DevHub workflow/i);
  assert.match(prompt, /Selection authorizes safe read-only checks through callable plugins, existing sign-ins, and this computer/i);
  assert.match(prompt, /Run them before asking how to connect/i);
  assert.match(prompt, /Stay within the selected sources and scopes/i);
  assert.match(prompt, /With one scope, continue; with several, ask one plain-language choice/i);
  assert.match(prompt, /Saving is optional and comes only after results/i);
  assert.match(prompt, /Never request or expose secrets, MFA codes, or setup internals/i);
  assert.match(prompt, /Run this task on the computer you want DevHub to inspect/i);
  assert.match(prompt, /minimal reviewed connection-profile and catalog diff, or a draft pull request, with validation results/i);
  assert.match(prompt, /Do not mutate providers, make hidden catalog changes, merge, or deploy/i);
  assert.match(prompt, /dashboard changes only after the reviewed change is merged and deployed/i);
  assert.doesNotMatch(prompt, /\(github\)|local-host|Railway|Vercel|OpenAI/i);
  assert.doesNotMatch(prompt, /--json|setup-run|connection-review|reviewId|questionId|answerSchema|schema|locator|connectionProfileProposals|profile proposal|artifact|preflight|guidedConnection|stdout/i);
  assert.equal(prompt, buildConnectedSetupAgentPrompt(["github", "local-host"]));
  assert.throws(() => buildConnectedSetupAgentPrompt([]), /at least one selected source/);
  assert.throws(() => buildConnectedSetupAgentPrompt(["github", "github"]), /unique strings/);
  assert.throws(() => buildConnectedSetupAgentPrompt(["cloudflare"]), /only available canonical sources/);
  assert.throws(() => buildConnectedSetupAgentPrompt(["not-real"]), /only available canonical sources/);
});

test("agent handoff names every selected provider without exposing execution internals", () => {
  const prompt = buildConnectedSetupAgentPrompt(["openai", "railway", "vercel", "github", "local-host"]);
  assert.ok(prompt.length >= 400 && prompt.length <= 900, `prompt length ${prompt.length}`);
  assert.match(prompt, /selected sources: GitHub, This computer, Vercel, Railway, OpenAI\./);
  assert.equal(prompt.length, 899);
  assert.match(prompt, /safe read-only checks through callable plugins/i);
  assert.match(prompt, /With one scope, continue; with several, ask one plain-language choice/i);
  assert.match(prompt, /Saving is optional and comes only after results/i);
  assert.match(prompt, /Run this task on the computer you want DevHub to inspect/i);
  assert.doesNotMatch(prompt, /--json|setup-run|connection-review|reviewId|questionId|schema|locator|profile proposal|internal review|artifact|preflight|guidedConnection|stdout/i);
  assert.doesNotMatch(prompt, /cloudflare|sentry|stripe/i);
});

test("agent handoff delegates binding-only details while planned sources remain unselectable", () => {
  const prompt = buildConnectedSetupAgentPrompt(["sentry"]);
  assert.match(prompt, /selected sources: Sentry\./);
  assert.match(prompt, /configured DevHub workflow/i);
  assert.doesNotMatch(prompt, /binding|inventory|evidence|guidedConnection|setup-run|--json/i);
  assert.throws(() => buildConnectedSetupAgentPrompt(["cloudflare"]), /only available canonical sources/);
});

test("connected setup fails closed when local markers are absent or unreadable", async () => {
  const result = await createConnectedSetup({
    cwd: "/fixture/project",
    homeDirectory: "/fixture/home",
    pathValue: "",
    platform: "darwin",
    access: async () => { throw new Error("denied"); },
    lstat: async () => { throw new Error("denied"); },
  });
  assert.ok(result.connectors.every((connector) => ["not-detected", "not-detectable"].includes(connector.detection.state)));
  assert.ok(result.connectors.every((connector) => connector.detection.evidence.every((evidence) => evidence.state === "absent")));
  assert.ok(result.connectors.every((connector) => connector.connection.nextStep.length > 0));
});

test("connected setup planning is bounded when a filesystem probe never settles", async () => {
  const startedAt = Date.now();
  const result = await createConnectedSetup({
    cwd: "/fixture/project",
    homeDirectory: "/fixture/home",
    pathValue: "",
    platform: "darwin",
    deadlineMs: 100,
    access: async () => { throw new Error("absent"); },
    lstat: async () => new Promise(() => {}),
  });
  assert.equal(result.execution.state, "partial");
  assert.equal(result.execution.reason, "planning-deadline-exceeded");
  assert.ok(result.connectors.some((connector) => connector.detection.state === "unknown"));
  assert.ok(Date.now() - startedAt < 1_000, "planning must return within its bounded deadline");
});

test("default marker planning kills and reaps a hostile child before returning, three times", async () => {
  const hostile = await temporaryProbeChild(`
    process.on("SIGTERM", () => {});
    process.stdin.resume();
    setInterval(() => {}, 10_000);
  `);
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const startedAt = Date.now();
      const result = await createConnectedSetup({
        cwd: "/fixture/project",
        homeDirectory: "/fixture/home",
        pathValue: "/fixture/bin",
        platform: "darwin",
        deadlineMs: 100,
        probeChildPath: hostile.filename,
      });
      assert.equal(result.execution.state, "partial");
      assert.equal(result.execution.reason, "planning-deadline-exceeded");
      assert.equal(result.safety.markerIsolation, "dedicated-child-process");
      assert.ok(result.connectors.every((connector) => connector.detection.evidence.every((item) => item.state === "unknown")));
      assert.ok(Date.now() - startedAt < 2_000, "the hostile child must stay within the explicit process cleanup bound");
    }
  } finally {
    await rm(hostile.directory, { recursive: true, force: true });
  }
});

test("invalid isolated output is a canonical all-unknown partial plan", async () => {
  const invalid = await temporaryProbeChild(`
    for await (const _chunk of process.stdin) {}
    process.stdout.write("not-json\\n");
  `);
  try {
    const result = await createConnectedSetup({
      cwd: "/fixture/project",
      homeDirectory: "/fixture/home",
      pathValue: "/fixture/bin",
      platform: "darwin",
      probeChildPath: invalid.filename,
    });
    assert.equal(result.execution.state, "partial");
    assert.equal(result.execution.reason, "planning-probe-unavailable");
    assert.ok(result.connectors.every((connector) => connector.detection.evidence.every((item) => item.state === "unknown")));
  } finally {
    await rm(invalid.directory, { recursive: true, force: true });
  }
});

test("external planning abort remains distinct and waits for hostile child cleanup", async () => {
  const hostile = await temporaryProbeChild(`
    process.on("SIGTERM", () => {});
    process.stdin.resume();
    setInterval(() => {}, 10_000);
  `);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 50);
  try {
    const result = await createConnectedSetup({
      cwd: "/fixture/project",
      homeDirectory: "/fixture/home",
      pathValue: "/fixture/bin",
      platform: "darwin",
      deadlineMs: 5_000,
      signal: controller.signal,
      probeChildPath: hostile.filename,
    });
    assert.equal(result.execution.state, "partial");
    assert.equal(result.execution.reason, "planning-aborted");
    assert.ok(result.connectors.every((connector) => connector.detection.evidence.every((item) => item.state === "unknown")));
  } finally {
    clearTimeout(timeout);
    await rm(hostile.directory, { recursive: true, force: true });
  }
});

test("connector catalog validation rejects unsupported states, auth and unsafe markers", () => {
  const base = CONNECTOR_CATALOG[0];
  const altered = (changes) => [{ ...base, ...changes }];
  assert.throws(() => validateConnectorCatalog(altered({ stage: "connected" })), /invalid stage/);
  assert.throws(() => validateConnectorCatalog(altered({ stage: "planned" })), /roadmap milestone/);
  assert.throws(() => validateConnectorCatalog(altered({ roadmap: { milestone: "v9.9", theme: "future" } })), /cannot declare a future roadmap/);
  assert.throws(() => validateConnectorCatalog(altered({ category: "everything" })), /invalid category/);
  assert.throws(() => validateConnectorCatalog(altered({ auth: [] })), /authorization method/);
  assert.throws(() => validateConnectorCatalog(altered({ auth: ["password"] })), /authorization method/);
  assert.throws(() => validateConnectorCatalog(altered({ detection: { commands: ["gh --all"], markers: [] } })), /unsafe command/);
  assert.throws(() => validateConnectorCatalog(altered({ detection: { commands: [], markers: ["../.env"] } })), /unsafe filesystem/);
});

test("CLI setup returns a non-mutating machine-readable Build-my-map plan", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [cli, "setup", "--json"], { cwd: root });
  assert.equal(stderr, "");
  const result = JSON.parse(stdout);
  assert.equal(result.command, "setup");
  assert.equal(result.readOnly, true);
  assert.equal(result.safety.credentialsRead, false);
  assert.equal(result.safety.commandsExecuted, false);
  assert.ok(result.connectors.every((connector) => connector.connection.method && Array.isArray(connector.connection.alternatives) && connector.connection.summary && connector.connection.nextStep));
  assert.deepEqual(result.connectors.find((connector) => connector.id === "github").connection.implementedOnboarding?.acquisition, "existing-session");
  assert.equal(result.connectors.find((connector) => connector.id === "sentry").connection.implementedOnboarding, null);
  assert.doesNotMatch(stdout, /ghp_[A-Za-z0-9]|sk-[A-Za-z0-9]|Bearer\s+[A-Za-z0-9]/);
});

test("CLI setup rejects unsupported options without probing or writing", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [cli, "setup", "--apply", "--json"], { cwd: root }),
    (error) => {
      const result = JSON.parse(error.stdout);
      return error.code === 3
        && result.error.code === "setup-arguments-invalid"
        && result.readOnly === true;
    },
  );
});
