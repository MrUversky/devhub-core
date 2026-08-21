import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  OPENAI_PROJECT_EVIDENCE_ADAPTER_ID,
  createOpenAIProjectEvidenceAdapter,
  validateOpenAIProjectEvidenceIdentity,
} from "../lib/evidence-adapters/providers/openai-project.mjs";
import { createEvidenceAdapterRegistry } from "../lib/evidence-adapters/registry.mjs";
import { runEvidenceAdapter } from "../lib/evidence-adapters.mjs";

const FIXTURES = new URL("fixtures/evidence-adapters/", import.meta.url);
const read = async (name) => JSON.parse(await readFile(new URL(name, FIXTURES), "utf8"));
const [project, keys, usage, costs, unknownPayer, staleRotation, sharedKey, partialAccess] = await Promise.all([
  readFile(new URL("fixtures/inventory-adapters/openai-project.json", import.meta.url), "utf8").then(JSON.parse),
  read("openai-project-api-keys.json"), read("openai-completions-usage.json"), read("openai-costs.json"),
  read("openai-unknown-payer.json"), read("openai-stale-rotation.json"), read("openai-shared-key.json"), read("openai-partial-access.json"),
]);
const NOW = "2026-08-13T09:00:00.000Z";
const IDENTITY = {
  organizationId: "org_fictional_studio",
  projectId: project.id,
  projectName: project.name,
  keyId: sharedKey.keyId,
  access: { project: "yes", billing: "yes" },
  stewardship: {
    credentialOwner: "platform-team",
    billingOwner: "finance-team",
    purpose: sharedKey.reviewedPurpose,
    lastVerifiedAt: "2026-08-10T00:00:00.000Z",
    rotationDueAt: "2026-10-01T00:00:00.000Z",
  },
  window: { startTime: "2026-08-01T00:00:00.000Z", endTime: "2026-08-08T00:00:00.000Z" },
};

function binding(serviceId = sharedKey.consumers[0], changes = {}) {
  return {
    projectId: "fictional-product",
    serviceId,
    adapterId: OPENAI_PROJECT_EVIDENCE_ADAPTER_ID,
    provider: "openai",
    reviewedIdentity: IDENTITY,
    credentialEnv: "OPENAI_ADMIN_KEY",
    checks: ["ownership", "cost"],
    freshForSeconds: 3600,
    maxPages: 10,
    ...changes,
  };
}

function fixtureFetch(calls, statuses = partialAccess) {
  return async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.pathname === `/v1/organization/projects/${project.id}`) return Response.json(project, { status: statuses.project });
    if (url.pathname.endsWith("/api_keys")) return Response.json(keys, { status: statuses.keyMetadata });
    if (url.pathname.endsWith("/usage/completions")) return Response.json(usage, { status: statuses.usage });
    if (url.pathname.endsWith("/costs")) return Response.json(costs, { status: statuses.costs });
    throw new Error(`unexpected OpenAI request ${url}`);
  };
}

test("OpenAI evidence keeps exact project/key scope and makes capability-specific billing denial unknown", async () => {
  const calls = [];
  const result = await runEvidenceAdapter({
    adapter: createOpenAIProjectEvidenceAdapter({ fetch: fixtureFetch(calls) }),
    binding: binding(),
    environment: { OPENAI_ADMIN_KEY: "fictional-admin-credential-never-returned" },
    now: NOW,
  });
  assert.equal(result.execution.state, "succeeded");
  assert.equal(result.evidence.find((item) => item.id === "openai-project-key-ownership").state, "declared");
  assert.equal(result.evidence.find((item) => item.id === "openai-usage-cost-window").state, partialAccess.expectedCostState);
  assert.equal(result.recurringCost.state, "unknown");
  for (const { url, init } of calls) {
    assert.equal(init.method, "GET");
    assert.equal(init.headers["openai-organization"], IDENTITY.organizationId);
    if (url.pathname.endsWith("/api_keys")) {
      assert.deepEqual([...url.searchParams.keys()].sort(), ["limit"]);
    }
    if (url.pathname.includes("usage") || url.pathname.includes("costs")) {
      assert.deepEqual(url.searchParams.getAll("project_ids"), [IDENTITY.projectId]);
      assert.deepEqual(url.searchParams.getAll("api_key_ids"), [IDENTITY.keyId]);
      assert.deepEqual(url.searchParams.getAll("group_by"), ["project_id", "api_key_id"]);
      assert.equal([...url.searchParams.keys()].some((key) => key.endsWith("[]")), false);
    }
  }
  const serialized = JSON.stringify(result);
  for (const forbidden of ["fictional-admin-credential", "sk-fiction", "redacted_value", "private_prompt", "private_invoice"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("OpenAI window evidence rejects out-of-window and repeated provider buckets", async () => {
  const invalidUsage = structuredClone(usage);
  invalidUsage.data[0].start_time = Math.floor(Date.parse("2026-07-31T00:00:00.000Z") / 1000);
  const outside = await runEvidenceAdapter({
    adapter: createOpenAIProjectEvidenceAdapter({ fetch: async (input) => {
      const pathname = new URL(input).pathname;
      if (pathname === `/v1/organization/projects/${project.id}`) return Response.json(project);
      if (pathname.endsWith("/api_keys")) return Response.json(keys);
      if (pathname.endsWith("/usage/completions")) return Response.json(invalidUsage);
      if (pathname.endsWith("/costs")) return Response.json(costs);
      throw new Error("unexpected fixture request");
    } }),
    binding: binding(),
    environment: { OPENAI_ADMIN_KEY: "fictional" },
    now: NOW,
  });
  assert.equal(outside.evidence.find((item) => item.id === "openai-usage-cost-window").state, "unknown");
  assert.match(outside.evidence.find((item) => item.id === "openai-usage-cost-window").note, /provider-invalid-response/);

  let usagePage = 0;
  const repeated = await runEvidenceAdapter({
    adapter: createOpenAIProjectEvidenceAdapter({ fetch: async (input) => {
      const url = new URL(input);
      if (url.pathname === `/v1/organization/projects/${project.id}`) return Response.json(project);
      if (url.pathname.endsWith("/api_keys")) return Response.json(keys);
      if (url.pathname.endsWith("/usage/completions")) {
        usagePage += 1;
        return Response.json({
          ...usage,
          has_more: usagePage === 1,
          next_page: usagePage === 1 ? "page_two" : null,
        });
      }
      if (url.pathname.endsWith("/costs")) return Response.json(costs);
      throw new Error("unexpected fixture request");
    } }),
    binding: binding(),
    environment: { OPENAI_ADMIN_KEY: "fictional" },
    now: NOW,
  });
  assert.equal(repeated.evidence.find((item) => item.id === "openai-usage-cost-window").state, "unknown");
  assert.match(repeated.evidence.find((item) => item.id === "openai-usage-cost-window").note, /provider-invalid-pagination/);
});

test("unknown payer and stale rotation remain reviewed unknowns without invented ownership", async () => {
  const noPayerCalls = [];
  const noPayerIdentity = {
    ...IDENTITY,
    access: { project: "yes", billing: unknownPayer.billingAccess },
    stewardship: { ...IDENTITY.stewardship, billingOwner: unknownPayer.billingOwner },
  };
  const noPayer = await runEvidenceAdapter({
    adapter: createOpenAIProjectEvidenceAdapter({ fetch: fixtureFetch(noPayerCalls, { ...partialAccess, costs: 200 }) }),
    binding: binding(sharedKey.consumers[0], { reviewedIdentity: noPayerIdentity }),
    environment: { OPENAI_ADMIN_KEY: "fictional" },
    now: NOW,
  });
  assert.equal(noPayer.evidence.find((item) => item.id === "openai-project-key-ownership").state, unknownPayer.expectedState);
  assert.equal(noPayer.evidence.find((item) => item.id === "openai-usage-cost-window").state, "unknown");
  assert.equal(noPayerCalls.some(({ url }) => url.pathname.endsWith("/costs")), false);

  const stale = await runEvidenceAdapter({
    adapter: createOpenAIProjectEvidenceAdapter({ fetch: fixtureFetch([], { ...partialAccess, costs: 200 }) }),
    binding: binding(sharedKey.consumers[1], { reviewedIdentity: {
      ...IDENTITY,
      stewardship: { ...IDENTITY.stewardship, rotationDueAt: staleRotation.rotationDueAt },
    } }),
    environment: { OPENAI_ADMIN_KEY: "fictional" },
    now: NOW,
  });
  assert.equal(stale.evidence.find((item) => item.id === "openai-project-key-ownership").state, staleRotation.expectedState);
  assert.match(stale.evidence.find((item) => item.id === "openai-project-key-ownership").note, /rotation due/);
  assert.equal(stale.identity.reviewedIdentity.keyId, noPayer.identity.reviewedIdentity.keyId);
});

test("OpenAI identity is strict and the canonical registry exposes both runtimes", () => {
  assert.equal(validateOpenAIProjectEvidenceIdentity(IDENTITY), true);
  assert.equal(validateOpenAIProjectEvidenceIdentity({ ...IDENTITY, organizationId: "other" }), false);
  assert.equal(validateOpenAIProjectEvidenceIdentity({ ...IDENTITY, apiKey: "forbidden" }), false);
  assert.equal(validateOpenAIProjectEvidenceIdentity({
    ...IDENTITY,
    window: { ...IDENTITY.window, startTime: "2026-08-01T00:00:00.500Z" },
  }), false);
  const registry = createEvidenceAdapterRegistry({ fetch: async () => Response.json({}) });
  assert.equal(registry.get(OPENAI_PROJECT_EVIDENCE_ADAPTER_ID)?.provider, "openai");
});

test("future OpenAI windows and verification attestations fail before provider IO", async () => {
  let calls = 0;
  const adapter = createOpenAIProjectEvidenceAdapter({ fetch: async () => {
    calls += 1;
    return Response.json(project);
  } });
  for (const reviewedIdentity of [
    { ...IDENTITY, window: { ...IDENTITY.window, endTime: "2026-08-14T00:00:00.000Z" } },
    {
      ...IDENTITY,
      stewardship: { ...IDENTITY.stewardship, lastVerifiedAt: "2026-08-14T00:00:00.000Z" },
    },
  ]) {
    const result = await runEvidenceAdapter({
      adapter,
      binding: binding(sharedKey.consumers[0], { reviewedIdentity }),
      environment: { OPENAI_ADMIN_KEY: "fictional" },
      now: NOW,
    });
    assert.equal(result.execution.reason, "invalid-reviewed-identity");
    assert.equal(result.evidence.every((item) => item.state === "unknown"), true);
  }
  assert.equal(calls, 0);
});

test("missing Keychain evidence reference is unknown before provider IO and never echoed", async () => {
  let calls = 0;
  const result = await runEvidenceAdapter({
    adapter: createOpenAIProjectEvidenceAdapter({ fetch: async () => { calls += 1; return Response.json(project); } }),
    binding: binding(sharedKey.consumers[0], {
      credentialEnv: undefined,
      credentialRef: { kind: "keychain", locator: "generic-password:devhub:openai-admin" },
    }),
    resolveCredential: async () => undefined,
    now: NOW,
  });
  assert.equal(result.execution.reason, "credential-unavailable");
  assert.equal(calls, 0);
  assert.doesNotMatch(JSON.stringify(result), /generic-password|openai-admin/);
});
