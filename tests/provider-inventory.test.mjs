import assert from "node:assert/strict";
import test from "node:test";

import {
  parseProviderInventoryDocument,
  reconcileProviderInventory,
  runProviderInventory,
} from "../scripts/provider-inventory.mjs";
import { defineConnectorContract } from "../lib/connector-conformance.mjs";
import { CONNECTOR_CONTRACTS } from "../lib/connector-contracts.mjs";
import { VERCEL_INVENTORY_ADAPTER_ID, createVercelInventoryAdapter } from "../lib/inventory-adapters/providers/vercel.mjs";
import { createInventoryAdapterRegistry } from "../lib/inventory-adapters/registry.mjs";

const NOW = "2026-08-13T12:00:00.000Z";
const LATER = "2026-08-14T12:00:00.000Z";
const scope = { kind: "workspace", id: "11111111-1111-4111-8111-111111111111" };

function sourceCatalog() {
  return {
    hosts: [
      { id: "railway", name: "Railway", kind: "cloud", location: "cloud" },
      { id: "example-laptop", name: "Laptop", kind: "mac", location: "local" },
    ],
    hostIds: new Set(["railway", "example-laptop"]),
    projects: [
      {
        file: "pocket-ops.yaml",
        source: "/catalog/projects/pocket-ops.yaml",
        manifest: {
          version: 1,
          id: "pocket-ops",
          title: "Pocket Ops",
          registration: "overlay",
          description: "Reviewed project.",
          lifecycle: "active",
          kind: "product",
          repository: "acme/pocket-ops",
          services: [{
            id: "web",
            name: "Web",
            kind: "website",
            environment: "production",
            host: "railway",
            runtime: "managed",
            mode: "managed",
            visibility: "public",
            url: "https://pocket.example.test",
          }],
        },
      },
      {
        file: "domain-peer.yaml",
        source: "/catalog/projects/domain-peer.yaml",
        manifest: {
          version: 1,
          id: "domain-peer",
          title: "Domain peer",
          registration: "overlay",
          description: "Ambiguous fixture.",
          lifecycle: "active",
          kind: "product",
          services: [{
            id: "app",
            name: "App",
            kind: "website",
            environment: "production",
            host: "railway",
            runtime: "managed",
            mode: "managed",
            visibility: "public",
            url: "https://pocket.example.test/peer",
          }],
        },
      },
    ],
  };
}

function candidate(overrides = {}) {
  return {
    provider: "railway",
    resourceType: "project",
    resourceId: "22222222-2222-4222-8222-222222222222",
    parentResourceId: scope.id,
    name: "Remote Project",
    urls: [],
    observedAt: NOW,
    validUntil: LATER,
    freshness: "fresh",
    metadata: { workspaceId: scope.id, projectId: "22222222-2222-4222-8222-222222222222" },
    ...overrides,
  };
}

function observation(candidates, overrides = {}) {
  return {
    formatVersion: 1,
    source: { adapterId: "railway-inventory-v1", provider: "railway", scope },
    execution: { state: "succeeded", reason: "adapter-observation", pagesRead: 2 },
    freshness: { state: "fresh", observedAt: NOW, validUntil: LATER, evaluatedAt: NOW },
    candidates,
    ...overrides,
  };
}

function catalogDecision(overrides = {}) {
  return {
    resourceType: "project",
    resourceId: "22222222-2222-4222-8222-222222222222",
    disposition: "catalog",
    projectId: "pocket-ops",
    ...overrides,
  };
}

test("only an explicit reviewed exact identity becomes matched", () => {
  const result = reconcileProviderInventory(sourceCatalog(), observation([candidate()]), [catalogDecision()]);
  assert.equal(result.items[0].status, "matched");
  assert.deepEqual(result.items[0].catalogMatch, {
    projectId: "pocket-ops",
    serviceId: null,
    tier: "exact-provider-identity",
  });
  assert.equal(result.items[0].candidate.status, undefined);
  assert.equal("action" in result.items[0], false);
  assert.equal("score" in result, false);
});

test("repository, domain and name stay supporting evidence and ambiguity never matches", () => {
  const repositoryOnly = reconcileProviderInventory(sourceCatalog(), observation([candidate({
    repository: { provider: "github", owner: "acme", name: "pocket-ops" },
  })]));
  assert.equal(repositoryOnly.items[0].status, "possible-match");
  assert.equal(repositoryOnly.items[0].catalogMatch, null);
  assert.deepEqual(repositoryOnly.items[0].possibleMatches.map((item) => item.projectId), ["pocket-ops"]);

  const ambiguous = reconcileProviderInventory(sourceCatalog(), observation([candidate({
    resourceType: "service-instance",
    resourceId: "33333333-3333-4333-8333-333333333333:44444444-4444-4444-8444-444444444444",
    name: "Unrelated",
    urls: [{ kind: "service", url: "https://pocket.example.test" }],
  })]));
  assert.equal(ambiguous.items[0].status, "possible-match");
  assert.equal(ambiguous.items[0].ambiguous, true);
  assert.equal(ambiguous.items[0].catalogMatch, null);
  assert.equal(ambiguous.items[0].possibleMatches.length, 2);
});

test("reviewed-external is a separate reviewed decision, never provider truth", () => {
  const decision = {
    resourceType: "project",
    resourceId: "22222222-2222-4222-8222-222222222222",
    disposition: "external",
    note: "Owned by the client and intentionally tracked outside this catalog.",
  };
  const result = reconcileProviderInventory(sourceCatalog(), observation([candidate()]), [decision]);
  assert.equal(result.items[0].status, "reviewed-external");
  assert.equal(result.items[0].reviewedDecision.source, "reviewed-inventory-decision");
  assert.equal(result.items[0].catalogMatch, null);
  assert.equal(result.items[0].proposal, null);
});

test("unregistered remote project gets a schema-valid minimal overlay proposal without writes or inventions", () => {
  const catalog = sourceCatalog();
  const result = reconcileProviderInventory(catalog, observation([candidate({
    name: "Remote Billing Tool",
    repository: { provider: "github", owner: "acme", name: "remote-billing" },
    urls: [{ kind: "console", url: "https://railway.app/project/example" }],
    status: "running",
  })]), [], { projectDirectory: "/reviewed/catalog/projects" });
  const item = result.items[0];
  assert.equal(item.status, "unregistered");
  assert.equal(item.proposal.writes, false);
  assert.equal(item.proposal.transport, "stdout");
  assert.equal(item.proposal.reviewDestination, "/reviewed/catalog/projects/remote-billing.yaml");
  assert.deepEqual(item.proposal.manifest, {
    version: 1,
    id: "remote-billing",
    title: "Remote Billing Tool",
    registration: "overlay",
    description: "Review-only overlay candidate for Remote Billing Tool.",
    lifecycle: "discovery",
    kind: "project",
    repository: "acme/remote-billing",
    services: [],
  });
  assert.equal(item.proposal.manifest.workspaces, undefined);
  assert.deepEqual(item.proposal.evidence.reviewedCloudHost, { id: "railway", name: "Railway" });
  assert.equal(item.proposal.yaml.includes("https://railway.app"), false);
  assert.equal(item.proposal.yaml.includes("running"), false);
  assert.match(item.proposal.unknowns.map((entry) => entry.reason).join(" "), /no service host|require review/i);
});

test("unknown or stale provider scope cannot become matched or unregistered", () => {
  const failed = observation([], {
    execution: { state: "failed", reason: "credential-unavailable", pagesRead: 0 },
    freshness: { state: "unknown", observedAt: null, validUntil: null, evaluatedAt: NOW },
  });
  const unavailable = reconcileProviderInventory(sourceCatalog(), failed, [catalogDecision()]);
  assert.equal(unavailable.items.length, 1);
  assert.equal(unavailable.items[0].status, "unknown");
  assert.equal(unavailable.items[0].candidate, null);
  assert.match(unavailable.items[0].reason, /unavailable/);

  const stale = observation([candidate()], {
    freshness: { state: "stale", observedAt: NOW, validUntil: NOW, evaluatedAt: LATER },
  });
  const historical = reconcileProviderInventory(sourceCatalog(), stale, [catalogDecision()]);
  assert.equal(historical.items[0].status, "unknown");
  assert.equal(historical.items[0].catalogMatch, null);
  assert.match(historical.items[0].reason, /historical candidates/);

  const candidateStale = observation([candidate({ validUntil: NOW, freshness: "stale" })], {
    freshness: { state: "fresh", observedAt: NOW, validUntil: LATER, evaluatedAt: LATER },
  });
  const historicalCandidate = reconcileProviderInventory(sourceCatalog(), candidateStale, [catalogDecision()]);
  assert.equal(historicalCandidate.items[0].status, "unknown");
  assert.equal(historicalCandidate.items[0].catalogMatch, null);
  assert.equal(historicalCandidate.items[0].provenance.freshness, "fresh");
  assert.equal(historicalCandidate.items[0].provenance.candidate.freshness, "stale");
  assert.match(historicalCandidate.items[0].reason, /observation is stale/);
});

test("a reviewed resource absent from fresh bounded inventory is unknown, never called orphaned or deleted", () => {
  const result = reconcileProviderInventory(sourceCatalog(), observation([]), [catalogDecision()]);
  assert.equal(result.items[0].status, "unknown");
  assert.match(result.items[0].reason, /does not prove deletion or non-use/);
  assert.doesNotMatch(JSON.stringify(result), /orphaned|delete|remove/i);
});

test("results are deterministic and unsafe or forged decision documents fail closed", () => {
  const candidates = [
    candidate({ resourceId: "99999999-9999-4999-8999-999999999999", name: "Zeta" }),
    candidate({ resourceId: "22222222-2222-4222-8222-222222222222", name: "Alpha" }),
  ];
  const first = reconcileProviderInventory(sourceCatalog(), observation(candidates));
  const second = reconcileProviderInventory(sourceCatalog(), observation([...candidates].reverse()));
  assert.deepEqual(first, second);
  assert.throws(
    () => parseProviderInventoryDocument({ formatVersion: 1, execution: { state: "succeeded" }, candidates: [] }),
    (error) => error.code === "unsupported-inventory-input",
  );
  assert.throws(
    () => parseProviderInventoryDocument({ version: 1, binding: {}, decisions: [{
      ...catalogDecision(),
      note: "token=abc123456789",
    }] }),
    (error) => error.code === "unsafe-inventory-decision",
  );
  assert.throws(
    () => parseProviderInventoryDocument({ version: 1, binding: {}, decisions: [catalogDecision(), catalogDecision()] }),
    (error) => error.code === "duplicate-inventory-decision",
  );
});

test("production seam consumes a registered runner observation and preflights decisions before collection", async () => {
  let calls = 0;
  const adapter = {
    id: "fixture-inventory-v1",
    provider: "fixture-cloud",
    validateScope(value) { return value.kind === "workspace" && value.id === "workspace-42"; },
    async collect() {
      calls += 1;
      return {
        status: "success",
        observedAt: NOW,
        pagesRead: 1,
        candidates: [{
          provider: "fixture-cloud",
          resourceType: "project",
          resourceId: "remote-42",
          name: "Remote 42",
          urls: [],
        }],
      };
    },
  };
  const registry = new Map([[adapter.id, adapter]]);
  const contracts = [defineConnectorContract({
    formatVersion: 1,
    connectorId: "fixture-cloud",
    provider: "fixture-cloud",
    compatibility: { status: "experimental", since: "0.10.0", deprecatedSince: null, replacementConnectorId: null },
    capabilities: { profiles: [], setup: [], inventory: [{ id: adapter.id, formatVersion: 1 }], evidence: [] },
    limits: { deadlineMs: 1000, maxPages: 3, maxResponseBytes: 1024, maxCandidates: 10 },
    boundaries: {
      exactScope: true,
      credentialIsolation: true,
      readOnly: true,
      hardDeadline: true,
      boundedPagination: true,
      boundedResponses: true,
      boundedCandidates: true,
      freshnessRequired: true,
      secretsRejected: true,
      normalizedOnly: true,
      providerMutations: false,
      catalogWrites: false,
      catalogMatching: false,
      ownershipDecisions: false,
    },
  })];
  const document = {
    version: 1,
    binding: {
      adapterId: adapter.id,
      provider: adapter.provider,
      scope: { kind: "workspace", id: "workspace-42" },
      credentialEnv: null,
      freshForSeconds: 3600,
      maxResources: 10,
      maxPages: 3,
      deadlineMs: 1000,
    },
    decisions: [],
  };
  const result = await runProviderInventory(sourceCatalog(), document, { registry, contracts, environment: {}, now: NOW });
  assert.equal(calls, 1);
  assert.equal(result.items[0].status, "unregistered");
  assert.equal(result.items[0].candidate.validUntil, "2026-08-13T13:00:00.000Z");

  await assert.rejects(
    runProviderInventory(sourceCatalog(), {
      ...document,
      decisions: [{ ...catalogDecision(), projectId: "missing-project" }],
    }, { registry, contracts, environment: {}, now: NOW }),
    (error) => error.code === "catalog-inventory-mismatch",
  );
  assert.equal(calls, 1, "invalid reviewed decisions must fail before provider access");
});

test("production inventory seam rejects every Vercel contract-limit overflow before provider IO", async () => {
  let calls = 0;
  const adapter = createVercelInventoryAdapter({ fetch: async () => {
    calls += 1;
    throw new Error("must not run");
  } });
  const registry = new Map([[VERCEL_INVENTORY_ADAPTER_ID, adapter]]);
  const base = {
    adapterId: VERCEL_INVENTORY_ADAPTER_ID,
    provider: "vercel",
    scope: { kind: "team", id: "team_fictionalstudio" },
    credentialEnv: "FICTIONAL_VERCEL_TOKEN",
    freshForSeconds: 3600,
    maxResources: 200,
    maxPages: 20,
    deadlineMs: 10_000,
    maxResponseBytes: 1024 * 1024,
  };
  for (const change of [
    { maxResources: 201 },
    { maxPages: 21 },
    { deadlineMs: 10_001 },
    { maxResponseBytes: 1024 * 1024 + 1 },
  ]) {
    await assert.rejects(
      runProviderInventory(sourceCatalog(), { version: 1, binding: { ...base, ...change }, decisions: [] }, {
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

test("production OpenAI inventory preflights a missing Keychain reference before provider IO", async () => {
  let calls = 0;
  const registry = createInventoryAdapterRegistry({ fetch: async () => {
    calls += 1;
    throw new Error("must not run");
  } });
  const result = await runProviderInventory(sourceCatalog(), {
    version: 1,
    binding: {
      adapterId: "openai-project-inventory-v1",
      provider: "openai",
      scope: {
        kind: "project",
        id: "proj_fictional_pocket_ops",
        parent: { kind: "workspace", id: "org_fictional_studio" },
      },
      credentialRef: { kind: "keychain", locator: "generic-password:devhub:openai-admin" },
      freshForSeconds: 3600,
      maxResources: 1,
      maxPages: 1,
      deadlineMs: 1000,
      maxResponseBytes: 1024 * 1024,
    },
    decisions: [],
  }, {
    registry,
    resolveCredential: async () => undefined,
    now: NOW,
  });
  assert.equal(result.freshness.state, "unknown");
  assert.equal(result.summary.items, 1);
  assert.equal(result.items[0].status, "unknown");
  assert.equal(calls, 0);
  assert.doesNotMatch(JSON.stringify(result), /generic-password|openai-admin/);
});
