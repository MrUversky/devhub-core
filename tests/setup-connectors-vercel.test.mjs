import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createVercelInventoryAdapter } from "../lib/inventory-adapters/providers/vercel.mjs";
import { runSetupSession } from "../lib/setup-session.mjs";
import {
  collectVercelSetupInventory,
  createVercelSetupConnector,
  vercelBindingFromConnectionProfile,
  vercelSetupConnector,
  vercelTaskObservationBridge,
} from "../lib/setup-connectors/vercel.mjs";

const FIXTURE_DIR = new URL("./fixtures/inventory-adapters/", import.meta.url);
const TEAM_ID = "team_fictionalstudio";
const PROJECT_ID = "prj_FictionalPortfolioApp";
const OBSERVED_AT = "2026-08-13T09:00:00.000Z";
const fixtures = Object.fromEntries(await Promise.all([
  "vercel-team",
  "vercel-project",
  "vercel-projects",
  "vercel-domains",
  "vercel-production-deployments",
  "vercel-preview-deployments",
].map(async (name) => [name, JSON.parse(await readFile(new URL(`${name}.json`, FIXTURE_DIR), "utf8"))])));

function profile(overrides = {}) {
  return {
    version: 1,
    id: "vercel-fictional-studio",
    connectorId: "vercel",
    scope: { kind: "team", id: TEAM_ID },
    authorization: {
      method: "secret-reference",
      credentialRef: { kind: "environment", locator: "VERCEL_ACCESS_REF" },
    },
    owner: "Fictional deployment operator",
    state: "authorization-required",
    lastObservedAt: null,
    freshForSeconds: 3600,
    ...overrides,
  };
}

function fixtureFetch(calls) {
  return async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    let value;
    if (url.pathname === `/v2/teams/${TEAM_ID}`) value = fixtures["vercel-team"];
    else if (url.pathname === "/v9/projects") value = fixtures["vercel-projects"];
    else if (url.pathname === `/v9/projects/${PROJECT_ID}`) value = fixtures["vercel-project"];
    else if (url.pathname === `/v9/projects/${PROJECT_ID}/domains`) value = fixtures["vercel-domains"];
    else if (url.pathname === "/v6/deployments" && url.searchParams.get("target") === "production") value = fixtures["vercel-production-deployments"];
    else if (url.pathname === "/v6/deployments" && url.searchParams.get("target") === "preview") value = fixtures["vercel-preview-deployments"];
    else throw new Error("unexpected Vercel fixture request");
    return Response.json(value);
  };
}

test("Vercel Connected Setup maps a reviewed exact profile to the existing bounded adapter", () => {
  assert.deepEqual(Object.keys(vercelSetupConnector).sort(), ["collect", "connectorId", "onboarding", "taskObservationBridge", "validateProfile"]);
  assert.equal(vercelSetupConnector.taskObservationBridge, vercelTaskObservationBridge);
  const binding = vercelBindingFromConnectionProfile(profile());
  assert.equal(binding.adapterId, "vercel-inventory-v1");
  assert.deepEqual(binding.scope, { kind: "team", id: TEAM_ID });
  assert.equal(binding.credentialEnv, "DEVHUB_SETUP_VERCEL_CREDENTIAL");
  assert.equal(binding.maxResources, 200);
  assert.equal(binding.maxPages, 20);
  assert.equal(binding.deadlineMs, 10_000);
  assert.throws(() => vercelBindingFromConnectionProfile(profile({ scope: { kind: "team", id: "broadened" } })), /scope/i);
  assert.throws(() => vercelBindingFromConnectionProfile(profile({ authorization: { method: "oauth" } })), /secret-reference/i);
});

test("Vercel task observation bridge emits only task-local review identities", () => {
  const bound = vercelTaskObservationBridge.normalize({
    connectorId: "vercel",
    bridgeId: vercelTaskObservationBridge.id,
    observedAt: OBSERVED_AT,
    scope: { kind: "team", label: "Fictional Studio" },
    resources: [
      { kind: "project", label: "Portfolio" },
      { kind: "project", label: "Docs" },
    ],
  }, { selectedConnectorIds: ["vercel"], now: OBSERVED_AT, maxResources: 200 });

  assert.equal(bound.trust, "untrusted-transient-review-only");
  assert.equal(bound.resourceCount, 2);
  assert.deepEqual(bound.normalizedInventory.candidates.map((candidate) => candidate.name), ["Docs", "Portfolio"]);
  assert.ok(bound.normalizedInventory.candidates.every((candidate) => /^task-resource-[a-f0-9]{24}$/.test(candidate.resourceId)));
  assert.doesNotMatch(JSON.stringify(bound), /team_fictionalstudio|prj_FictionalPortfolioApp|credential|locator|authorization/i);
  assert.throws(() => vercelTaskObservationBridge.normalize({
    connectorId: "vercel",
    bridgeId: vercelTaskObservationBridge.id,
    observedAt: OBSERVED_AT,
    scope: { kind: "team", label: "Fictional Studio", id: TEAM_ID },
    resources: [],
  }, { selectedConnectorIds: ["vercel"], now: OBSERVED_AT, maxResources: 200 }), /scope\.id is not supported/);
});

test("Vercel profile bridge resolves one credential ephemerally and emits normalized inventory", async () => {
  const calls = [];
  const adapter = createVercelInventoryAdapter({ fetch: fixtureFetch(calls) });
  const ephemeralValue = "fictional-ephemeral-provider-value";
  const session = await runSetupSession(profile(), {
    connectors: { vercel: createVercelSetupConnector({ adapter }) },
    now: OBSERVED_AT,
    sessionId: "vercel-setup-session",
    resolveCredential: async (reference) => {
      assert.deepEqual(reference, { kind: "environment", locator: "VERCEL_ACCESS_REF" });
      return ephemeralValue;
    },
  });

  assert.equal(session.status, "complete");
  assert.equal(session.results[0].state, "connected");
  assert.equal(session.results[0].evidence.observations[0].kind, "normalized-provider-inventory");
  assert.equal(session.results[0].evidence.observations[0].candidates.length, 3);
  assert.ok(calls.every((call) => call.init.headers.authorization === `Bearer ${ephemeralValue}`));
  assert.equal(JSON.stringify(session).includes(ephemeralValue), false);
});

test("Vercel setup bridge fails closed on invalid scope, missing authorization and provider denial", async () => {
  let providerCalls = 0;
  const adapter = createVercelInventoryAdapter({ fetch: async () => {
    providerCalls += 1;
    return new Response("private provider detail", { status: 403 });
  } });
  const invalid = await runSetupSession(profile({ scope: { kind: "team", id: "invalid" } }), {
    connectors: { vercel: createVercelSetupConnector({ adapter }) },
    now: OBSERVED_AT,
    resolveCredential: async () => "unused-ephemeral-value",
  });
  assert.equal(invalid.results[0].state, "unknown");
  assert.equal(providerCalls, 0, "scope validation must happen before credential/provider I/O");

  const missing = await createVercelSetupConnector({ adapter }).collect({ profile: profile(), credential: undefined, now: OBSERVED_AT });
  assert.equal(missing.state, "authorization-required");
  assert.equal(providerCalls, 0);

  const denied = await collectVercelSetupInventory({ profile: profile(), credential: "ephemeral-denied-value", now: OBSERVED_AT, adapter });
  assert.equal(denied.execution.state, "failed");
  assert.equal(denied.freshness.state, "unknown");
  assert.equal(JSON.stringify(denied).includes("private provider detail"), false);
});
