import assert from "node:assert/strict";
import test from "node:test";

import {
  InventoryAdapterContractError,
  parseNormalizedInventoryResult,
  runInventoryAdapter,
  validateInventoryBinding,
  validateNormalizedInventoryResult,
} from "../lib/inventory-adapters.mjs";

const NOW = "2026-08-13T12:00:00.000Z";
const binding = {
  adapterId: "fixture-inventory-v1",
  provider: "fixture-cloud",
  scope: { kind: "workspace", id: "workspace-42" },
  credentialEnv: "FIXTURE_INVENTORY_TOKEN",
  freshForSeconds: 3600,
  maxResources: 10,
  maxPages: 3,
  deadlineMs: 1000,
};

const candidate = {
  provider: "fixture-cloud",
  resourceType: "service-instance",
  resourceId: "service-7:production",
  parentResourceId: "project-3",
  name: "Checkout API",
  environment: "production",
  runtime: "node",
  status: "running",
  urls: [{ kind: "service", url: "https://checkout.example.test/" }],
  repository: { provider: "github", owner: "example", name: "checkout", ref: "main" },
  metadata: { region: "eu-west", projectId: "project-3", serviceId: "service-7" },
};

function adapterFor(observation, overrides = {}) {
  return Object.freeze({
    id: "fixture-inventory-v1",
    provider: "fixture-cloud",
    validateScope(scope) {
      return scope.kind === "workspace" && scope.id === "workspace-42";
    },
    async collect(request) {
      assert.ok(Object.isFrozen(request));
      assert.ok(Object.isFrozen(request.scope));
      assert.ok(Object.isFrozen(request.limits));
      return structuredClone(observation);
    },
    ...overrides,
  });
}

test("runner normalizes a bounded exact-scope inventory without exposing credentials", async () => {
  const observedAt = "2026-08-13T11:55:00.000Z";
  const result = await runInventoryAdapter({
    binding,
    adapter: adapterFor({ status: "success", observedAt, pagesRead: 2, candidates: [candidate] }),
    environment: { FIXTURE_INVENTORY_TOKEN: "injected-at-runtime-only" },
    now: NOW,
  });

  assert.deepEqual(result.source, {
    adapterId: "fixture-inventory-v1",
    provider: "fixture-cloud",
    scope: { kind: "workspace", id: "workspace-42" },
  });
  assert.deepEqual(result.execution, { state: "succeeded", reason: "adapter-observation", pagesRead: 2 });
  assert.equal(result.freshness.state, "fresh");
  assert.equal(result.candidates[0].freshness, "fresh");
  assert.equal(result.candidates[0].validUntil, "2026-08-13T12:55:00.000Z");
  assert.doesNotMatch(JSON.stringify(result), /injected-at-runtime-only|FIXTURE_INVENTORY_TOKEN/);
  assert.ok(Object.isFrozen(result.candidates[0]));
  assert.deepEqual(parseNormalizedInventoryResult(JSON.stringify(result)), result);
});

test("binding requires an explicit adapter-reviewed bounded scope and env reference", () => {
  const adapter = adapterFor({ status: "unavailable", reason: "unused" });
  const validated = validateInventoryBinding({
    adapterId: binding.adapterId,
    provider: binding.provider,
    scope: binding.scope,
    credentialEnv: binding.credentialEnv,
    freshForSeconds: binding.freshForSeconds,
  }, adapter);
  assert.deepEqual(
    { maxResources: validated.maxResources, maxPages: validated.maxPages, deadlineMs: validated.deadlineMs },
    { maxResources: 200, maxPages: 20, deadlineMs: 10000 },
  );
  assert.throws(
    () => validateInventoryBinding({ ...binding, scope: { kind: "workspace", id: "https://provider.example.test/team" } }, adapter),
    (error) => error instanceof InventoryAdapterContractError && error.code === "invalid-scope",
  );
  assert.throws(
    () => validateInventoryBinding({ ...binding, credentialEnv: "literal-value" }, adapter),
    (error) => error instanceof InventoryAdapterContractError && error.code === "invalid-credential-environment",
  );
});

test("missing named credential and anonymous binding have distinct fail-closed behavior", async () => {
  let calls = 0;
  const adapter = adapterFor({ status: "success", observedAt: NOW, pagesRead: 1, candidates: [] }, {
    async collect(request) {
      calls += 1;
      assert.equal(request.credential, null);
      return { status: "success", observedAt: NOW, pagesRead: 1, candidates: [] };
    },
  });
  const missing = await runInventoryAdapter({ binding, adapter, environment: {}, now: NOW });
  assert.deepEqual(missing.execution, { state: "failed", reason: "credential-unavailable", pagesRead: 0 });
  assert.equal(missing.freshness.state, "unknown");
  assert.deepEqual(missing.candidates, []);
  assert.equal(calls, 0);

  const anonymous = await runInventoryAdapter({
    binding: { ...binding, credentialEnv: null },
    adapter,
    environment: {},
    now: NOW,
  });
  assert.equal(calls, 1);
  assert.equal(anonymous.execution.state, "succeeded");
});

test("timeouts, provider failures, pagination and resource overflow are unknown with no partial candidates", async () => {
  const timedOut = await runInventoryAdapter({
    binding: { ...binding, deadlineMs: 100 },
    adapter: adapterFor(null, { async collect() { return new Promise(() => {}); } }),
    environment: { FIXTURE_INVENTORY_TOKEN: "runtime-value" },
    now: NOW,
  });
  assert.equal(timedOut.execution.reason, "adapter-timeout");
  assert.deepEqual(timedOut.candidates, []);

  const unavailable = await runInventoryAdapter({
    binding,
    adapter: adapterFor({ status: "unavailable", reason: "provider-access-denied" }),
    environment: { FIXTURE_INVENTORY_TOKEN: "runtime-value" },
    now: NOW,
  });
  assert.equal(unavailable.execution.reason, "provider-access-denied");

  const pageOverflow = await runInventoryAdapter({
    binding,
    adapter: adapterFor({ status: "success", observedAt: NOW, pagesRead: 4, candidates: [] }),
    environment: { FIXTURE_INVENTORY_TOKEN: "runtime-value" },
    now: NOW,
  });
  assert.equal(pageOverflow.execution.reason, "invalid-contract");
  assert.deepEqual(pageOverflow.candidates, []);

  const resourceOverflow = await runInventoryAdapter({
    binding: { ...binding, maxResources: 1 },
    adapter: adapterFor({ status: "success", observedAt: NOW, pagesRead: 1, candidates: [candidate, { ...candidate, resourceId: "service-8" }] }),
    environment: { FIXTURE_INVENTORY_TOKEN: "runtime-value" },
    now: NOW,
  });
  assert.equal(resourceOverflow.execution.reason, "resource-limit-exceeded");
  assert.deepEqual(resourceOverflow.candidates, []);
});

test("raw provider fields, secret-shaped data, unsafe URLs and catalog claims are rejected", async () => {
  const assignmentShapedSecret = ["tok", "en=", "providercredential123"].join("");
  const unsafeQueryUrl = new URL("https://example.test/");
  unsafeQueryUrl.searchParams.set(["tok", "en"].join(""), "redacted");
  const cases = [
    { ...candidate, rawProviderObject: { id: 1 } },
    { ...candidate, urls: [{ kind: "service", url: "https://user:pass@example.test/" }] },
    { ...candidate, urls: [{ kind: "service", url: unsafeQueryUrl.toString() }] },
    { ...candidate, metadata: { token: "redacted" } },
    { ...candidate, catalogProjectId: "example" },
    { ...candidate, name: assignmentShapedSecret },
  ];
  for (const unsafeCandidate of cases) {
    const result = await runInventoryAdapter({
      binding,
      adapter: adapterFor({ status: "success", observedAt: NOW, pagesRead: 1, candidates: [unsafeCandidate] }),
      environment: { FIXTURE_INVENTORY_TOKEN: "runtime-value" },
      now: NOW,
    });
    assert.equal(result.execution.state, "failed");
    assert.deepEqual(result.candidates, []);
  }
});

test("status remains a provider observation and stale candidates cannot look current", async () => {
  const result = await runInventoryAdapter({
    binding,
    adapter: adapterFor({
      status: "success",
      observedAt: "2026-08-13T11:55:00.000Z",
      pagesRead: 1,
      candidates: [{ ...candidate, status: "stopped", observedAt: "2026-08-01T10:00:00.000Z" }],
    }),
    environment: { FIXTURE_INVENTORY_TOKEN: "runtime-value" },
    now: NOW,
  });
  assert.equal(result.execution.state, "succeeded");
  assert.equal(result.freshness.state, "fresh");
  assert.equal(result.candidates[0].status, "stopped");
  assert.equal(result.candidates[0].freshness, "stale");
  assert.equal(result.candidates[0].catalogMatch, undefined);

  const forged = structuredClone(result);
  forged.candidates[0].freshness = "fresh";
  assert.throws(
    () => validateNormalizedInventoryResult(forged),
    (error) => error instanceof InventoryAdapterContractError && error.code === "invalid-contract",
  );
});

test("normalized parser is strict and never accepts failed results with candidates", () => {
  assert.throws(
    () => parseNormalizedInventoryResult("{broken"),
    (error) => error instanceof InventoryAdapterContractError && error.code === "invalid-json",
  );
  assert.throws(
    () => validateNormalizedInventoryResult({
      formatVersion: 1,
      source: { adapterId: binding.adapterId, provider: binding.provider, scope: binding.scope },
      execution: { state: "failed", reason: "provider-unavailable", pagesRead: 1 },
      freshness: { state: "unknown", observedAt: null, validUntil: null, evaluatedAt: NOW },
      candidates: [{ ...candidate, observedAt: NOW, validUntil: NOW, freshness: "fresh" }],
    }),
    (error) => error instanceof InventoryAdapterContractError && error.code === "invalid-contract",
  );
});
