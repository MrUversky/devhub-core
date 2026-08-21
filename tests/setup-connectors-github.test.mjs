import assert from "node:assert/strict";
import test from "node:test";

import {
  createGitHubAuthorizedTransport,
  createGitHubGhSessionTransport,
  createGitHubSetupConnector,
  createGitHubSetupSessionConnector,
  validateGitHubSetupScope,
} from "../lib/setup-connectors/github.mjs";
import { runSetupSession } from "../lib/setup-session.mjs";

const NOW = "2026-08-13T12:00:00.000Z";
const limits = Object.freeze({
  maxRepositories: 3,
  maxPages: 4,
  deadlineMs: 1_000,
  maxResponseBytes: 100_000,
});

function authorization(method = "cli-session") {
  return {
    method,
    reference: method === "cli-session" ? "gh:current" : "github-app:installation-42",
    state: "reviewed",
  };
}

function repository(id, owner, name, overrides = {}) {
  return {
    id,
    owner: { login: owner },
    name,
    full_name: `${owner}/${name}`,
    html_url: `https://github.com/${owner}/${name}`,
    visibility: "private",
    private: true,
    archived: false,
    disabled: false,
    permissions: { pull: true, push: true, admin: false },
    description: "raw provider field must not survive",
    ...overrides,
  };
}

function injectedGh(responses, calls = []) {
  return async (args, options) => {
    calls.push({ args, options });
    const path = args.at(-1);
    const value = responses.get(path);
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error(`fixture missing: ${path}`);
    return { stdout: JSON.stringify(value) };
  };
}

function request(scope, overrides = {}) {
  return {
    provider: "github",
    scope,
    authorization: authorization(),
    now: NOW,
    limits,
    ...overrides,
  };
}

test("existing gh session discovers one explicit user scope without reading or returning a token", async () => {
  const calls = [];
  const responses = new Map([
    ["/user", { id: 41, login: "octo-builder", type: "User", email: "private@example.test" }],
    ["/user/repos?affiliation=owner&sort=full_name&direction=asc&per_page=100&page=1", [
      repository(101, "octo-builder", "private-app"),
      repository(102, "octo-builder", "public-tool", { visibility: "public", private: false, permissions: { pull: true } }),
    ]],
  ]);
  const transport = createGitHubGhSessionTransport({ runGh: injectedGh(responses, calls) });
  const connector = createGitHubSetupConnector({ transport });
  const result = await connector.collect(request({ kind: "user", login: "octo-builder" }));

  assert.equal(result.status, "success");
  assert.deepEqual(result.identity, { providerId: "41", login: "octo-builder", kind: "user" });
  assert.equal(result.scope.kind, "user");
  assert.deepEqual(result.repositories.map((item) => item.fullName), [
    "octo-builder/private-app",
    "octo-builder/public-tool",
  ]);
  assert.deepEqual(result.repositories.map((item) => item.access), ["write", "read"]);
  assert.ok(result.repositories.every((item) => item.ownership === "unknown"));
  assert.ok(result.exactEvidence.some((item) => item.adapterId === "github-actions-deployment-v1"));
  assert.ok(result.exactEvidence.some((item) => item.adapterId === "github-release-deployment-v1"));
  assert.ok(result.exactEvidence.some((item) => item.adapterId === "github-actions-workflow-monitoring-v1"));
  assert.equal(result.safety.credentialsStored, false);
  assert.equal(result.safety.rawPayloadsRetained, false);
  assert.equal(JSON.stringify(result).includes("private@example.test"), false);
  assert.ok(calls.every((call) => call.args[0] === "api" && call.args.includes("--method") && call.args.includes("GET")));
  assert.ok(calls.every((call) => !call.args.some((value) => /token|authorization|bearer/i.test(value))));
});

test("organization collection validates the reviewed scope and rejects repositories from another owner", async () => {
  const responses = new Map([
    ["/user", { id: 41, login: "octo-builder", type: "User" }],
    ["/orgs/acme-example", { id: 42, login: "acme-example" }],
    ["/orgs/acme-example/repos?type=all&sort=full_name&direction=asc&per_page=100&page=1", [
      repository(101, "different-org", "private-app"),
    ]],
  ]);
  const connector = createGitHubSetupConnector({
    transport: createGitHubGhSessionTransport({ runGh: injectedGh(responses) }),
  });
  const result = await connector.collect(request({ kind: "organization", login: "acme-example" }));

  assert.equal(result.status, "unavailable");
  assert.equal(result.state, "unknown");
  assert.equal(result.reason, "provider-identity-mismatch");
  assert.deepEqual(result.repositories, []);
});

test("an injected reviewed GitHub App transport produces the same normalized organization result", async () => {
  const values = new Map([
    ["/user", { id: 41, login: "octo-builder", type: "User" }],
    ["/orgs/acme-example", { id: 42, login: "acme-example" }],
    ["/orgs/acme-example/repos?type=all&sort=full_name&direction=asc&per_page=100&page=1", [
      repository(101, "acme-example", "private-app"),
    ]],
  ]);
  const transport = createGitHubAuthorizedTransport({
    method: "github-app",
    request: async (path) => ({ status: "success", body: JSON.stringify(values.get(path)) }),
  });
  const connector = createGitHubSetupConnector({ transport });
  const result = await connector.collect(request(
    { kind: "organization", login: "acme-example" },
    { authorization: authorization("github-app") },
  ));

  assert.equal(result.status, "success");
  assert.deepEqual(result.scope, { kind: "organization", login: "acme-example", providerId: "42" });
  assert.equal(result.repositories[0].fullName, "acme-example/private-app");
  assert.equal(result.authorization.reference, "github-app:installation-42");
});

test("GitHub transport failures remain safely classified without raw error leakage", async (t) => {
  for (const [name, failure, state, reason, action] of [
    ["partial", Object.assign(new Error("stdout maxBuffer exceeded"), { stderr: "oversized" }), "unknown", "provider-response-too-large", "retry-github"],
    ["rate-limited", Object.assign(new Error("HTTP 429"), { stderr: "secondary rate limit" }), "unknown", "provider-rate-limited", "retry-github-later"],
    ["access-denied", Object.assign(new Error("HTTP 403"), { stderr: "resource not accessible" }), "unknown", "provider-access-denied", "reconnect-github"],
    ["authorization", Object.assign(new Error("gh failed"), { stderr: "To get started with GitHub CLI, run: gh auth login" }), "authorization-required", "authorization-required", "reconnect-github"],
    ["network", Object.assign(new Error("request failed"), { stderr: "Could not resolve host: api.github.com" }), "unknown", "provider-network-unavailable", "retry-github-network"],
  ]) {
    await t.test(name, async () => {
      const connector = createGitHubSetupConnector({
        transport: createGitHubGhSessionTransport({ runGh: async () => { throw failure; } }),
      });
      const result = await connector.collect(request({ kind: "user", login: "octo-builder" }));
      assert.equal(result.status, "unavailable");
      assert.equal(result.state, state);
      assert.equal(result.reason, reason);
      assert.equal(result.nextAction.id, action);
      assert.deepEqual(result.repositories, []);
      assert.equal(JSON.stringify(result).includes(failure.message), false);
      assert.equal(JSON.stringify(result).includes(failure.stderr), false);
    });
  }
});

test("bounded collection fails closed instead of returning a partial repository list", async () => {
  const hundred = Array.from({ length: 100 }, (_, index) => repository(index + 1, "octo-builder", `app-${index}`));
  const responses = new Map([
    ["/user", { id: 41, login: "octo-builder", type: "User" }],
    ["/user/repos?affiliation=owner&sort=full_name&direction=asc&per_page=100&page=1", hundred],
    ["/user/repos?affiliation=owner&sort=full_name&direction=asc&per_page=100&page=2", [repository(101, "octo-builder", "last-app")]],
  ]);
  const connector = createGitHubSetupConnector({
    transport: createGitHubGhSessionTransport({ runGh: injectedGh(responses) }),
  });
  const result = await connector.collect(request(
    { kind: "user", login: "octo-builder" },
    { limits: { ...limits, maxRepositories: 100 } },
  ));

  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "provider-observation-partial");
  assert.deepEqual(result.repositories, []);
});

test("scope and authorization descriptors are strict and never establish ownership", async () => {
  assert.equal(validateGitHubSetupScope({ kind: "user", login: "octo-builder" }), true);
  assert.equal(validateGitHubSetupScope({ kind: "account", login: "octo-builder" }), false);
  assert.equal(validateGitHubSetupScope({ kind: "organization", login: "octo-builder", all: true }), false);

  const connector = createGitHubSetupConnector({
    transport: createGitHubGhSessionTransport({ runGh: async () => { throw new Error("must not run"); } }),
  });
  const result = await connector.collect(request(
    { kind: "user", login: "octo-builder" },
    { authorization: { method: "cli-session", reference: "token=secret-value", state: "reviewed" } },
  ));
  assert.equal(result.reason, "authorization-required");
  assert.equal(result.state, "authorization-required");
});

test("GitHub connector runs through the generic setup session contract", async () => {
  const responses = new Map([
    ["/user", { id: 41, login: "octo-builder", type: "User" }],
    ["/user/repos?affiliation=owner&sort=full_name&direction=asc&per_page=100&page=1", [
      repository(101, "octo-builder", "private-app"),
    ]],
  ]);
  const setupConnector = createGitHubSetupSessionConnector({
    transport: createGitHubGhSessionTransport({ runGh: injectedGh(responses) }),
    limits,
  });
  const result = await runSetupSession({
    version: 1,
    profiles: [{
      version: 1,
      id: "github-personal",
      connectorId: "github",
      authorization: { method: "cli-session" },
      scope: { kind: "user", login: "octo-builder" },
      owner: "Example builder",
      state: "unknown",
      freshForSeconds: 3600,
    }],
  }, {
    now: NOW,
    sessionId: "fixture-session",
    connectors: [setupConnector],
  });

  assert.equal(result.status, "complete");
  assert.equal(result.results[0].state, "connected");
  const observations = result.results[0].evidence.observations;
  assert.ok(observations.some((item) => item.kind === "repository-candidate" && item.fullName === "octo-builder/private-app"));
  assert.ok(observations.some((item) => item.kind === "provider-limitation" && item.code === "ownership" && item.state === "unknown"));
  assert.doesNotMatch(JSON.stringify(result), /raw provider field|token=|authorization:/i);
});
