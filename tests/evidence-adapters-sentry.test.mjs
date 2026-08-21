import assert from "node:assert/strict";
import test from "node:test";

import { createSentryMonitoringAdapter } from "../lib/evidence-adapters/providers/sentry-monitoring.mjs";
import { runEvidenceAdapter } from "../lib/evidence-adapters.mjs";

const NOW = "2026-08-13T12:00:00.000Z";
const IDENTITY = Object.freeze({
  organizationSlug: "example-team",
  projectSlug: "pocket-ops",
  environment: "production",
  expectedRelease: "pocket-ops@1.4.0",
  lookbackHours: 24,
});

function response(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function fixtureFetch(fixtures, calls = []) {
  return async (url, options) => {
    calls.push({ url, options });
    const parsed = new URL(url);
    return fixtures.get(`${parsed.pathname}${parsed.search}`) ?? response({ detail: "fixture missing" }, 404);
  };
}

function fixtures({ release = IDENTITY.expectedRelease, issues = [] } = {}) {
  const prefix = "/api/0/projects/example-team/pocket-ops";
  return new Map([
    [`${prefix}/`, response({ slug: "pocket-ops", organization: { slug: "example-team" }, webUrl: "https://sentry.io/organizations/example-team/projects/pocket-ops/", privateField: "discard me" })],
    [`${prefix}/releases/?environment=production&per_page=2`, response([{ version: release, dateReleased: "2026-08-13T11:45:00Z", commitCount: 8, rawCommits: ["discard"] }])],
    [`${prefix}/issues/?environment=production&per_page=100&query=is%3Aunresolved&statsPeriod=24h`, response(issues)],
  ]);
}

test("Sentry verifies exact project monitoring and reviewed release without retaining event content", async () => {
  const calls = [];
  const adapter = createSentryMonitoringAdapter({ fetch: fixtureFetch(fixtures({
    issues: [{ id: "1", lastSeen: "2026-08-13T11:55:00Z", title: "private customer failure", metadata: { secret: "discard" } }],
  }), calls) });
  const result = await runEvidenceAdapter({
    adapter,
    binding: {
      projectId: "example-app",
      serviceId: "production-api",
      adapterId: adapter.id,
      provider: "sentry",
      reviewedIdentity: IDENTITY,
      credentialEnv: "SENTRY_AUTH_TOKEN",
      checks: ["monitoring", "deployment"],
      freshForSeconds: 3600,
    },
    environment: { SENTRY_AUTH_TOKEN: "fictional-sentry-credential" },
    now: NOW,
  });

  assert.equal(result.execution.state, "succeeded");
  assert.equal(result.evidence.find((item) => item.check === "monitoring").state, "verified");
  assert.equal(result.evidence.find((item) => item.check === "deployment").state, "verified");
  assert.equal(result.deployment.identity, "sentry:example-team/pocket-ops@pocket-ops@1.4.0");
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.options.method === "GET"));
  assert.ok(calls.every((call) => call.options.headers.authorization === "Bearer fictional-sentry-credential"));
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("fictional-sentry-credential"), false);
  assert.equal(serialized.includes("private customer failure"), false);
  assert.equal(serialized.includes("rawCommits"), false);
});

test("no Sentry issues remains a bounded observation, never proof of health", async () => {
  const adapter = createSentryMonitoringAdapter({ fetch: fixtureFetch(fixtures()) });
  const result = await adapter.collect({
    provider: "sentry",
    reviewedIdentity: IDENTITY,
    credential: "fictional",
    checks: ["monitoring"],
    now: NOW,
  });
  assert.equal(result.status, "success");
  assert.equal(result.evidence[0].state, "verified");
  assert.match(result.evidence[0].note, /No events is not proof of runtime health/);
});

test("mismatched Sentry release stays unknown while exact project monitoring remains verified", async () => {
  const adapter = createSentryMonitoringAdapter({ fetch: fixtureFetch(fixtures({ release: "pocket-ops@1.3.0" })) });
  const result = await adapter.collect({
    provider: "sentry",
    reviewedIdentity: IDENTITY,
    credential: "fictional",
    checks: ["monitoring", "deployment"],
    now: NOW,
  });
  assert.equal(result.status, "success");
  assert.equal(result.evidence.find((item) => item.check === "monitoring").state, "verified");
  assert.equal(result.evidence.find((item) => item.check === "deployment").state, "unknown");
  assert.equal("deployment" in result, false);
});

test("Sentry denial, oversized response and invalid identity fail closed", async () => {
  const denied = createSentryMonitoringAdapter({ fetch: async () => response({ detail: "private" }, 403) });
  assert.deepEqual(await denied.collect({ provider: "sentry", reviewedIdentity: IDENTITY, credential: "fictional", checks: ["monitoring"], now: NOW }), {
    status: "unavailable",
    reason: "provider-access-denied",
  });

  const oversized = createSentryMonitoringAdapter({
    maxResponseBytes: 32,
    fetch: async () => response({ padding: "x".repeat(100) }),
  });
  assert.deepEqual(await oversized.collect({ provider: "sentry", reviewedIdentity: IDENTITY, credential: "fictional", checks: ["monitoring"], now: NOW }), {
    status: "unavailable",
    reason: "provider-response-too-large",
  });

  const invalid = await denied.collect({
    provider: "sentry",
    reviewedIdentity: { ...IDENTITY, organizationSlug: "https://sentry.io/example-team" },
    credential: "fictional",
    checks: ["monitoring"],
    now: NOW,
  });
  assert.deepEqual(invalid, { status: "unavailable", reason: "invalid-reviewed-identity" });
});

test("Sentry forwards the runner signal through every bounded provider request", async () => {
  const controller = new AbortController();
  const signals = [];
  const adapter = createSentryMonitoringAdapter({
    timeoutMs: 5_000,
    fetch: async (_url, options) => new Promise((_resolve, reject) => {
      signals.push(options.signal);
      options.signal.addEventListener("abort", () => reject(new Error("fixture aborted")), { once: true });
    }),
  });
  const pending = adapter.collect({
    provider: "sentry",
    reviewedIdentity: IDENTITY,
    credential: "fictional",
    checks: ["monitoring", "deployment"],
    now: NOW,
    signal: controller.signal,
    limits: { deadlineMs: 5_000, maxPages: 3, maxResponseBytes: 1024 * 1024, maxCandidates: 2 },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signals.length, 3);
  controller.abort();
  assert.deepEqual(await pending, { status: "unavailable", reason: "provider-timeout" });
  assert.ok(signals.every((signal) => signal.aborted));
});
