import assert from "node:assert/strict";
import test from "node:test";

import {
  parseConnectionProfileDocument,
  runSetupSession,
  validateConnectionProfile,
} from "../lib/setup-session.mjs";

const now = "2026-08-13T12:00:00.000Z";

function railwayProfile(changes = {}) {
  return {
    version: 1,
    id: "railway-business",
    connectorId: "railway",
    authorization: { method: "secret-reference", credentialRef: { kind: "environment", locator: "RAILWAY_TOKEN" } },
    scope: { workspaceId: "workspace-1", projectId: "project-1" },
    owner: "Business team",
    state: "authorization-required",
    lastObservedAt: null,
    freshForSeconds: 3600,
    ...changes,
  };
}

test("reviewed connection profiles are strict, immutable and contain references rather than values", () => {
  const profile = validateConnectionProfile(railwayProfile());
  assert.equal(Object.isFrozen(profile), true);
  assert.equal(Object.isFrozen(profile.scope), true);
  assert.equal(Object.isFrozen(profile.authorization.credentialRef), true);
  assert.throws(() => validateConnectionProfile(railwayProfile({ extra: true })), /not supported/);
  assert.throws(() => validateConnectionProfile(railwayProfile({ authorization: { method: "secret-reference" } })), /credentialRef is required/);
  assert.throws(() => validateConnectionProfile(railwayProfile({ scope: { ["to" + "ken"]: ["gh", "p_", "123456789012345678901234"].join("") } })), /not allowed/);
  assert.throws(() => validateConnectionProfile(railwayProfile({ scope: { note: ["s", "k-", "123456789012345678901234"].join("") } })), /secret material/);
  assert.throws(() => validateConnectionProfile(railwayProfile({ scope: { weight: Number.POSITIVE_INFINITY } })), /finite numbers/);
});

test("profile documents reject duplicate IDs and secret-shaped authorization metadata", () => {
  assert.throws(() => parseConnectionProfileDocument({ version: 1, profiles: [railwayProfile(), railwayProfile()] }), /duplicate connection profile/);
  assert.throws(() => validateConnectionProfile(railwayProfile({
    authorization: { method: "secret-reference", credentialRef: { kind: "keychain", locator: ["Bear", "er ", "abcdefghijklmnop"].join("") } },
  })), /secret material/);
});

test("session resolves one credential ephemerally and returns bounded reviewed metadata", async () => {
  let delivered;
  const result = await runSetupSession(railwayProfile(), {
    now,
    sessionId: "session-test",
    connectors: [{
      connectorId: "railway",
      validateProfile(profile) {
        assert.deepEqual(profile.scope, { workspaceId: "workspace-1", projectId: "project-1" });
      },
      collect({ credential }) {
        delivered = credential;
        return { state: "connected", observedAt: now, observations: [{ kind: "workspace", id: "workspace-1" }] };
      },
    }],
    resolveCredential(reference) {
      assert.deepEqual(reference, { kind: "environment", locator: "RAILWAY_TOKEN" });
      return "ephemeral-value-not-returned";
    },
  });

  assert.equal(delivered, "ephemeral-value-not-returned");
  assert.equal(result.status, "complete");
  assert.equal(result.readOnly, true);
  assert.equal(result.persistent, false);
  assert.equal(result.results[0].state, "connected");
  assert.deepEqual(result.results[0].reviewedConnection, {
    scope: { workspaceId: "workspace-1", projectId: "project-1" },
    owner: "Business team",
    authorization: { method: "secret-reference", credentialRef: { kind: "environment", locator: "RAILWAY_TOKEN" } },
    priorState: "authorization-required",
    priorObservedAt: null,
  });
  assert.doesNotMatch(JSON.stringify(result), /ephemeral-value-not-returned/);
  assert.deepEqual(result.safety, {
    catalogWrites: false,
    providerMutations: false,
    credentialValuesReturned: false,
    browserExecution: false,
    residentProcess: false,
  });
});

test("missing connectors cannot inherit a reviewed connected state", async () => {
  const result = await runSetupSession(railwayProfile({ state: "connected", lastObservedAt: "2026-08-13T11:59:00.000Z" }), {
    now,
    sessionId: "missing-connector",
  });
  assert.equal(result.results[0].state, "unavailable");
  assert.equal(result.results[0].reviewedConnection.priorState, "connected");
  assert.equal(result.results[0].observedAt, null);
});

test("an asynchronous profile validator is bounded by the session signal", async () => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 50);
  const startedAt = Date.now();
  try {
    const result = await runSetupSession(railwayProfile(), {
      now,
      sessionId: "bounded-validator",
      signal: controller.signal,
      connectors: [{
        connectorId: "railway",
        validateProfile(_profile, context) {
          assert.equal(context.signal, controller.signal);
          return new Promise(() => {});
        },
        collect() { assert.fail("collection must not run after the session deadline"); },
      }],
    });
    assert.equal(result.results[0].state, "unknown");
    assert.match(result.results[0].message, /overall setup-run deadline/i);
    assert.ok(Date.now() - startedAt < 500, "profile validation must not outlive the session signal");
  } finally {
    clearTimeout(timeout);
  }
});

test("resolver and connector failures are isolated per profile without leaking their errors", async () => {
  const profiles = {
    version: 1,
    profiles: [
      railwayProfile({ id: "resolver-fails" }),
      railwayProfile({ id: "connector-fails", authorization: { method: "secret-reference", credentialRef: { kind: "environment", locator: "OTHER_TOKEN" } } }),
    ],
  };
  const result = await runSetupSession(profiles, {
    now,
    sessionId: "failure-isolation",
    connectors: [{
      connectorId: "railway",
      collect({ profile }) {
        if (profile.id === "connector-fails") throw new Error(["gh", "p_", "123456789012345678901234"].join(""));
        return { state: "connected" };
      },
    }],
    resolveCredential(reference) {
      if (reference.locator === "RAILWAY_TOKEN") throw new Error(["s", "k-", "123456789012345678901234"].join(""));
      return "safe-ephemeral-value";
    },
  });
  assert.deepEqual(result.results.map((item) => item.state), ["authorization-required", "unknown"]);
  assert.doesNotMatch(JSON.stringify(result), /ghp_|sk-|safe-ephemeral-value/);
});

test("future, secret-bearing and stale connector observations fail closed", async () => {
  for (const [id, connectorResult, expected] of [
    ["future", { state: "connected", observedAt: "2026-08-13T12:00:01.000Z", observations: [] }, "unknown"],
    ["secret", { state: "connected", observedAt: now, observations: [{ note: ["github", "_pat_", "12345678901234567890"].join("") }] }, "unknown"],
    ["stale", { state: "connected", observedAt: "2026-08-13T10:00:00.000Z", observations: [] }, "stale"],
  ]) {
    const result = await runSetupSession(railwayProfile({ id, freshForSeconds: 3600 }), {
      now,
      sessionId: id,
      connectors: [{ connectorId: "railway", collect: () => connectorResult }],
      resolveCredential: () => "ephemeral",
    });
    assert.equal(result.results[0].state, expected);
  }
});

test("a connector cannot echo even a credential with no recognizable provider prefix", async () => {
  const result = await runSetupSession(railwayProfile({ id: "credential-echo" }), {
    now,
    sessionId: "credential-echo",
    connectors: [{
      connectorId: "railway",
      collect: ({ credential }) => ({ state: "connected", observedAt: now, observations: [{ note: credential }] }),
    }],
    resolveCredential: () => "ordinary-opaque-value",
  });
  assert.equal(result.results[0].state, "unknown");
  assert.doesNotMatch(JSON.stringify(result), /ordinary-opaque-value/);
});

test("connector messages preserve state while redacting reviewed profile metadata and secret-shaped text", async () => {
  const reviewed = railwayProfile({ id: "private-profile", owner: "Private billing owner" });
  for (const [label, leaked] of [
    ["profile id", reviewed.id],
    ["owner", reviewed.owner],
    ["scope", reviewed.scope.workspaceId],
    ["credential locator", reviewed.authorization.credentialRef.locator],
    ["secret-shaped text", ["s", "k-", "123456789012345678901234"].join("")],
  ]) {
    const result = await runSetupSession(reviewed, {
      now,
      sessionId: `redacted-${label.replaceAll(" ", "-")}`,
      connectors: [{
        connectorId: "railway",
        collect: () => ({ state: "connected", observedAt: now, message: `Checked ${leaked}`, observations: [] }),
      }],
      resolveCredential: () => "ordinary-opaque-value",
    });
    assert.equal(result.results[0].state, "connected", `${label} redaction must not hide the connector state`);
    assert.equal(result.results[0].message, "The bounded connector check completed.");
    assert.doesNotMatch(result.results[0].message, new RegExp(leaked.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
});

test("credential resolution accepts only bounded non-empty strings", async () => {
  for (const [id, value] of [["binary", Buffer.from("opaque")], ["oversized", "x".repeat((64 * 1024) + 1)]]) {
    let called = false;
    const result = await runSetupSession(railwayProfile({ id }), {
      now,
      sessionId: id,
      connectors: [{ connectorId: "railway", collect: () => { called = true; return { state: "connected" }; } }],
      resolveCredential: () => value,
    });
    assert.equal(result.results[0].state, "authorization-required");
    assert.equal(called, false);
  }
});
