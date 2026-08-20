import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createEvidenceAdapterRegistry } from "../lib/evidence-adapters/registry.mjs";
import { VERCEL_DEPLOYMENT_ADAPTER_ID, createVercelDeploymentAdapter } from "../lib/evidence-adapters/providers/vercel-deployment.mjs";
import { CONNECTOR_CONTRACTS } from "../lib/connector-contracts.mjs";
import { readSourceCatalog } from "../scripts/catalog-tools.mjs";
import {
  collectEvidenceBindings,
  parseEvidenceBindingDocument,
  readEvidenceBindingDocument,
} from "../scripts/evidence-collection.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "scripts/devhub.mjs");
const NOW = "2026-08-13T12:00:00.000Z";
const RELEASE_IDENTITY = {
  owner: "acme-example",
  repository: "pocket-ops",
  tag: "v1.2.3",
  releaseId: "9400",
  targetCommitish: "main",
  targetSha: "abcdef0123456789abcdef0123456789abcdef01",
};

function binding(overrides = {}) {
  return {
    projectId: "example-project",
    serviceId: "web",
    adapterId: "github-release-deployment-v1",
    provider: "github",
    reviewedIdentity: RELEASE_IDENTITY,
    checks: ["deployment"],
    freshForSeconds: 3600,
    ...overrides,
  };
}

function sourceCatalog({ projectRepository = "acme-example/private-catalog", serviceRepository = "https://github.com/acme-example/pocket-ops" } = {}) {
  return {
    hosts: [],
    hostIds: new Set(),
    projects: [{
      file: "example-project.yaml",
      source: "/fictional/example-project.yaml",
      manifest: {
        id: "example-project",
        repository: projectRepository,
        services: [{
          id: "web",
          host: "example-host",
          links: serviceRepository ? [{ id: "source", type: "repository", label: "Source", url: serviceRepository }] : [],
        }],
      },
    }],
  };
}

function response(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function releaseFetch(identity, calls) {
  const prefix = `/repos/${identity.owner}/${identity.repository}`;
  const fixtures = new Map([
    [`${prefix}/releases/tags/${encodeURIComponent(identity.tag)}`, response({ id: Number(identity.releaseId), tag_name: identity.tag, target_commitish: identity.targetCommitish, draft: false, published_at: "2026-08-13T10:00:00Z", html_url: `https://github.com/${identity.owner}/${identity.repository}/releases/tag/${identity.tag}` })],
    [`${prefix}/git/ref/tags/${encodeURIComponent(identity.tag)}`, response({ ref: `refs/tags/${identity.tag}`, object: { type: "tag", sha: "1111111111111111111111111111111111111111" } })],
    [`${prefix}/git/tags/1111111111111111111111111111111111111111`, response({ tag: identity.tag, object: { type: "commit", sha: identity.targetSha } })],
    [`${prefix}/git/commits/${identity.targetSha}`, response({ sha: identity.targetSha })],
  ]);
  return async (url, options) => {
    calls.push({ url, options });
    return fixtures.get(new URL(url).pathname) ?? response({ message: "missing fixture" }, 404);
  };
}

test("binding document accepts one strict binding or a versioned list", () => {
  assert.deepEqual(parseEvidenceBindingDocument(binding()), [binding()]);
  assert.deepEqual(parseEvidenceBindingDocument({ version: 1, bindings: [binding()] }), [binding()]);
  assert.throws(
    () => parseEvidenceBindingDocument({ version: 1, bindings: [{ ...binding(), baseUrl: "https://api.github.com" }] }),
    /baseUrl is not supported/,
  );
});

test("OpenAI normalized results cannot bypass an exact reviewed binding document", () => {
  assert.throws(
    () => parseEvidenceBindingDocument({
      formatVersion: 1,
      identity: {
        provider: "openai",
        reviewedIdentity: {
          organizationId: "org_fictional_studio",
          projectId: "proj_fictional_pocket_ops",
          keyId: "key_fictional_shared",
        },
      },
      execution: { state: "succeeded" },
      evidence: [],
    }),
    /formatVersion is not supported/,
  );
});

test("collection matches a reviewed service repository link before anonymous GitHub reads", async () => {
  const calls = [];
  const registry = createEvidenceAdapterRegistry({ fetch: releaseFetch(RELEASE_IDENTITY, calls) });
  const result = await collectEvidenceBindings(sourceCatalog(), [binding()], { registry, environment: {}, now: NOW });

  assert.equal(result.summary.succeeded, 1);
  assert.equal(result.results[0].evidence[0].state, "verified");
  assert.ok(calls.length > 0);
  assert.ok(calls.every((call) => !("authorization" in call.options.headers)));
});

test("a reviewed service repository is authoritative over the project repository", async () => {
  const projectIdentity = { ...RELEASE_IDENTITY, repository: "private-catalog" };
  const calls = [];
  const registry = createEvidenceAdapterRegistry({ fetch: releaseFetch(projectIdentity, calls) });
  await assert.rejects(
    collectEvidenceBindings(sourceCatalog(), [binding({ reviewedIdentity: projectIdentity })], {
      registry,
      environment: {},
      now: NOW,
    }),
    (error) => error.code === "catalog-repository-mismatch",
  );
  assert.equal(calls.length, 0);
});

test("project repository is used only when the service has no repository link", async () => {
  const projectIdentity = { ...RELEASE_IDENTITY, repository: "private-catalog" };
  const calls = [];
  const registry = createEvidenceAdapterRegistry({ fetch: releaseFetch(projectIdentity, calls) });
  const result = await collectEvidenceBindings(
    sourceCatalog({ serviceRepository: null }),
    [binding({ reviewedIdentity: projectIdentity })],
    { registry, environment: {}, now: NOW },
  );
  assert.equal(result.summary.succeeded, 1);
  assert.ok(calls.length > 0);
});

test("all catalog and repository bindings are checked before any network access", async () => {
  let calls = 0;
  const registry = createEvidenceAdapterRegistry({ fetch: async () => {
    calls += 1;
    throw new Error("must not run");
  } });
  await assert.rejects(
    collectEvidenceBindings(sourceCatalog(), [
      binding(),
      binding({ serviceId: "missing-service" }),
    ], { registry, environment: {}, now: NOW }),
    (error) => error.code === "catalog-binding-mismatch",
  );
  assert.equal(calls, 0);

  await assert.rejects(
    collectEvidenceBindings(sourceCatalog({ serviceRepository: null }), [binding()], { registry, environment: {}, now: NOW }),
    (error) => error.code === "catalog-repository-mismatch",
  );
  assert.equal(calls, 0);

});

test("named missing credential becomes unknown without provider access", async () => {
  let calls = 0;
  const registry = createEvidenceAdapterRegistry({ fetch: async () => {
    calls += 1;
    throw new Error("must not run");
  } });
  const result = await collectEvidenceBindings(sourceCatalog(), [binding({ credentialEnv: "DEVHUB_GITHUB_TOKEN" })], {
    registry,
    environment: {},
    now: NOW,
  });
  assert.equal(result.summary.unknown, 1);
  assert.equal(result.results[0].execution.reason, "credential-unavailable");
  assert.equal(result.results[0].evidence[0].state, "unknown");
  assert.equal(calls, 0);
});

test("production OpenAI evidence preflights a missing Keychain reference before provider IO", async () => {
  let calls = 0;
  const registry = createEvidenceAdapterRegistry({ fetch: async () => {
    calls += 1;
    throw new Error("must not run");
  } });
  const result = await collectEvidenceBindings(sourceCatalog(), [{
    projectId: "example-project",
    serviceId: "web",
    adapterId: "openai-project-evidence-v1",
    provider: "openai",
    reviewedIdentity: {
      organizationId: "org_fictional_studio",
      projectId: "proj_fictional_pocket_ops",
      projectName: "Fictional Pocket Ops",
      keyId: "key_fictional_shared",
      access: { project: "yes", billing: "unknown" },
      stewardship: {
        credentialOwner: "example-team",
        billingOwner: null,
        purpose: "Fictional inference",
        lastVerifiedAt: null,
        rotationDueAt: null,
      },
      window: { startTime: "2026-08-01T00:00:00.000Z", endTime: "2026-08-08T00:00:00.000Z" },
    },
    credentialRef: { kind: "keychain", locator: "generic-password:devhub:openai-admin" },
    checks: ["ownership", "cost"],
    freshForSeconds: 3600,
  }], {
    registry,
    resolveCredential: async () => undefined,
    now: NOW,
  });
  assert.equal(result.summary.unknown, 1);
  assert.equal(result.results[0].execution.reason, "credential-unavailable");
  assert.equal(calls, 0);
  assert.doesNotMatch(JSON.stringify(result), /generic-password|openai-admin/);
});

test("production evidence seam rejects every Vercel contract-limit overflow before provider IO", async () => {
  let calls = 0;
  const adapter = createVercelDeploymentAdapter({ fetch: async () => {
    calls += 1;
    throw new Error("must not run");
  } });
  const registry = {
    get(adapterId) { return adapterId === VERCEL_DEPLOYMENT_ADAPTER_ID ? adapter : null; },
  };
  const base = {
    projectId: "example-project",
    serviceId: "web",
    adapterId: VERCEL_DEPLOYMENT_ADAPTER_ID,
    provider: "vercel",
    reviewedIdentity: {
      scope: { kind: "team", id: "team_fictionalstudio" },
      projectId: "prj_FictionalPortfolioApp",
      deploymentId: "dpl_FictionalProduction01",
      environment: "production",
      revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    credentialEnv: "FICTIONAL_VERCEL_TOKEN",
    checks: ["deployment"],
    freshForSeconds: 3600,
    deadlineMs: 10_000,
    maxPages: 20,
    maxResponseBytes: 1024 * 1024,
    maxCandidates: 1,
  };
  for (const change of [
    { deadlineMs: 10_001 },
    { maxPages: 21 },
    { maxResponseBytes: 1024 * 1024 + 1 },
    { maxCandidates: 201 },
  ]) {
    await assert.rejects(
      collectEvidenceBindings(sourceCatalog(), [{ ...base, ...change }], {
        registry,
        contracts: CONNECTOR_CONTRACTS,
        environment: { FICTIONAL_VERCEL_TOKEN: "runtime-only" },
        now: NOW,
      }),
      (error) => error.code === "connector-limit-exceeded",
    );
  }
  assert.equal(calls, 0);
});

test("the shipped release binding matches its reviewed service repository and fictional GitHub responses", async () => {
  let actual;
  try {
    [actual] = await readEvidenceBindingDocument(path.join(root, "config/evidence-bindings/devhub-public-demo-release.json"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    [actual] = await readEvidenceBindingDocument(path.join(root, "config/evidence-bindings/example-release.json"));
  }
  const catalog = await readSourceCatalog(root);
  const calls = [];
  const registry = createEvidenceAdapterRegistry({ fetch: releaseFetch(actual.reviewedIdentity, calls) });
  const result = await collectEvidenceBindings(catalog, [actual], { registry, environment: {}, now: NOW });
  assert.equal(result.summary.succeeded, 1);
  assert.equal(result.results[0].identity.projectId, actual.projectId);
  assert.equal(result.results[0].identity.serviceId, actual.serviceId);
  assert.match(result.results[0].evidence[0].note, /does not verify live runtime health/);
});

test("CLI collects bindings, feeds portfolio review and rejects forged normalized input", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-evidence-cli-"));
  const catalogDirectory = path.join(temporary, "catalog");
  const bindingFile = path.join(temporary, "binding.json");
  const forgedFile = path.join(temporary, "forged.json");
  await mkdir(path.join(catalogDirectory, "projects"), { recursive: true });
  await writeFile(path.join(catalogDirectory, "hosts.yaml"), "version: 1\nhosts:\n  - id: example-host\n    name: Example host\n    kind: cloud\n    location: cloud\n");
  await writeFile(path.join(catalogDirectory, "projects/example-project.yaml"), `version: 1
id: example-project
title: Example project
registration: overlay
description: Fictional evidence CLI project.
lifecycle: active
kind: product
repository: acme-example/pocket-ops
services:
  - id: web
    name: Web
    kind: website
    environment: production
    host: example-host
    runtime: managed
    mode: managed
    visibility: public
`);
  await writeFile(bindingFile, `${JSON.stringify(binding({ credentialEnv: "MISSING_TEST_TOKEN" }), null, 2)}\n`);
  await writeFile(forgedFile, `${JSON.stringify({ formatVersion: 1, evidence: [{ state: "verified" }] })}\n`);
  const environment = { ...process.env, DEVHUB_CATALOG_DIR: catalogDirectory };
  delete environment.MISSING_TEST_TOKEN;

  try {
    const projectPath = path.join(catalogDirectory, "projects/example-project.yaml");
    const catalogBefore = await readFile(projectPath, "utf8");
    const collected = await execFileAsync(process.execPath, [cli, "collect-evidence", bindingFile, "--json"], { cwd: root, env: environment });
    const collection = JSON.parse(collected.stdout);
    assert.equal(collection.readOnly, true);
    assert.equal(collection.summary.unknown, 1);
    assert.equal(collection.results[0].execution.reason, "credential-unavailable");
    assert.equal(await readFile(projectPath, "utf8"), catalogBefore);

    const reviewed = await execFileAsync(process.execPath, [cli, "review-portfolio", "--json", "--evidence-binding", bindingFile], { cwd: root, env: environment });
    const review = JSON.parse(reviewed.stdout);
    assert.equal(review.readOnly, true);
    assert.equal("score" in review, false);
    assert.deepEqual(review.summary.providerEvidence, { received: 1, matched: 1 });
    const providerFinding = review.findings.find((finding) => finding.check === "provider-evidence" && finding.state === "unknown");
    assert.ok(providerFinding);
    assert.equal(typeof providerFinding.recommendedNextAction, "string");
    assert.equal("action" in providerFinding, false);
    assert.equal("execution" in providerFinding, false);
    assert.equal(await readFile(projectPath, "utf8"), catalogBefore);

    await assert.rejects(
      execFileAsync(process.execPath, [cli, "review-portfolio", "--json", "--evidence-fixture", forgedFile], { cwd: root, env: environment }),
      (error) => {
        const failure = JSON.parse(error.stdout);
        assert.equal(failure.error.code, "unsupported-evidence-input");
        return true;
      },
    );
    assert.equal((await readFile(bindingFile, "utf8")).includes("MISSING_TEST_TOKEN"), true);
    assert.equal(await readFile(projectPath, "utf8"), catalogBefore);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
