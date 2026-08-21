import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  RAILWAY_INVENTORY_ADAPTER_ID,
  createRailwayInventoryAdapter,
} from "../lib/inventory-adapters/providers/railway.mjs";
import { createInventoryAdapterRegistry } from "../lib/inventory-adapters/registry.mjs";
import { runInventoryAdapter } from "../lib/inventory-adapters.mjs";

const FIXTURE_DIR = new URL("./fixtures/inventory-adapters/", import.meta.url);
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

const fixtures = Object.fromEntries(await Promise.all(
  ["railway-workspace", "railway-project", "railway-runtime"].map(async (name) => [
    name,
    JSON.parse(await readFile(new URL(`${name}.json`, FIXTURE_DIR), "utf8")),
  ]),
));

function request(overrides = {}) {
  return {
    provider: "railway",
    scope: { kind: "workspace", id: WORKSPACE_ID },
    credential: "fictional-token-never-sent-to-railway",
    now: "2026-08-13T09:00:00.000Z",
    limits: { maxResources: 20, maxPages: 20, deadlineMs: 250 },
    signal: new AbortController().signal,
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

test("Railway inventory reads exact scoped metadata and discards secret-shaped fields", async () => {
  const requests = [];
  const adapter = createRailwayInventoryAdapter({ fetch: fixtureFetch(requests) });
  const result = await adapter.collect(request());

  assert.equal(adapter.id, RAILWAY_INVENTORY_ADAPTER_ID);
  assert.equal(result.status, "success");
  assert.equal(result.pagesRead, 6);
  assert.equal(result.candidates.length, 5);
  assert.equal(result.candidates[0].resourceType, "project");

  const webProduction = result.candidates.find((candidate) => (
    candidate.metadata?.serviceId === "33333333-3333-4333-8333-333333333333"
      && candidate.environment === "production"
  ));
  assert.equal(webProduction.repository, undefined, "repository stays unknown when Railway does not expose service source metadata");
  assert.equal(webProduction.status, "running");
  assert.deepEqual(webProduction.urls, [
    { kind: "service", url: "https://app.fictional-acme.invalid/" },
    { kind: "service", url: "https://fictional-acme.up.railway.app/" },
  ]);

  const worker = result.candidates.find((candidate) => candidate.metadata?.serviceId === "44444444-4444-4444-8444-444444444444");
  assert.equal(worker.repository, undefined, "services without GitHub links stay repository-unknown");

  const serialized = JSON.stringify(result);
  for (const secret of [
    "railway-secret-shaped-project-value",
    "railway-secret-shaped-workspace-value",
    "railway-secret-shaped-source-value",
    "railway-secret-shaped-service-value",
    "railway-secret-shaped-environment-value",
    "railway-secret-shaped-log-value",
    "railway-secret-shaped-runtime-value",
    "railway-secret-shaped-domain-value",
    "railway-secret-shaped-provider-error",
    "postgres://secret.invalid/db",
  ]) assert.equal(serialized.includes(secret), false);

  for (const call of requests) {
    assert.equal(call.url, "https://backboard.railway.com/graphql/v2");
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.headers.authorization, "Bearer fictional-token-never-sent-to-railway");
    const body = JSON.parse(call.init.body);
    assert.doesNotMatch(body.query, /\b(?:mutation|variables|deploymentLogs|logs|metrics)\b/i);
    assert.doesNotMatch(body.query, /\bsource\s*\{/i, "the current Railway Service schema does not expose source metadata");
    assert.deepEqual(Object.keys(body).sort(), ["query", "variables"]);
  }
});

test("Railway inventory accepts only explicit workspace or workspace-parented project scopes", () => {
  const adapter = createRailwayInventoryAdapter({ fetch: async () => Response.json({}) });
  assert.equal(adapter.validateScope({ kind: "workspace", id: WORKSPACE_ID }), true);
  assert.equal(adapter.validateScope({
    kind: "project",
    id: PROJECT_ID,
    parent: { kind: "workspace", id: WORKSPACE_ID },
  }), true);
  assert.equal(adapter.validateScope({ kind: "account", id: WORKSPACE_ID }), false);
  assert.equal(adapter.validateScope({ kind: "project", id: PROJECT_ID }), false);
  assert.equal(adapter.validateScope({ kind: "workspace", id: WORKSPACE_ID, url: "https://evil.invalid" }), false);
});

test("inventory registry exposes every shipped provider and keeps Railway injectable", async () => {
  const requests = [];
  const registry = createInventoryAdapterRegistry({ fetch: fixtureFetch(requests) });
  assert.deepEqual([...registry.keys()], ["openai-project-inventory-v1", "railway-inventory-v1", "vercel-inventory-v1"]);
  const result = await registry.get("railway-inventory-v1").collect(request());
  assert.equal(result.status, "success");
  assert.ok(requests.length > 0);
});

test("Railway inventory turns denied access and provider errors into safe unavailable reasons", async () => {
  const denied = createRailwayInventoryAdapter({
    fetch: async () => new Response(JSON.stringify({ error: "railway-secret-shaped-denial-detail" }), { status: 403 }),
  });
  assert.deepEqual(await denied.collect(request()), { status: "unavailable", reason: "provider-access-denied" });

  const graphqlFailure = createRailwayInventoryAdapter({
    fetch: async () => Response.json({ errors: [{ message: "railway-secret-shaped-provider-error" }], data: null }),
  });
  const result = await graphqlFailure.collect(request());
  assert.deepEqual(result, { status: "unavailable", reason: "provider-query-failed" });
  assert.equal(JSON.stringify(result).includes("railway-secret-shaped"), false);
});

test("Railway inventory deadline covers a fetch that ignores AbortSignal", async () => {
  const adapter = createRailwayInventoryAdapter({ fetch: async () => new Promise(() => {}) });
  const started = Date.now();
  const result = await adapter.collect(request({ limits: { maxResources: 20, maxPages: 20, deadlineMs: 20 } }));
  assert.deepEqual(result, { status: "unavailable", reason: "provider-timeout" });
  assert.ok(Date.now() - started < 200);
});

test("Railway inventory fails closed at the pagination cap", async () => {
  const page = structuredClone(fixtures["railway-workspace"]);
  page.data.workspace.projects.pageInfo.hasNextPage = true;
  page.data.workspace.projects.pageInfo.endCursor = "next-fictional-page";
  const adapter = createRailwayInventoryAdapter({ fetch: async () => Response.json(page) });
  const result = await adapter.collect(request({ limits: { maxResources: 20, maxPages: 1, deadlineMs: 250 } }));
  assert.deepEqual(result, { status: "unavailable", reason: "provider-page-limit-exceeded" });
});

test("Railway inventory follows bounded workspace pagination without broadening scope", async () => {
  let projectPages = 0;
  const requests = [];
  const adapter = createRailwayInventoryAdapter({
    fetch: async (url, init) => {
      requests.push({ url, init });
      const payload = JSON.parse(init.body);
      if (payload.query.includes("DevHubRailwayProjects")) {
        projectPages += 1;
        const page = structuredClone(fixtures["railway-workspace"]);
        if (projectPages === 1) {
          page.data.workspace.projects.edges = [];
          page.data.workspace.projects.pageInfo = { hasNextPage: true, endCursor: "fictional-next-page" };
        }
        return Response.json(page);
      }
      if (payload.query.includes("DevHubRailwayProject(")) return Response.json(fixtures["railway-project"]);
      return Response.json(fixtures["railway-runtime"]);
    },
  });
  const result = await adapter.collect(request());
  assert.equal(result.status, "success");
  assert.equal(result.pagesRead, 7);
  assert.equal(projectPages, 2);
  const projectRequests = requests
    .map(({ init }) => JSON.parse(init.body))
    .filter(({ query }) => query.includes("DevHubRailwayProjects"));
  assert.equal(projectRequests[0].variables.after, null);
  assert.equal(projectRequests[1].variables.after, "fictional-next-page");
  assert.ok(projectRequests.every(({ variables }) => variables.workspaceId === WORKSPACE_ID));
});

test("Railway inventory enforces the bounded JSON response", async () => {
  const adapter = createRailwayInventoryAdapter({
    maxResponseBytes: 64,
    fetch: async () => Response.json(fixtures["railway-workspace"]),
  });
  assert.deepEqual(await adapter.collect(request()), {
    status: "unavailable",
    reason: "provider-response-too-large",
  });
});

test("Railway project scope verifies membership in the reviewed workspace", async () => {
  const requests = [];
  const adapter = createRailwayInventoryAdapter({ fetch: fixtureFetch(requests) });
  const result = await adapter.collect(request({
    scope: { kind: "project", id: PROJECT_ID, parent: { kind: "workspace", id: WORKSPACE_ID } },
  }));
  assert.equal(result.status, "success");
  assert.equal(result.candidates[0].resourceId, PROJECT_ID);

  const mismatch = await adapter.collect(request({
    scope: {
      kind: "project",
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      parent: { kind: "workspace", id: WORKSPACE_ID },
    },
  }));
  assert.deepEqual(mismatch, { status: "unavailable", reason: "provider-scope-mismatch" });
});

test("generic runner normalizes Railway candidates with reviewed freshness and no credential output", async () => {
  const requests = [];
  const adapter = createRailwayInventoryAdapter({ fetch: fixtureFetch(requests) });
  const result = await runInventoryAdapter({
    adapter,
    binding: {
      adapterId: "railway-inventory-v1",
      provider: "railway",
      scope: { kind: "workspace", id: WORKSPACE_ID },
      credentialEnv: "FICTIONAL_RAILWAY_TOKEN",
      freshForSeconds: 3600,
      maxResources: 20,
      maxPages: 20,
      deadlineMs: 250,
    },
    environment: { FICTIONAL_RAILWAY_TOKEN: "fictional-token-never-sent-to-railway" },
    now: "2026-08-13T09:00:00.000Z",
  });

  assert.equal(result.execution.state, "succeeded");
  assert.equal(result.freshness.state, "fresh");
  assert.equal(result.freshness.validUntil, "2026-08-13T10:00:00.000Z");
  assert.equal(result.candidates.length, 5);
  assert.ok(result.candidates.every((candidate) => candidate.freshness === "fresh"));
  assert.equal(JSON.stringify(result).includes("fictional-token-never-sent-to-railway"), false);
});

test("generic runner maps Railway denial to unknown with no partial candidates", async () => {
  const adapter = createRailwayInventoryAdapter({
    fetch: async () => new Response("forbidden railway-secret-shaped-provider-detail", { status: 403 }),
  });
  const result = await runInventoryAdapter({
    adapter,
    binding: {
      adapterId: "railway-inventory-v1",
      provider: "railway",
      scope: { kind: "workspace", id: WORKSPACE_ID },
      credentialEnv: "FICTIONAL_RAILWAY_TOKEN",
      freshForSeconds: 3600,
      maxResources: 20,
      maxPages: 20,
      deadlineMs: 250,
    },
    environment: { FICTIONAL_RAILWAY_TOKEN: "fictional-token-never-sent-to-railway" },
    now: "2026-08-13T09:00:00.000Z",
  });
  assert.equal(result.execution.state, "failed");
  assert.equal(result.execution.reason, "provider-access-denied");
  assert.equal(result.freshness.state, "unknown");
  assert.deepEqual(result.candidates, []);
  assert.equal(JSON.stringify(result).includes("railway-secret-shaped"), false);
});
