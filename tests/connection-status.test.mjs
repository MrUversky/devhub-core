import assert from "node:assert/strict";
import test from "node:test";

import { createConnectionSnapshot } from "../lib/connection-snapshot.mjs";
import { resolveConnectorConnection } from "../lib/connection-status.mjs";
import { resolveInstancePresentation } from "../scripts/devhub-config.mjs";

const NOW = "2026-08-13T16:00:00.000Z";

function githubProfile(changes = {}) {
  return {
    version: 1,
    id: "github-personal",
    connectorId: "github",
    authorization: { method: "cli-session" },
    scope: { kind: "user", login: "example-builder" },
    owner: "Example builder",
    state: "connected",
    lastObservedAt: "2026-08-13T15:30:00.000Z",
    freshForSeconds: 3600,
    ...changes,
  };
}

test("connection snapshot preserves only redacted state and freshness", () => {
  const snapshot = createConnectionSnapshot({ version: 1, profiles: [githubProfile()] });
  assert.deepEqual(snapshot, {
    version: 1,
    source: "reviewed-profiles",
    profiles: [{
      connectorId: "github",
      state: "connected",
      lastObservedAt: "2026-08-13T15:30:00.000Z",
      validUntil: "2026-08-13T16:30:00.000Z",
    }],
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /example-builder|Example builder|authorization|scope|credential|locator/);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.profiles[0]), true);
});

test("fresh, stale and absent connections remain distinct", () => {
  const snapshot = createConnectionSnapshot({ version: 1, profiles: [githubProfile()] });
  assert.deepEqual(resolveConnectorConnection(snapshot, "github", { now: NOW }), {
    state: "connected",
    profileCount: 1,
    attentionCount: 0,
    lastObservedAt: "2026-08-13T15:30:00.000Z",
    validUntil: "2026-08-13T16:30:00.000Z",
  });
  assert.equal(resolveConnectorConnection(snapshot, "github", { now: "2026-08-13T17:00:00.000Z" }).state, "stale");
  assert.equal(resolveConnectorConnection(snapshot, "railway", { now: NOW }).state, "not-configured");
  assert.equal(resolveConnectorConnection(createConnectionSnapshot(), "github", { now: NOW }).state, "not-configured");
});

test("one fresh profile stays connected while another profile remains attention", () => {
  const snapshot = createConnectionSnapshot({
    version: 1,
    profiles: [
      githubProfile(),
      githubProfile({
        id: "github-team",
        state: "authorization-required",
        lastObservedAt: null,
      }),
    ],
  });
  const result = resolveConnectorConnection(snapshot, "github", { now: NOW });
  assert.equal(result.state, "connected");
  assert.equal(result.profileCount, 2);
  assert.equal(result.attentionCount, 1);
});

test("instance presentation keeps private and public builds visibly distinct", () => {
  assert.deepEqual(resolveInstancePresentation(), { mode: "private", label: "Private workspace" });
  assert.deepEqual(resolveInstancePresentation({}, { publicSnapshot: true }), { mode: "demo", label: "Public demo" });
  assert.deepEqual(resolveInstancePresentation({ DEVHUB_INSTANCE_LABEL: "Team operations" }), { mode: "private", label: "Team operations" });
  assert.throws(() => resolveInstancePresentation({ DEVHUB_INSTANCE_MODE: "public" }), /private or demo/);
  assert.throws(() => resolveInstancePresentation({ DEVHUB_INSTANCE_LABEL: "bad\nlabel" }), /single line/);
});
