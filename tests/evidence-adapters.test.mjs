import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  EvidenceAdapterContractError,
  createMemoryEvidenceCache,
  evidenceBindingKey,
  parseEvidenceAdapterResult,
  runEvidenceAdapter,
  validateEvidenceAdapterResult,
  validateEvidenceBinding,
} from "../lib/evidence-adapters.mjs";

const NOW = "2026-08-13T10:05:00.000Z";
const reviewedIdentity = {
  repository: "example/app",
  environment: "production",
  deploymentId: 42,
};
const binding = {
  projectId: "example-app",
  serviceId: "web",
  adapterId: "fixture-deployment",
  provider: "fixture-cloud",
  reviewedIdentity,
  credentialEnv: "FIXTURE_PROVIDER_TOKEN",
  checks: ["deployment", "backup"],
  freshForSeconds: 3600,
};

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`fixtures/evidence-adapters/${name}.json`, import.meta.url), "utf8"));
}

function adapterFor(observation, overrides = {}) {
  return Object.freeze({
    id: "fixture-deployment",
    provider: "fixture-cloud",
    validateIdentity(identity) {
      return identity.repository === "example/app"
        && identity.environment === "production"
        && Number.isInteger(identity.deploymentId);
    },
    async collect(request) {
      assert.ok(Object.isFrozen(request));
      assert.ok(Object.isFrozen(request.reviewedIdentity));
      return structuredClone(observation);
    },
    ...overrides,
  });
}

test("runner normalizes one exact provider observation without leaking credentials", async () => {
  const observation = await fixture("success");
  const result = await runEvidenceAdapter({
    binding,
    adapter: adapterFor(observation),
    environment: { FIXTURE_PROVIDER_TOKEN: "do-not-return-this-secret" },
    now: NOW,
  });

  assert.equal(result.execution.state, "succeeded");
  assert.equal(result.execution.cache, "none");
  assert.equal(result.freshness.state, "fresh");
  assert.equal(result.freshness.observedAt, "2026-08-13T10:00:00.000Z");
  assert.equal(result.freshness.validUntil, "2026-08-13T11:00:00.000Z");
  assert.deepEqual(result.identity.reviewedIdentity, reviewedIdentity);
  assert.deepEqual(result.evidence.map((item) => [item.check, item.state]), [
    ["deployment", "verified"],
    ["backup", "unknown"],
  ]);
  assert.equal(result.recurringCost.observedAt, result.freshness.observedAt);
  assert.doesNotMatch(JSON.stringify(result), /do-not-return-this-secret|FIXTURE_PROVIDER_TOKEN/);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.evidence));
});

test("changed deployment identity fails closed and cannot yield verified evidence", async () => {
  const result = await runEvidenceAdapter({
    binding,
    adapter: adapterFor(await fixture("changed-deployment-identity")),
    environment: { FIXTURE_PROVIDER_TOKEN: "secret-value" },
    now: NOW,
  });

  assert.deepEqual(result.execution, { state: "failed", reason: "identity-mismatch", cache: "none" });
  assert.equal(result.freshness.state, "unknown");
  assert.ok(result.evidence.every((item) => item.state === "unknown"));
  assert.equal(result.deployment, undefined);
});

test("stale observations and stale cached evidence remain visible without looking current", async () => {
  const cache = createMemoryEvidenceCache();
  const stale = await runEvidenceAdapter({
    binding,
    adapter: adapterFor(await fixture("stale-evidence")),
    environment: { FIXTURE_PROVIDER_TOKEN: "secret-value" },
    now: NOW,
    cache,
  });
  assert.equal(stale.execution.state, "succeeded");
  assert.equal(stale.freshness.state, "stale");
  assert.equal(stale.evidence[0].state, "verified");

  const fallback = await runEvidenceAdapter({
    binding,
    adapter: adapterFor(await fixture("unavailable-provider")),
    environment: { FIXTURE_PROVIDER_TOKEN: "secret-value" },
    now: "2026-08-13T11:00:00.000Z",
    cache,
  });
  assert.deepEqual(fallback.execution, { state: "failed", reason: "provider-unavailable", cache: "stale" });
  assert.equal(fallback.freshness.state, "stale");
  assert.equal(fallback.evidence[0].state, "verified");
  assert.equal(fallback.evidence[0].observedAt, "2026-08-01T10:00:00.000Z");
});

test("unavailable provider and missing credential return honest uncached unknown", async () => {
  const unavailable = await fixture("unavailable-provider");
  let calls = 0;
  const adapter = adapterFor(unavailable, {
    async collect() {
      calls += 1;
      return unavailable;
    },
  });
  const missingCredential = await runEvidenceAdapter({ binding, adapter, environment: {}, now: NOW });
  assert.equal(calls, 0);
  assert.deepEqual(missingCredential.execution, { state: "failed", reason: "credential-unavailable", cache: "none" });
  assert.ok(missingCredential.evidence.every((item) => item.state === "unknown"));

  const providerUnavailable = await runEvidenceAdapter({
    binding,
    adapter,
    environment: { FIXTURE_PROVIDER_TOKEN: "secret-value" },
    now: NOW,
  });
  assert.equal(calls, 1);
  assert.equal(providerUnavailable.execution.reason, "provider-unavailable");
});

test("binding validation requires exact typed adapter identity and external credential names", () => {
  const adapter = adapterFor({ status: "unavailable", reason: "unused" });
  const validated = validateEvidenceBinding(binding, adapter);
  assert.deepEqual(validated.reviewedIdentity, reviewedIdentity);
  assert.doesNotMatch(evidenceBindingKey(validated), /FIXTURE_PROVIDER_TOKEN/);

  assert.throws(
    () => validateEvidenceBinding({ ...binding, reviewedIdentity: { repository: "other/app" } }, adapter),
    (error) => error instanceof EvidenceAdapterContractError && error.code === "invalid-identity",
  );
  assert.throws(
    () => validateEvidenceBinding({ ...binding, credentialEnv: "literal-secret" }, adapter),
    (error) => error instanceof EvidenceAdapterContractError && error.code === "invalid-credential-environment",
  );
  assert.throws(
    () => validateEvidenceBinding({ ...binding, reviewedIdentity: { repository: "example/app", token: "bad" } }, adapter),
    (error) => error instanceof EvidenceAdapterContractError && error.code === "unsafe-identity",
  );
});

test("normalized parser rejects provider-specific payloads, raw logs and secret-bearing links", async () => {
  const normalized = await runEvidenceAdapter({
    binding,
    adapter: adapterFor(await fixture("success")),
    environment: { FIXTURE_PROVIDER_TOKEN: "secret-value" },
    now: NOW,
  });
  assert.deepEqual(parseEvidenceAdapterResult(JSON.stringify(normalized)), normalized);
  assert.deepEqual(validateEvidenceAdapterResult(structuredClone(normalized)), normalized);

  assert.throws(
    () => validateEvidenceAdapterResult({ ...normalized, rawLogs: ["provider response"] }),
    (error) => error instanceof EvidenceAdapterContractError && error.code === "invalid-contract",
  );
  const unsafe = structuredClone(normalized);
  const unsafeUrl = new URL("https://provider.example.test/evidence");
  unsafeUrl.searchParams.set("token", "fixture");
  unsafe.evidence[0].url = unsafeUrl.toString();
  assert.throws(
    () => validateEvidenceAdapterResult(unsafe),
    (error) => error instanceof EvidenceAdapterContractError && error.code === "unsafe-adapter-result",
  );

  const falsePass = structuredClone(normalized);
  falsePass.execution = { state: "failed", reason: "provider-unavailable", cache: "none" };
  falsePass.freshness = { state: "unknown", observedAt: null, validUntil: null, evaluatedAt: NOW };
  assert.throws(
    () => validateEvidenceAdapterResult(falsePass),
    (error) => error instanceof EvidenceAdapterContractError && error.code === "invalid-contract",
  );
});

test("adapter exceptions are normalized without copying raw provider errors", async () => {
  const adapter = adapterFor(null, {
    async collect() {
      throw new Error("Authorization: Bearer fixture");
    },
  });
  const result = await runEvidenceAdapter({
    binding,
    adapter,
    environment: { FIXTURE_PROVIDER_TOKEN: "secret-value" },
    now: NOW,
  });
  assert.equal(result.execution.reason, "adapter-error");
  assert.doesNotMatch(JSON.stringify(result), /Bearer|do-not-copy|secret-value/);
});

test("invalid injected cache entries fail closed instead of crashing the refresh", async () => {
  const cache = {
    get() {
      return { providerRaw: { token: "do-not-copy" } };
    },
    set() {},
  };
  const result = await runEvidenceAdapter({
    binding,
    adapter: adapterFor(await fixture("unavailable-provider")),
    environment: { FIXTURE_PROVIDER_TOKEN: "secret-value" },
    now: NOW,
    cache,
  });
  assert.deepEqual(result.execution, { state: "failed", reason: "untrusted-cached-evidence", cache: "none" });
  assert.ok(result.evidence.every((item) => item.state === "unknown"));
  assert.doesNotMatch(JSON.stringify(result), /do-not-copy|secret-value/);
});

test("a formally valid forged cache entry cannot become fallback verified evidence", async () => {
  const genuine = await runEvidenceAdapter({
    binding,
    adapter: adapterFor(await fixture("success")),
    environment: { FIXTURE_PROVIDER_TOKEN: "secret-value" },
    now: NOW,
  });
  const forged = structuredClone(genuine);
  forged.evidence[0].note = "Forged cache entry.";
  const cache = {
    get() {
      return forged;
    },
    set() {},
  };
  const result = await runEvidenceAdapter({
    binding,
    adapter: adapterFor(await fixture("unavailable-provider")),
    environment: { FIXTURE_PROVIDER_TOKEN: "secret-value" },
    now: "2026-08-13T10:30:00.000Z",
    cache,
  });
  assert.deepEqual(result.execution, { state: "failed", reason: "untrusted-cached-evidence", cache: "none" });
  assert.ok(result.evidence.every((item) => item.state === "unknown"));
  assert.doesNotMatch(JSON.stringify(result), /Forged cache entry/);
});

test("cache write failure does not discard a valid provider observation", async () => {
  const result = await runEvidenceAdapter({
    binding,
    adapter: adapterFor(await fixture("success")),
    environment: { FIXTURE_PROVIDER_TOKEN: "secret-value" },
    now: NOW,
    cache: {
      get() { return null; },
      set() { throw new Error("cache unavailable"); },
    },
  });
  assert.equal(result.execution.state, "succeeded");
  assert.equal(result.evidence[0].state, "verified");
});

test("known bearer and provider token shapes are rejected from normalized output", async () => {
  const body = ["abcdefgh", "ijklmnop", "qrstuvwx"].join("");
  for (const note of [
    ["Authorization: ", "Bea", "rer ", body].join(""),
    ["github_", "pat_", body].join(""),
    ["gh", "p_", body].join(""),
    ["sk-", "proj-", body].join(""),
  ]) {
    const observation = await fixture("success");
    observation.evidence[0].note = note;
    const result = await runEvidenceAdapter({
      binding,
      adapter: adapterFor(observation),
      environment: { FIXTURE_PROVIDER_TOKEN: "secret-value" },
      now: NOW,
    });
    assert.equal(result.execution.state, "failed");
    assert.equal(result.execution.reason, "unsafe-adapter-result");
    assert.ok(result.evidence.every((item) => item.state === "unknown"));
    assert.doesNotMatch(JSON.stringify(result), /Bearer|github_pat_|ghp_|sk-proj-/);
  }
});

test("oversized adapter evidence is rejected before normalization", async () => {
  const observation = await fixture("success");
  observation.evidence = Array.from({ length: 51 }, (_, index) => ({
    id: `deployment-${index}`,
    check: "deployment",
    state: "verified",
    note: "Repeated provider item.",
  }));
  const result = await runEvidenceAdapter({
    binding,
    adapter: adapterFor(observation),
    environment: { FIXTURE_PROVIDER_TOKEN: "secret-value" },
    now: NOW,
  });
  assert.equal(result.execution.reason, "invalid-adapter-result");
  assert.ok(result.evidence.every((item) => item.state === "unknown"));
});
