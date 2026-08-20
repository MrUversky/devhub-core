import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createRailwayInventoryAdapter } from "../lib/inventory-adapters/providers/railway.mjs";
import { runSetupSession } from "../lib/setup-session.mjs";
import { reconcileProviderInventory } from "../scripts/provider-inventory.mjs";
import {
  collectRailwaySetupInventory,
  compareRailwaySetupRefresh,
  createRailwaySetupConnector,
  railwayBindingFromConnectionProfile,
  railwaySetupConnector,
  railwayTaskObservationBridge,
} from "../lib/setup-connectors/railway.mjs";

const FIXTURE_DIR = new URL("./fixtures/inventory-adapters/", import.meta.url);
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const OBSERVED_AT = "2026-08-13T09:00:00.000Z";

const fixtures = Object.fromEntries(await Promise.all(
  ["railway-workspace", "railway-project", "railway-runtime"].map(async (name) => [
    name,
    JSON.parse(await readFile(new URL(`${name}.json`, FIXTURE_DIR), "utf8")),
  ]),
));

function profile(overrides = {}) {
  return {
    version: 1,
    id: "railway-fictional-acme",
    connectorId: "railway",
    scope: { kind: "workspace", id: WORKSPACE_ID },
    authorization: {
      method: "secret-reference",
      credentialRef: { kind: "environment", locator: "RAILWAY_API_TOKEN" },
    },
    owner: "Fictional Acme operator",
    state: "authorization-required",
    freshForSeconds: 3600,
    ...overrides,
  };
}

function fixtureFetch(requests) {
  return async (url, init) => {
    requests.push({ url, init });
    const payload = JSON.parse(init.body);
    if (payload.query.includes("DevHubRailwayProjects")) return Response.json(fixtures["railway-workspace"]);
    if (payload.query.includes("DevHubRailwayProject(")) return Response.json(fixtures["railway-project"]);
    if (payload.query.includes("DevHubRailwayRuntime")) return Response.json(fixtures["railway-runtime"]);
    throw new Error("unexpected query");
  };
}

function normalizedResult({
  candidates = [],
  execution = { state: "succeeded", reason: "adapter-observation", pagesRead: 1 },
  freshness = {
    state: "fresh",
    observedAt: OBSERVED_AT,
    validUntil: "2026-08-13T10:00:00.000Z",
    evaluatedAt: OBSERVED_AT,
  },
  scope = { kind: "workspace", id: WORKSPACE_ID },
} = {}) {
  return {
    formatVersion: 1,
    source: { adapterId: "railway-inventory-v1", provider: "railway", scope },
    execution,
    freshness,
    candidates,
  };
}

function candidate(overrides = {}) {
  return {
    provider: "railway",
    resourceType: "service-instance",
    resourceId: "33333333-3333-4333-8333-333333333333:55555555-5555-4555-8555-555555555555",
    parentResourceId: PROJECT_ID,
    name: "Web",
    environment: "production",
    status: "running",
    urls: [{ kind: "service", url: "https://app.fictional-acme.invalid/" }],
    observedAt: OBSERVED_AT,
    validUntil: "2026-08-13T10:00:00.000Z",
    freshness: "fresh",
    metadata: {
      projectId: PROJECT_ID,
      serviceId: "33333333-3333-4333-8333-333333333333",
      environmentId: "55555555-5555-4555-8555-555555555555",
      deploymentId: "77777777-7777-4777-8777-777777777777",
    },
    ...overrides,
  };
}

test("Railway Connected Setup maps a reviewed profile to the existing bounded adapter contract", () => {
  assert.deepEqual(Object.keys(railwaySetupConnector).sort(), ["collect", "connectorId", "onboarding", "taskObservationBridge", "validateProfile"]);
  assert.equal(railwaySetupConnector.connectorId, "railway");
  const binding = railwayBindingFromConnectionProfile(profile());
  assert.deepEqual(binding.scope, { kind: "workspace", id: WORKSPACE_ID });
  assert.equal(binding.credentialEnv, "DEVHUB_SETUP_RAILWAY_CREDENTIAL");
  assert.equal(binding.maxResources, 200);
  assert.equal(binding.maxPages, 20);
  assert.equal(binding.deadlineMs, 10_000);

  assert.throws(() => railwayBindingFromConnectionProfile(profile({
    scope: { kind: "account", id: WORKSPACE_ID },
  })), /scope/i);
  assert.throws(() => railwayBindingFromConnectionProfile(profile({
    scope: { kind: "project", id: PROJECT_ID },
  })), /scope/i);

  const projectBinding = railwayBindingFromConnectionProfile(profile({
    scope: { kind: "project", id: PROJECT_ID, parent: { kind: "workspace", id: WORKSPACE_ID } },
  }));
  assert.equal(projectBinding.scope.kind, "project");
  assert.equal(projectBinding.scope.parent.id, WORKSPACE_ID);
});

test("Railway task observations discard provider IDs and stay transient review-only", () => {
  const result = railwayTaskObservationBridge.normalize({
    connectorId: "railway",
    bridgeId: railwayTaskObservationBridge.id,
    observedAt: OBSERVED_AT,
    scope: { kind: "workspace", label: "Fictional Studio" },
    resources: [
      { kind: "project", label: "API" },
      { kind: "project", label: "Web" },
    ],
  }, {
    selectedConnectorIds: ["railway"],
    now: OBSERVED_AT,
    maxResources: railwayTaskObservationBridge.maxResources,
  });

  assert.equal(result.trust, "untrusted-transient-review-only");
  assert.equal(result.scope.label, "Fictional Studio");
  assert.equal(result.resourceCount, 2);
  assert.ok(result.normalizedInventory.candidates.every((entry) => /^task-resource-[a-f0-9]{24}$/.test(entry.resourceId)));
  assert.ok(result.normalizedInventory.candidates.every((entry) => entry.urls.length === 0));
  assert.doesNotMatch(JSON.stringify(result), /11111111|22222222|credential|locator|authorization/i);
  assert.throws(() => railwayTaskObservationBridge.normalize({
    connectorId: "railway",
    bridgeId: railwayTaskObservationBridge.id,
    observedAt: OBSERVED_AT,
    scope: { kind: "workspace", label: "Fictional Studio", id: WORKSPACE_ID },
    resources: [],
  }, {
    selectedConnectorIds: ["railway"],
    now: OBSERVED_AT,
    maxResources: railwayTaskObservationBridge.maxResources,
  }), /not supported/);
});

test("Railway Connected Setup collects through the existing adapter without returning credential values", async () => {
  const requests = [];
  const adapter = createRailwayInventoryAdapter({ fetch: fixtureFetch(requests) });
  const credential = "fictional-token-visible-only-to-adapter";
  const result = await collectRailwaySetupInventory({
    profile: profile(),
    credential,
    now: OBSERVED_AT,
    adapter,
  });

  assert.equal(result.execution.state, "succeeded");
  assert.equal(result.candidates.length, 5);
  assert.deepEqual(
    [...new Set(result.candidates.filter((item) => item.environment).map((item) => item.environment))].sort(),
    ["production", "staging"],
  );
  assert.equal(JSON.stringify(result).includes(credential), false);
  assert.ok(requests.every((request) => request.init.headers.authorization === `Bearer ${credential}`));
});

test("Railway connector integrates with the on-demand Setup Runner contract", async () => {
  const requests = [];
  const adapter = createRailwayInventoryAdapter({ fetch: fixtureFetch(requests) });
  const connector = createRailwaySetupConnector({ adapter });
  const credential = "fictional-token-visible-only-to-adapter";
  const session = await runSetupSession(profile(), {
    connectors: { railway: connector },
    now: OBSERVED_AT,
    sessionId: "railway-setup-session",
    resolveCredential: async (reference) => {
      assert.deepEqual(reference, { kind: "environment", locator: "RAILWAY_API_TOKEN" });
      return credential;
    },
  });

  assert.equal(session.status, "complete");
  assert.equal(session.results[0].state, "connected");
  assert.equal(session.results[0].evidence.observations[0].kind, "normalized-provider-inventory");
  assert.equal(session.results[0].evidence.observations[0].candidates.length, 5);
  assert.equal(JSON.stringify(session).includes(credential), false);
});

test("Railway connector keeps access denial unknown in Setup Runner", async () => {
  const adapter = createRailwayInventoryAdapter({
    fetch: async () => new Response("fictional-private-provider-detail", { status: 403 }),
  });
  const session = await runSetupSession(profile(), {
    connectors: { railway: createRailwaySetupConnector({ adapter }) },
    now: OBSERVED_AT,
    sessionId: "railway-denied-session",
    resolveCredential: async () => "fictional-token-visible-only-to-adapter",
  });
  assert.equal(session.status, "review-required");
  assert.equal(session.results[0].state, "unknown");
  assert.deepEqual(session.results[0].evidence.observations, []);
  assert.match(session.results[0].message, /no absence or deletion was inferred/i);
  assert.equal(JSON.stringify(session).includes("fictional-private-provider-detail"), false);
});

test("a remote-only Railway project flows into the existing review-only overlay proposal", async () => {
  const adapter = createRailwayInventoryAdapter({ fetch: fixtureFetch([]) });
  const observation = await collectRailwaySetupInventory({
    profile: profile(),
    credential: "fictional-token-visible-only-to-adapter",
    now: OBSERVED_AT,
    adapter,
  });
  const review = reconcileProviderInventory({
    hosts: [{ id: "railway", name: "Railway", kind: "cloud", location: "cloud" }],
    hostIds: new Set(["railway"]),
    projects: [],
  }, observation, [], { projectDirectory: "/reviewed/catalog/projects" });
  const project = review.items.find((item) => item.identity.resourceType === "project");

  assert.equal(project.status, "unregistered");
  assert.equal(project.proposal.writes, false);
  assert.equal(project.proposal.manifest.registration, "overlay");
  assert.equal(project.proposal.manifest.workspaces, undefined);
  assert.deepEqual(project.proposal.manifest.services, []);
});

test("Railway refresh reports meaningful additions and changes while preserving environments", () => {
  const production = candidate();
  const staging = candidate({
    resourceId: "33333333-3333-4333-8333-333333333333:66666666-6666-4666-8666-666666666666",
    environment: "staging",
    status: "deploying",
    urls: [],
    metadata: {
      ...candidate().metadata,
      environmentId: "66666666-6666-4666-8666-666666666666",
      deploymentId: "88888888-8888-4888-8888-888888888888",
    },
  });
  const previous = normalizedResult({ candidates: [production] });
  const current = normalizedResult({ candidates: [
    candidate({ status: "failed" }),
    staging,
  ] });

  const refresh = compareRailwaySetupRefresh(previous, current);
  assert.deepEqual(refresh.summary, { added: 1, changed: 1, stale: 0, unclear: 0, unchanged: 0 });
  assert.equal(refresh.items.find((item) => item.kind === "added").candidate.environment, "staging");
  assert.equal(refresh.items.find((item) => item.kind === "changed").candidate.environment, "production");
});

test("Railway refresh never treats absence or inaccessible results as deletion", () => {
  const previous = normalizedResult({ candidates: [candidate()] });
  const empty = compareRailwaySetupRefresh(previous, normalizedResult());
  assert.deepEqual(empty.summary, { added: 0, changed: 0, stale: 0, unclear: 1, unchanged: 0 });
  assert.match(empty.items[0].reason, /does not prove deletion/i);

  const inaccessible = compareRailwaySetupRefresh(previous, normalizedResult({
    execution: { state: "failed", reason: "provider-access-denied", pagesRead: 0 },
    freshness: {
      state: "unknown",
      observedAt: null,
      validUntil: null,
      evaluatedAt: OBSERVED_AT,
    },
  }));
  assert.deepEqual(inaccessible.summary, { added: 0, changed: 0, stale: 0, unclear: 1, unchanged: 0 });
  assert.match(inaccessible.items[0].reason, /previous observation remains review context/i);
  assert.equal(inaccessible.items.some((item) => item.kind === "added" || item.kind === "changed"), false);
});

test("Railway refresh marks stale evidence and rejects a broadened or changed scope", () => {
  const staleCandidate = candidate({
    validUntil: "2026-08-13T08:00:00.000Z",
    freshness: "stale",
  });
  const stale = normalizedResult({
    candidates: [staleCandidate],
    freshness: {
      state: "stale",
      observedAt: "2026-08-13T07:00:00.000Z",
      validUntil: "2026-08-13T08:00:00.000Z",
      evaluatedAt: OBSERVED_AT,
    },
  });
  const refresh = compareRailwaySetupRefresh(null, stale);
  assert.deepEqual(refresh.summary, { added: 0, changed: 0, stale: 1, unclear: 0, unchanged: 0 });

  assert.throws(() => compareRailwaySetupRefresh(
    normalizedResult({ candidates: [candidate()] }),
    normalizedResult({
      scope: { kind: "project", id: PROJECT_ID, parent: { kind: "workspace", id: WORKSPACE_ID } },
    }),
  ), /same reviewed scope/i);
});
