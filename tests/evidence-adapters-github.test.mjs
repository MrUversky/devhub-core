import assert from "node:assert/strict";
import test from "node:test";

import { createGitHubDeploymentAdapter } from "../lib/evidence-adapters/providers/github-deployment.mjs";
import { createGitHubReleaseDeploymentAdapter } from "../lib/evidence-adapters/providers/github-release-deployment.mjs";
import { createGitHubWorkflowMonitoringAdapter } from "../lib/evidence-adapters/providers/github-workflow-monitoring.mjs";
import { createMemoryEvidenceCache, runEvidenceAdapter } from "../lib/evidence-adapters.mjs";

const NOW = "2026-08-13T12:00:00.000Z";
const REPOSITORY = { full_name: "acme-example/pocket-ops" };
const DEPLOYMENT_IDENTITY = Object.freeze({
  owner: "acme-example",
  repository: "pocket-ops",
  workflowId: "410",
  runId: "8100",
  environment: "production",
  deploymentId: "9200",
  statusId: "9300",
});
const MONITORING_IDENTITY = Object.freeze({
  owner: "acme-example",
  repository: "pocket-ops",
  workflowId: "510",
  branch: "main",
  lookbackHours: 24,
});
const RELEASE_IDENTITY = Object.freeze({
  owner: "acme-example",
  repository: "pocket-ops",
  tag: "v1.2.3",
  releaseId: "9400",
  targetCommitish: "main",
  targetSha: "abcdef0123456789abcdef0123456789abcdef01",
});

function response(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fixtureFetch(fixtures, calls) {
  return async (url, options) => {
    calls.push({ url, options });
    const path = new URL(url).pathname + new URL(url).search;
    return fixtures.get(path) ?? response({ message: "fixture missing" }, 404);
  };
}

test("deployment adapter verifies only an exact reviewed GitHub identity", async () => {
  const calls = [];
  const fixtures = new Map([
    ["/repos/acme-example/pocket-ops/actions/workflows/410", response({ id: 410, html_url: "https://github.com/acme-example/pocket-ops/actions/workflows/deploy.yml" })],
    ["/repos/acme-example/pocket-ops/actions/runs/8100", response({ id: 8100, workflow_id: 410, repository: REPOSITORY, head_sha: "0123456789abcdef0123456789abcdef01234567", conclusion: "success", updated_at: "2026-08-13T11:56:00Z", html_url: "https://github.com/acme-example/pocket-ops/actions/runs/8100" })],
    ["/repos/acme-example/pocket-ops/deployments/9200", response({ id: 9200, environment: "production", sha: "0123456789abcdef0123456789abcdef01234567" })],
    ["/repos/acme-example/pocket-ops/deployments/9200/statuses/9300", response({ id: 9300, deployment_url: "https://api.github.com/repos/acme-example/pocket-ops/deployments/9200", state: "success", updated_at: "2026-08-13T11:57:00Z" })],
  ]);
  const adapter = createGitHubDeploymentAdapter({ fetch: fixtureFetch(fixtures, calls) });
  const result = await adapter.collect(Object.freeze({
    provider: "github",
    reviewedIdentity: DEPLOYMENT_IDENTITY,
    checks: Object.freeze(["deployment"]),
    credential: "fictional-token",
    now: NOW,
  }));

  assert.equal(result.status, "success");
  assert.deepEqual(result.observedIdentity, DEPLOYMENT_IDENTITY);
  assert.equal(result.evidence[0].check, "deployment");
  assert.equal(result.deployment.revision, "0123456789abcdef0123456789abcdef01234567");
  assert.match(result.deployment.identity, /environment-production\/deployment-9200\/status-9300$/);
  assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => call.options.method === "GET"));
  assert.ok(calls.every((call) => call.options.headers.authorization === "Bearer fictional-token"));
  assert.equal(JSON.stringify(result).includes("fictional-token"), false);
});

test("deployment mismatch is unknown and does not expose provider content", async () => {
  const fixtures = new Map([
    ["/repos/acme-example/pocket-ops/actions/workflows/410", response({ id: 410 })],
    ["/repos/acme-example/pocket-ops/actions/runs/8100", response({ id: 8100, workflow_id: 999, repository: REPOSITORY, head_sha: "a", conclusion: "success", updated_at: NOW })],
    ["/repos/acme-example/pocket-ops/deployments/9200", response({ id: 9200, environment: "production", sha: "a" })],
    ["/repos/acme-example/pocket-ops/deployments/9200/statuses/9300", response({ id: 9300, deployment_url: "https://api.github.com/repos/acme-example/pocket-ops/deployments/9200", state: "success", updated_at: NOW })],
  ]);
  const adapter = createGitHubDeploymentAdapter({ fetch: fixtureFetch(fixtures, []) });
  const result = await adapter.collect({
    provider: "github",
    reviewedIdentity: DEPLOYMENT_IDENTITY,
    checks: ["deployment"],
    credential: "fictional-token",
    now: NOW,
  });

  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "provider-identity-mismatch");
  assert.equal("evidence" in result, false);
  assert.equal("deployment" in result, false);
});

test("workflow monitor emits only aggregate conclusions for its reviewed workflow", async () => {
  const calls = [];
  const fixtures = new Map([
    ["/repos/acme-example/pocket-ops/actions/workflows/510", response({ id: 510, html_url: "https://github.com/acme-example/pocket-ops/actions/workflows/monitor.yml" })],
    ["/repos/acme-example/pocket-ops/actions/workflows/510/runs?branch=main&created=%3E%3D2026-08-12T12%3A00%3A00.000Z&per_page=100", response({
      total_count: 2,
      workflow_runs: [
        { id: 1, workflow_id: 510, head_branch: "main", repository: REPOSITORY, conclusion: "success", updated_at: "2026-08-13T11:30:00Z", html_url: "https://github.com/acme-example/pocket-ops/actions/runs/1", name: "private run title" },
        { id: 2, workflow_id: 510, head_branch: "main", repository: REPOSITORY, conclusion: "failure", updated_at: "2026-08-13T10:30:00Z", html_url: "https://github.com/acme-example/pocket-ops/actions/runs/2", name: "secret-ish incident detail" },
      ],
    })],
  ]);
  const adapter = createGitHubWorkflowMonitoringAdapter({ fetch: fixtureFetch(fixtures, calls) });
  const result = await adapter.collect(Object.freeze({
    provider: "github",
    reviewedIdentity: MONITORING_IDENTITY,
    checks: Object.freeze(["monitoring"]),
    credential: "fictional-token",
    now: NOW,
  }));

  assert.equal(result.status, "success");
  assert.deepEqual(result.observedIdentity, MONITORING_IDENTITY);
  assert.match(result.evidence[0].note, /latest conclusion success; 1 failed/);
  assert.equal(JSON.stringify(result).includes("private run title"), false);
  assert.equal(JSON.stringify(result).includes("secret-ish incident detail"), false);
  assert.equal(JSON.stringify(result).includes("/actions/runs/2"), false);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.options.method === "GET"));
});

test("workflow monitor refuses a truncated aggregate rather than understating failures", async () => {
  const fixtures = new Map([
    ["/repos/acme-example/pocket-ops/actions/workflows/510", response({ id: 510 })],
    ["/repos/acme-example/pocket-ops/actions/workflows/510/runs?branch=main&created=%3E%3D2026-08-12T12%3A00%3A00.000Z&per_page=100", response({
      total_count: 101,
      workflow_runs: [{ workflow_id: 510, head_branch: "main", repository: REPOSITORY, conclusion: "success", updated_at: NOW }],
    })],
  ]);
  const adapter = createGitHubWorkflowMonitoringAdapter({ fetch: fixtureFetch(fixtures, []) });
  const result = await adapter.collect({
    provider: "github",
    reviewedIdentity: MONITORING_IDENTITY,
    checks: ["monitoring"],
    credential: "fictional-token",
    now: NOW,
  });

  assert.deepEqual(result, { status: "unavailable", reason: "provider-observation-truncated" });
});

test("missing credentials, invalid identities and unavailable GitHub stay unknown", async () => {
  let called = false;
  const adapter = createGitHubWorkflowMonitoringAdapter({ fetch: async () => {
    called = true;
    throw new Error("raw provider error must not escape");
  } });
  const missingCredential = await adapter.collect({
    provider: "github",
    reviewedIdentity: MONITORING_IDENTITY,
    checks: ["monitoring"],
    credential: "",
    now: NOW,
  });
  assert.equal(missingCredential.status, "unavailable");
  assert.equal(missingCredential.reason, "credential-unavailable");
  assert.equal(called, false);

  const invalid = await adapter.collect({
    provider: "github",
    reviewedIdentity: { ...MONITORING_IDENTITY, baseUrl: "https://api.github.com" },
    checks: ["monitoring"],
    credential: "fictional-token",
    now: NOW,
  });
  assert.equal(invalid.reason, "invalid-reviewed-identity");
});

test("unsafe returned provider URLs are omitted from evidence", async () => {
  const fixtures = new Map([
    ["/repos/acme-example/pocket-ops/actions/workflows/410", response({ id: 410 })],
    ["/repos/acme-example/pocket-ops/actions/runs/8100", response({ id: 8100, workflow_id: 410, repository: REPOSITORY, head_sha: "abc", conclusion: "success", updated_at: NOW, html_url: "https://evil.example.test/run?token=secret" })],
    ["/repos/acme-example/pocket-ops/deployments/9200", response({ id: 9200, environment: "production", sha: "abc" })],
    ["/repos/acme-example/pocket-ops/deployments/9200/statuses/9300", response({ id: 9300, deployment_url: "https://api.github.com/repos/acme-example/pocket-ops/deployments/9200", state: "success", updated_at: NOW })],
  ]);
  const adapter = createGitHubDeploymentAdapter({ fetch: fixtureFetch(fixtures, []) });
  const result = await adapter.collect({
    provider: "github",
    reviewedIdentity: DEPLOYMENT_IDENTITY,
    checks: ["deployment"],
    credential: "fictional-token",
    now: NOW,
  });

  assert.equal(result.status, "success");
  assert.equal("url" in result.evidence[0], false);
  assert.equal("url" in result.deployment, false);
});

test("release adapter anonymously verifies exact immutable released source identity", async () => {
  const calls = [];
  const fixtures = new Map([
    ["/repos/acme-example/pocket-ops/releases/tags/v1.2.3", response({ id: 9400, tag_name: "v1.2.3", target_commitish: "main", draft: false, published_at: "2026-08-13T10:00:00Z", html_url: "https://github.com/acme-example/pocket-ops/releases/tag/v1.2.3", body: "raw release notes must not escape" })],
    ["/repos/acme-example/pocket-ops/git/ref/tags/v1.2.3", response({ ref: "refs/tags/v1.2.3", object: { type: "tag", sha: "1111111111111111111111111111111111111111" } })],
    ["/repos/acme-example/pocket-ops/git/tags/1111111111111111111111111111111111111111", response({ tag: "v1.2.3", message: "raw tag message", object: { type: "commit", sha: RELEASE_IDENTITY.targetSha } })],
    [`/repos/acme-example/pocket-ops/git/commits/${RELEASE_IDENTITY.targetSha}`, response({ sha: RELEASE_IDENTITY.targetSha, message: "raw commit message" })],
  ]);
  const adapter = createGitHubReleaseDeploymentAdapter({ fetch: fixtureFetch(fixtures, calls) });
  const result = await adapter.collect(Object.freeze({
    provider: "github",
    reviewedIdentity: RELEASE_IDENTITY,
    checks: Object.freeze(["deployment"]),
    credential: null,
    now: NOW,
  }));

  assert.equal(result.status, "success");
  assert.deepEqual(result.observedIdentity, RELEASE_IDENTITY);
  assert.equal(result.deployment.revision, RELEASE_IDENTITY.targetSha);
  assert.match(result.evidence[0].note, /released source identity/);
  assert.match(result.evidence[0].note, /does not verify live runtime health/);
  assert.ok(calls.every((call) => !("authorization" in call.options.headers)));
  assert.equal(JSON.stringify(result).includes("raw release notes"), false);
  assert.equal(JSON.stringify(result).includes("raw tag message"), false);
  assert.equal(JSON.stringify(result).includes("raw commit message"), false);
});

test("GitHub client times out and bounds JSON before normalization", async () => {
  const oversized = createGitHubReleaseDeploymentAdapter({
    maxResponseBytes: 64,
    fetch: async () => new Response(JSON.stringify({ padding: "x".repeat(100) })),
  });
  const tooLarge = await oversized.collect({
    provider: "github",
    reviewedIdentity: RELEASE_IDENTITY,
    checks: ["deployment"],
    credential: null,
    now: NOW,
  });
  assert.deepEqual(tooLarge, { status: "unavailable", reason: "provider-response-too-large" });

  const slow = createGitHubReleaseDeploymentAdapter({
    timeoutMs: 5,
    fetch: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("fixture aborted")), { once: true });
    }),
  });
  const timedOut = await slow.collect({
    provider: "github",
    reviewedIdentity: RELEASE_IDENTITY,
    checks: ["deployment"],
    credential: null,
    now: NOW,
  });
  assert.deepEqual(timedOut, { status: "unavailable", reason: "provider-timeout" });

  const ignoresAbort = createGitHubReleaseDeploymentAdapter({
    timeoutMs: 5,
    fetch: async () => new Promise(() => {}),
  });
  const ignoredSignal = await ignoresAbort.collect({
    provider: "github",
    reviewedIdentity: RELEASE_IDENTITY,
    checks: ["deployment"],
    credential: null,
    now: NOW,
  });
  assert.deepEqual(ignoredSignal, { status: "unavailable", reason: "provider-timeout" });

  const slowBody = createGitHubReleaseDeploymentAdapter({
    timeoutMs: 5,
    fetch: async () => new Response(new ReadableStream({
      pull() {
        return new Promise(() => {});
      },
    })),
  });
  const bodyTimeout = await slowBody.collect({
    provider: "github",
    reviewedIdentity: RELEASE_IDENTITY,
    checks: ["deployment"],
    credential: null,
    now: NOW,
  });
  assert.deepEqual(bodyTimeout, { status: "unavailable", reason: "provider-timeout" });
});

test("core runner adds freshness and retains a safe cached observation when GitHub is unavailable", async () => {
  const calls = [];
  const fixtures = new Map([
    ["/repos/acme-example/pocket-ops/actions/workflows/410", response({ id: 410 })],
    ["/repos/acme-example/pocket-ops/actions/runs/8100", response({ id: 8100, workflow_id: 410, repository: REPOSITORY, head_sha: "0123456789abcdef0123456789abcdef01234567", conclusion: "success", updated_at: "2026-08-13T11:56:00Z", html_url: "https://github.com/acme-example/pocket-ops/actions/runs/8100" })],
    ["/repos/acme-example/pocket-ops/deployments/9200", response({ id: 9200, environment: "production", sha: "0123456789abcdef0123456789abcdef01234567" })],
    ["/repos/acme-example/pocket-ops/deployments/9200/statuses/9300", response({ id: 9300, deployment_url: "https://api.github.com/repos/acme-example/pocket-ops/deployments/9200", state: "success", updated_at: "2026-08-13T11:57:00Z" })],
  ]);
  const adapter = createGitHubDeploymentAdapter({ fetch: fixtureFetch(fixtures, calls) });
  const cache = createMemoryEvidenceCache();
  const binding = {
    projectId: "example-app",
    serviceId: "web",
    adapterId: adapter.id,
    provider: adapter.provider,
    reviewedIdentity: DEPLOYMENT_IDENTITY,
    credentialEnv: "DEVHUB_GITHUB_TOKEN",
    checks: ["deployment"],
    freshForSeconds: 3600,
  };
  const first = await runEvidenceAdapter({
    binding,
    adapter,
    environment: { DEVHUB_GITHUB_TOKEN: "fictional-token" },
    now: NOW,
    cache,
  });
  assert.equal(first.execution.state, "succeeded");
  assert.equal(first.freshness.state, "fresh");
  assert.equal(first.freshness.validUntil, "2026-08-13T12:57:00.000Z");
  assert.equal(first.evidence[0].source, "integration");

  const cached = await runEvidenceAdapter({
    binding,
    adapter,
    environment: {},
    now: "2026-08-13T12:30:00.000Z",
    cache,
  });
  assert.equal(cached.execution.state, "failed");
  assert.equal(cached.execution.reason, "credential-unavailable");
  assert.equal(cached.execution.cache, "fresh");
  assert.equal(cached.evidence[0].state, "verified");

  const stale = await runEvidenceAdapter({
    binding,
    adapter,
    environment: {},
    now: "2026-08-13T13:30:00.000Z",
    cache,
  });
  assert.equal(stale.execution.cache, "stale");
  assert.equal(stale.freshness.state, "stale");
  assert.equal(stale.evidence[0].state, "verified");
  assert.equal(JSON.stringify(stale).includes("fictional-token"), false);
});
