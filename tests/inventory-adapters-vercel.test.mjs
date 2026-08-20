import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  VERCEL_INVENTORY_ADAPTER_ID,
  createVercelInventoryAdapter,
} from "../lib/inventory-adapters/providers/vercel.mjs";
import { createInventoryAdapterRegistry } from "../lib/inventory-adapters/registry.mjs";
import { runInventoryAdapter } from "../lib/inventory-adapters.mjs";

const FIXTURE_DIR = new URL("./fixtures/inventory-adapters/", import.meta.url);
const ACCOUNT_ID = "usr_fictional_owner";
const TEAM_ID = "team_fictionalstudio";
const PROJECT_ID = "prj_FictionalPortfolioApp";
const NOW = "2026-08-13T09:00:00.000Z";

const fixtures = Object.fromEntries(await Promise.all([
  "vercel-account",
  "vercel-team",
  "vercel-project",
  "vercel-projects",
  "vercel-domains",
  "vercel-production-deployments",
  "vercel-preview-deployments",
].map(async (name) => [name, JSON.parse(await readFile(new URL(`${name}.json`, FIXTURE_DIR), "utf8"))])));

function request(scope = { kind: "team", id: TEAM_ID }, overrides = {}) {
  return {
    provider: "vercel",
    scope,
    credential: "fictional-vercel-token-never-returned",
    now: NOW,
    limits: { maxResources: 20, maxPages: 20, deadlineMs: 250 },
    signal: new AbortController().signal,
    ...overrides,
  };
}

function fixtureFetch(calls, mutator = null) {
  return async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    let value;
    if (url.pathname === `/v2/teams/${TEAM_ID}`) value = fixtures["vercel-team"];
    else if (url.pathname === "/v2/user") value = fixtures["vercel-account"];
    else if (url.pathname === "/v9/projects") value = fixtures["vercel-projects"];
    else if (url.pathname === `/v9/projects/${PROJECT_ID}`) value = fixtures["vercel-project"];
    else if (url.pathname === `/v9/projects/${PROJECT_ID}/domains`) value = fixtures["vercel-domains"];
    else if (url.pathname === "/v6/deployments" && url.searchParams.get("target") === "production") {
      value = fixtures["vercel-production-deployments"];
    } else if (url.pathname === "/v6/deployments" && url.searchParams.get("target") === "preview") {
      value = fixtures["vercel-preview-deployments"];
    } else throw new Error(`unexpected Vercel request ${url}`);
    return Response.json(mutator ? mutator(structuredClone(value), url) : value);
  };
}

test("Vercel inventory preserves exact team scope and separates production from preview", async () => {
  const calls = [];
  const adapter = createVercelInventoryAdapter({ fetch: fixtureFetch(calls) });
  const result = await adapter.collect(request());

  assert.equal(adapter.id, VERCEL_INVENTORY_ADAPTER_ID);
  assert.equal(result.status, "success");
  assert.equal(result.pagesRead, 6);
  assert.equal(result.candidates.length, 3);
  assert.deepEqual(result.candidates.map((item) => [item.resourceType, item.resourceId, item.environment]), [
    ["project", PROJECT_ID, undefined],
    ["service-instance", `${PROJECT_ID}:production`, "production"],
    ["service-instance", `${PROJECT_ID}:preview`, "preview"],
  ]);
  const production = result.candidates[1];
  const preview = result.candidates[2];
  assert.equal(production.status, "running");
  assert.equal(preview.status, "deploying");
  assert.deepEqual(production.urls, [
    { kind: "service", url: "https://fictional-production.vercel.app/" },
    { kind: "service", url: "https://fictional-portfolio.vercel.app/" },
    { kind: "service", url: "https://app.fictional-studio.invalid/" },
  ]);
  assert.deepEqual(preview.urls, [
    { kind: "service", url: "https://fictional-preview.vercel.app/" },
  ]);
  assert.equal(production.metadata.revision, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(production.metadata.deployedAt, "2026-08-13T08:00:00.000Z");

  for (const call of calls) {
    assert.equal(call.url.origin, "https://api.vercel.com");
    assert.equal(call.init.method, "GET");
    assert.equal(call.init.headers.authorization, "Bearer fictional-vercel-token-never-returned");
    assert.equal(call.url.searchParams.get("teamId") ?? TEAM_ID, TEAM_ID);
    assert.equal(call.url.pathname.includes("logs"), false);
  }
  const serialized = JSON.stringify(result);
  for (const forbidden of [
    "fictional-vercel-token-never-returned",
    "private-owner@fictional.invalid",
    "private-member@fictional.invalid",
    "vercel-secret-shaped",
    "private/repository",
  ]) assert.equal(serialized.includes(forbidden), false);
});

test("Vercel inventory accepts only exact team or account scopes", () => {
  const adapter = createVercelInventoryAdapter({ fetch: async () => Response.json({}) });
  assert.equal(adapter.validateScope({ kind: "team", id: TEAM_ID }), true);
  assert.equal(adapter.validateScope({ kind: "account", id: ACCOUNT_ID }), true);
  assert.equal(adapter.validateScope({ kind: "workspace", id: TEAM_ID }), false);
  assert.equal(adapter.validateScope({ kind: "team", id: TEAM_ID, slug: "fictional" }), false);
  assert.equal(adapter.validateScope({ kind: "account", id: "https://vercel.com/account" }), false);
});

test("Vercel personal scope is verified without broad team enumeration", async () => {
  const calls = [];
  const result = await createVercelInventoryAdapter({ fetch: fixtureFetch(calls) }).collect(
    request({ kind: "account", id: ACCOUNT_ID }),
  );
  assert.equal(result.status, "success");
  assert.ok(calls.some(({ url }) => url.pathname === "/v2/user"));
  assert.ok(calls.every(({ url }) => !url.searchParams.has("teamId")));
  assert.ok(calls.every(({ url }) => url.pathname !== "/v2/teams"));
});

test("Vercel scope mismatch, denial and rate limit fail closed", async () => {
  const mismatch = createVercelInventoryAdapter({
    fetch: fixtureFetch([], (value, url) => url.pathname.startsWith("/v2/teams/") ? { ...value, id: "team_other" } : value),
  });
  assert.deepEqual(await mismatch.collect(request()), { status: "unavailable", reason: "provider-scope-mismatch" });

  const denied = createVercelInventoryAdapter({ fetch: async () => new Response("secret denial", { status: 403 }) });
  assert.deepEqual(await denied.collect(request()), { status: "unavailable", reason: "provider-access-denied" });

  const rateLimited = createVercelInventoryAdapter({ fetch: async () => new Response("secret rate detail", { status: 429 }) });
  assert.deepEqual(await rateLimited.collect(request()), { status: "unavailable", reason: "provider-rate-limited" });
});

test("Vercel inventory fails closed on partial pagination and resource caps", async () => {
  const paginated = createVercelInventoryAdapter({ fetch: fixtureFetch([], (value, url) => {
    if (url.pathname === "/v9/projects") value.pagination.next = 1786500000000;
    return value;
  }) });
  assert.deepEqual(await paginated.collect(request(undefined, {
    limits: { maxResources: 20, maxPages: 2, deadlineMs: 250 },
  })), { status: "unavailable", reason: "provider-page-limit-exceeded" });

  const capped = createVercelInventoryAdapter({ fetch: fixtureFetch([]) });
  assert.deepEqual(await capped.collect(request(undefined, {
    limits: { maxResources: 2, maxPages: 20, deadlineMs: 250 },
  })), { status: "unavailable", reason: "provider-resource-limit-exceeded" });
});

test("Vercel keeps a failed latest production attempt separate from the READY deployment serving domains", async () => {
  const calls = [];
  const failedDeploymentId = "dpl_FictionalFailedAttempt01";
  const adapter = createVercelInventoryAdapter({ fetch: fixtureFetch(calls, (value, url) => {
    if (url.pathname === "/v6/deployments" && url.searchParams.get("target") === "production") {
      value.deployments[0] = {
        ...value.deployments[0],
        uid: failedDeploymentId,
        url: "fictional-failed-attempt.vercel.app",
        alias: ["app.fictional-studio.invalid"],
        readyState: "ERROR",
        meta: { githubCommitSha: "cccccccccccccccccccccccccccccccccccccccc" },
      };
    }
    return value;
  }) });
  const result = await adapter.collect(request());

  assert.equal(result.status, "success");
  const production = result.candidates.find((candidate) => candidate.resourceId === `${PROJECT_ID}:production`);
  const attempt = result.candidates.find((candidate) => candidate.resourceId === failedDeploymentId);
  assert.equal(production.status, "running");
  assert.equal(production.metadata.deploymentId, "dpl_FictionalProduction01");
  assert.ok(production.urls.some(({ url }) => url === "https://app.fictional-studio.invalid/"));
  assert.equal(attempt.resourceType, "deployment-attempt");
  assert.equal(attempt.status, "failed");
  assert.deepEqual(attempt.urls, [{ kind: "service", url: "https://fictional-failed-attempt.vercel.app/" }]);
  assert.equal(attempt.urls.some(({ url }) => production.urls.some((entry) => entry.url === url)), false);
});

test("Vercel never copies deployment aliases into Preview and does not invent current production", async () => {
  const adapter = createVercelInventoryAdapter({ fetch: fixtureFetch([], (value, url) => {
    if (url.pathname === `/v9/projects/${PROJECT_ID}`) value.targets.production = null;
    if (url.pathname === "/v6/deployments" && url.searchParams.get("target") === "preview") {
      value.deployments[0].alias = [
        "app.fictional-studio.invalid",
        "fictional-preview-branch.vercel.app",
      ];
    }
    return value;
  }) });
  const result = await adapter.collect(request());

  assert.equal(result.status, "success");
  assert.equal(result.candidates.some((candidate) => candidate.resourceId === `${PROJECT_ID}:production`), false);
  const latestAttempt = result.candidates.find((candidate) => candidate.environment === "production");
  assert.equal(latestAttempt.resourceType, "deployment-attempt");
  const preview = result.candidates.find((candidate) => candidate.environment === "preview");
  assert.deepEqual(preview.urls, [{ kind: "service", url: "https://fictional-preview.vercel.app/" }]);
  assert.equal(preview.urls.some(({ url }) => url === "https://app.fictional-studio.invalid/"), false);
});

test("Vercel inventory enforces byte and wall-clock bounds", async () => {
  const oversized = createVercelInventoryAdapter({ maxResponseBytes: 32, fetch: fixtureFetch([]) });
  assert.deepEqual(await oversized.collect(request()), { status: "unavailable", reason: "provider-response-too-large" });

  const hanging = createVercelInventoryAdapter({ fetch: async () => new Promise(() => {}) });
  const started = Date.now();
  assert.deepEqual(await hanging.collect(request(undefined, {
    limits: { maxResources: 20, maxPages: 20, deadlineMs: 20 },
  })), { status: "unavailable", reason: "provider-timeout" });
  assert.ok(Date.now() - started < 200);
});

test("generic inventory runner emits normalized Vercel facts and unknown on partial failure", async () => {
  const binding = {
    adapterId: VERCEL_INVENTORY_ADAPTER_ID,
    provider: "vercel",
    scope: { kind: "team", id: TEAM_ID },
    credentialEnv: "FICTIONAL_VERCEL_TOKEN",
    freshForSeconds: 3600,
    maxResources: 20,
    maxPages: 20,
    deadlineMs: 250,
  };
  const result = await runInventoryAdapter({
    adapter: createVercelInventoryAdapter({ fetch: fixtureFetch([]) }),
    binding,
    environment: { FICTIONAL_VERCEL_TOKEN: "fictional-vercel-token-never-returned" },
    now: NOW,
  });
  assert.equal(result.execution.state, "succeeded");
  assert.equal(result.freshness.state, "fresh");
  assert.equal(result.candidates.length, 3);
  assert.equal(JSON.stringify(result).includes("fictional-vercel-token-never-returned"), false);

  const failed = await runInventoryAdapter({
    adapter: createVercelInventoryAdapter({ fetch: async () => new Response("forbidden", { status: 403 }) }),
    binding,
    environment: { FICTIONAL_VERCEL_TOKEN: "fictional-vercel-token-never-returned" },
    now: NOW,
  });
  assert.equal(failed.execution.state, "failed");
  assert.equal(failed.freshness.state, "unknown");
  assert.deepEqual(failed.candidates, []);
});

test("inventory registry exposes both reviewed provider adapters", () => {
  const registry = createInventoryAdapterRegistry({ fetch: async () => Response.json({}) });
  assert.deepEqual([...registry.keys()].sort(), ["openai-project-inventory-v1", "railway-inventory-v1", "vercel-inventory-v1"]);
});
