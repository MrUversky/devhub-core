import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  VERCEL_DEPLOYMENT_ADAPTER_ID,
  createVercelDeploymentAdapter,
  validateVercelDeploymentIdentity,
} from "../lib/evidence-adapters/providers/vercel-deployment.mjs";
import { createEvidenceAdapterRegistry } from "../lib/evidence-adapters/registry.mjs";
import { runEvidenceAdapter } from "../lib/evidence-adapters.mjs";

const TEAM_ID = "team_fictionalstudio";
const PROJECT_ID = "prj_FictionalPortfolioApp";
const DEPLOYMENT_ID = "dpl_FictionalProduction01";
const REVISION = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NOW = "2026-08-13T09:00:00.000Z";
const team = JSON.parse(await readFile(new URL("fixtures/inventory-adapters/vercel-team.json", import.meta.url), "utf8"));
const deployment = JSON.parse(await readFile(new URL("fixtures/evidence-adapters/vercel-deployment.json", import.meta.url), "utf8"));

const reviewedIdentity = {
  scope: { kind: "team", id: TEAM_ID },
  projectId: PROJECT_ID,
  deploymentId: DEPLOYMENT_ID,
  environment: "production",
  revision: REVISION,
};

const binding = {
  projectId: "fictional-portfolio",
  serviceId: "web-production",
  adapterId: VERCEL_DEPLOYMENT_ADAPTER_ID,
  provider: "vercel",
  reviewedIdentity,
  credentialEnv: "FICTIONAL_VERCEL_TOKEN",
  checks: ["deployment"],
  freshForSeconds: 3600,
};

function fixtureFetch(calls, observedDeployment = deployment) {
  return async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.pathname === `/v2/teams/${TEAM_ID}`) return Response.json(team);
    if (url.pathname === `/v13/deployments/${DEPLOYMENT_ID}`) return Response.json(observedDeployment);
    throw new Error(`unexpected Vercel request ${url}`);
  };
}

test("Vercel deployment evidence verifies exact reviewed scope, deployment, environment and revision", async () => {
  const calls = [];
  const result = await runEvidenceAdapter({
    binding,
    adapter: createVercelDeploymentAdapter({ fetch: fixtureFetch(calls) }),
    environment: { FICTIONAL_VERCEL_TOKEN: "fictional-vercel-token-never-returned" },
    now: NOW,
  });

  assert.equal(result.execution.state, "succeeded");
  assert.equal(result.freshness.state, "fresh");
  assert.deepEqual(result.evidence.map(({ check, state }) => [check, state]), [["deployment", "verified"]]);
  assert.equal(result.deployment.revision, REVISION);
  assert.equal(result.deployment.url, "https://fictional-production.vercel.app/");
  assert.equal(result.deployment.host, "fictional-production.vercel.app");
  assert.equal(result.deployment.deployedAt, "2026-08-13T08:00:00.000Z");
  assert.equal(result.identity.reviewedIdentity.environment, "production");
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url.origin, "https://api.vercel.com");
    assert.equal(call.init.method, "GET");
    assert.equal(call.init.headers.authorization, "Bearer fictional-vercel-token-never-returned");
    assert.equal(call.url.pathname.includes("logs"), false);
  }
  const serialized = JSON.stringify(result);
  for (const forbidden of ["fictional-vercel-token-never-returned", "vercel-secret-shaped", "PRIVATE_VALUE"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("Vercel deployment identity is strict and distinguishes production from preview", () => {
  assert.equal(validateVercelDeploymentIdentity(reviewedIdentity), true);
  assert.equal(validateVercelDeploymentIdentity({ ...reviewedIdentity, environment: "preview" }), true);
  assert.equal(validateVercelDeploymentIdentity({ ...reviewedIdentity, environment: "staging" }), false);
  assert.equal(validateVercelDeploymentIdentity({ ...reviewedIdentity, token: "bad" }), false);
  assert.equal(validateVercelDeploymentIdentity({ ...reviewedIdentity, scope: { kind: "workspace", id: TEAM_ID } }), false);
  assert.equal(validateVercelDeploymentIdentity({ ...reviewedIdentity, revision: REVISION.toUpperCase() }), false);
});

test("changed Vercel deployment facts fail closed as unknown", async () => {
  for (const changed of [
    { projectId: "prj_OtherProject" },
    { id: "dpl_OtherDeployment" },
    { target: "preview" },
    { meta: { githubCommitSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } },
  ]) {
    const observed = { ...deployment, ...changed };
    const result = await runEvidenceAdapter({
      binding,
      adapter: createVercelDeploymentAdapter({ fetch: fixtureFetch([], observed) }),
      environment: { FICTIONAL_VERCEL_TOKEN: "fictional-vercel-token-never-returned" },
      now: NOW,
    });
    assert.equal(result.execution.state, "failed");
    assert.equal(result.execution.reason, "provider-identity-mismatch");
    assert.equal(result.freshness.state, "unknown");
    assert.ok(result.evidence.every((item) => item.state === "unknown"));
    assert.equal(result.deployment, undefined);
  }
});

test("non-ready Vercel deployment is observed but never presented as verified", async () => {
  const observed = { ...deployment, readyState: "BUILDING" };
  const result = await runEvidenceAdapter({
    binding,
    adapter: createVercelDeploymentAdapter({ fetch: fixtureFetch([], observed) }),
    environment: { FICTIONAL_VERCEL_TOKEN: "fictional-vercel-token-never-returned" },
    now: NOW,
  });
  assert.equal(result.execution.state, "succeeded");
  assert.equal(result.evidence[0].state, "unknown");
  assert.match(result.evidence[0].note, /BUILDING/);
});

test("Vercel evidence enforces response bytes, timeout and safe provider failures", async () => {
  const oversized = createVercelDeploymentAdapter({ maxResponseBytes: 32, fetch: fixtureFetch([]) });
  assert.deepEqual(await oversized.collect({
    provider: "vercel",
    reviewedIdentity,
    checks: ["deployment"],
    credential: "fictional-token",
    now: NOW,
  }), { status: "unavailable", reason: "provider-response-too-large" });

  const hanging = createVercelDeploymentAdapter({ timeoutMs: 100, fetch: async () => new Promise(() => {}) });
  const started = Date.now();
  assert.deepEqual(await hanging.collect({
    provider: "vercel",
    reviewedIdentity,
    checks: ["deployment"],
    credential: "fictional-token",
    now: NOW,
  }), { status: "unavailable", reason: "provider-timeout" });
  assert.ok(Date.now() - started < 300);

  const denied = await runEvidenceAdapter({
    binding,
    adapter: createVercelDeploymentAdapter({ fetch: async () => new Response("secret provider detail", { status: 403 }) }),
    environment: { FICTIONAL_VERCEL_TOKEN: "fictional-vercel-token-never-returned" },
    now: NOW,
  });
  assert.equal(denied.execution.state, "failed");
  assert.equal(denied.execution.reason, "provider-access-denied");
  assert.equal(denied.freshness.state, "unknown");
  assert.equal(JSON.stringify(denied).includes("secret provider detail"), false);
});

test("evidence registry exposes Vercel deployment evidence", () => {
  const registry = createEvidenceAdapterRegistry({ fetch: async () => Response.json({}) });
  assert.ok(registry.ids.includes(VERCEL_DEPLOYMENT_ADAPTER_ID));
  assert.equal(registry.get(VERCEL_DEPLOYMENT_ADAPTER_ID)?.provider, "vercel");
});
