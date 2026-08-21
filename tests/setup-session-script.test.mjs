import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { validateSetupSessionArtifact } from "../lib/setup-state.mjs";
import {
  createCredentialResolver,
  createDefaultSetupConnectors,
  createLocalHostSetupConnector,
  runConnectedSetupSession,
} from "../scripts/setup-session.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "scripts/devhub.mjs");
const observedAt = "2026-08-13T12:00:00.000Z";

function profile(changes = {}) {
  return {
    version: 1,
    id: "this-computer",
    connectorId: "local-host",
    authorization: { method: "local-session" },
    scope: { hostId: "macbook-pro" },
    owner: "Example builder",
    state: "unknown",
    lastObservedAt: null,
    freshForSeconds: 3600,
    ...changes,
  };
}

test("local-host connector invokes exact one-shot inspection and normalizes reviewed results", async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const connector = createLocalHostSetupConnector({
    root,
    paths: { root: "/reviewed/catalog" },
    async inspect(registryRoot, hostId, options) {
      calls.push({ registryRoot, hostId, options });
      return {
        host: { id: hostId, name: "MacBook", kind: "mac", location: "local" },
        identity: { source: options.identitySource, verified: false },
        observedAt,
        sources: [{ type: "package-json", available: true, observations: 1 }],
        projectRepositories: [{ projectId: "example", hostId, source: "git-origin", repository: { provider: "github", owner: "example", name: "project" } }],
        serviceMatches: [{ projectId: "example", projectTitle: "Example", serviceId: "web", serviceName: "Web", runtime: "node", mode: "on-demand", source: "package-json", identifier: "dev", state: "stopped" }],
        unknowns: [{ projectId: "example", projectTitle: "Example", serviceId: "worker", serviceName: "Worker", runtime: "custom", mode: "on-demand", reason: "unsupported-runtime", message: "No bounded adapter." }],
      };
    },
  });
  const result = await runConnectedSetupSession(profile(), { now: observedAt, sessionId: "local-test", connectors: [connector], signal });
  assert.equal(result.results[0].state, "connected");
  assert.deepEqual(calls.map(({ registryRoot, hostId }) => ({ registryRoot, hostId })), [{ registryRoot: root, hostId: "macbook-pro" }]);
  assert.equal(calls[0].options.identitySource, "reviewed-connection-profile");
  assert.equal(calls[0].options.signal, signal);
  assert.deepEqual(result.results[0].evidence.observations[0], {
    kind: "host-identity",
    id: "macbook-pro",
    name: "MacBook",
    hostKind: "mac",
    location: "local",
    identitySource: "reviewed-connection-profile",
    identityVerified: false,
  });
  const validated = validateSetupSessionArtifact(result, profile(), { now: observedAt });
  assert.equal(validated.results[0].observations.length, 5);
  const repository = result.results[0].evidence.observations.find((item) => item.kind === "project-repository");
  assert.deepEqual(repository, {
    kind: "project-repository",
    projectId: "example",
    hostId: "macbook-pro",
    source: "git-origin",
    repository: { provider: "github", owner: "example", name: "project" },
  });
  assert.doesNotMatch(JSON.stringify(repository), /workspace|remote|https?:\/\//);
  assert.equal(result.results[0].evidence.observations.some((item) => item.kind === "service-runtime"), true);
  assert.equal(result.results[0].evidence.observations.some((item) => item.kind === "service-runtime-unknown"), true);
});

test("local-host connector rejects broadened scope", async () => {
  const connector = createLocalHostSetupConnector({ root, inspect: async () => assert.fail("inspection must not run") });
  const result = await runConnectedSetupSession(profile({ scope: { hostId: "macbook-pro", scan: true } }), {
    now: observedAt,
    sessionId: "local-invalid",
    connectors: [connector],
  });
  assert.equal(result.results[0].state, "unknown");
});

test("credential resolver supports environment, macOS Keychain and 1Password with exact bounded commands", async () => {
  const calls = [];
  const resolver = createCredentialResolver({
    environment: { RAILWAY_TOKEN: "environment-value" },
    async run(command, args, options) {
      calls.push({ command, args, options });
      return { stdout: `${command}-value\n` };
    },
  });
  assert.equal(await resolver({ kind: "environment", locator: "RAILWAY_TOKEN" }), "environment-value");
  assert.equal(await resolver({ kind: "keychain", locator: "generic-password:devhub:railway" }), "security-value");
  assert.equal(await resolver({ kind: "secret-manager", locator: "op://DevHub/Railway/token" }), "op-value");
  assert.deepEqual(calls.map(({ command, args }) => ({ command, args })), [
    { command: "security", args: ["find-generic-password", "-w", "-s", "devhub", "-a", "railway"] },
    { command: "op", args: ["read", "--no-newline", "op://DevHub/Railway/token"] },
  ]);
  assert.equal(calls[0].options.timeout, 15_000);
  assert.equal(calls[1].options.timeout, 5_000);
  assert.ok(calls.every(({ options }) => options.shell === false && options.maxBuffer === 65_536));
  assert.equal(await resolver({ kind: "keychain", locator: "bad locator" }), undefined);
  assert.equal(await resolver({ kind: "secret-manager", locator: "vault/item/field" }), undefined);
});

test("Connected Setup gives Keychain its bounded runtime window without echoing the credential", async () => {
  const runtimeCredential = "fictional-keychain-runtime-value-never-returned";
  const commandCalls = [];
  const openAIProfile = {
    version: 1,
    id: "openai-example-project",
    connectorId: "openai",
    authorization: {
      method: "secret-reference",
      credentialRef: { kind: "keychain", locator: "generic-password:devhub:openai-admin" },
    },
    scope: {
      kind: "project",
      id: "proj_fictional_pocket_ops",
      parent: { kind: "workspace", id: "org_fictional_studio" },
    },
    owner: "Example operator",
    state: "authorization-required",
    lastObservedAt: null,
    freshForSeconds: 3600,
  };
  const connector = {
    connectorId: "openai",
    validateProfile() {},
    async collect({ credential, now }) {
      assert.equal(credential, runtimeCredential);
      return {
        state: "connected",
        observedAt: now,
        message: "The exact reviewed project was verified.",
        observations: [],
      };
    },
  };

  const result = await runConnectedSetupSession(openAIProfile, {
    now: observedAt,
    sessionId: "openai-keychain-runtime-test",
    connectors: [connector],
    environment: {},
    async runCredentialCommand(command, args, options) {
      commandCalls.push({ command, args, options });
      return { stdout: `${runtimeCredential}\n` };
    },
  });

  assert.equal(result.results[0].state, "connected");
  assert.deepEqual(commandCalls.map(({ command, args }) => ({ command, args })), [{
    command: "security",
    args: ["find-generic-password", "-w", "-s", "devhub", "-a", "openai-admin"],
  }]);
  assert.equal(commandCalls[0].options.timeout, 15_000);
  assert.equal(commandCalls[0].options.maxBuffer, 65_536);
  assert.equal(commandCalls[0].options.shell, false);
  assert.equal(JSON.stringify(commandCalls).includes(runtimeCredential), false);
  assert.equal(JSON.stringify(result).includes(runtimeCredential), false);
});

test("default GitHub transport delegates exact gh API arguments without shell syntax", async () => {
  const calls = [];
  const connectors = createDefaultSetupConnectors({
    runGh: async (args, options) => {
      calls.push({ args, options });
      if (args.at(-1) === "/user") return { stdout: JSON.stringify({ id: 1, login: "example", type: "User" }) };
      return { stdout: "[]" };
    },
    inspectHost: async () => assert.fail("local inspection must not run"),
  });
  const github = profile({
    id: "github-example",
    connectorId: "github",
    authorization: { method: "cli-session" },
    scope: { kind: "user", login: "example" },
  });
  const result = await runConnectedSetupSession(github, { now: observedAt, sessionId: "github-test", connectors });
  assert.equal(result.results[0].state, "connected");
  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ args }) => args[0] === "api" && args[1] === "--method" && args[2] === "GET"));
  assert.ok(calls.every(({ args }) => args.length === 8 && args.at(-1).startsWith("/")));
  assert.ok(calls.every(({ options }) => options.signal instanceof AbortSignal && Number.isInteger(options.maxBuffer)));
});

test("CLI setup-session accepts reviewed JSON and remains read-only and non-persistent", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-setup-session-"));
  const filename = path.join(temporary, "profiles.json");
  await writeFile(filename, JSON.stringify(profile({
    id: "github-example",
    connectorId: "github",
    authorization: { method: "cli-session" },
    scope: { kind: "user", login: "example" },
  })));
  const { stdout, stderr } = await execFileAsync(process.execPath, [cli, "setup-session", filename, "--json"], {
    cwd: root,
    env: { ...process.env, PATH: "" },
  });
  assert.equal(stderr, "");
  const result = JSON.parse(stdout);
  assert.equal(result.command, "setup-session");
  assert.equal(result.readOnly, true);
  assert.equal(result.persistent, false);
  assert.equal(result.results[0].state, "unknown");
});
