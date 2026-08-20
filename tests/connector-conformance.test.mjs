import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CONNECTOR_CONFORMANCE_CEILINGS,
  ConnectorConformanceError,
  createConnectorRuntimeRegistry,
  defineConnectorContract,
} from "../lib/connector-conformance.mjs";
import { CONNECTOR_CONTRACTS, connectorContractRegistry } from "../lib/connector-contracts.mjs";
import { evidenceAdapterRegistry } from "../lib/evidence-adapters/registry.mjs";
import { inventoryAdapterRegistry } from "../lib/inventory-adapters/registry.mjs";
import { runInventoryAdapter } from "../lib/inventory-adapters.mjs";
import { createDefaultSetupConnectors } from "../scripts/setup-session.mjs";
import {
  PAPERCRANE_CONNECTOR_CONTRACT,
  PAPERCRANE_CONNECTOR_DEFINITION,
  PAPERCRANE_INVENTORY_ADAPTER_ID,
  createPaperCraneInventoryAdapter,
} from "../examples/connector-sdk/papercrane.mjs";

const NOW = "2026-08-13T12:05:00.000Z";
const fixture = await readFile(
  new URL("../examples/connector-sdk/fixtures/papercrane-workspace.json", import.meta.url),
  "utf8",
);

function binding(changes = {}) {
  return {
    adapterId: PAPERCRANE_INVENTORY_ADAPTER_ID,
    provider: "papercrane",
    scope: { kind: "workspace", id: "paper-team" },
    credentialEnv: "PAPERCRANE_ACCESS_REF",
    freshForSeconds: 3600,
    maxResources: 10,
    maxPages: 2,
    deadlineMs: 1_000,
    maxResponseBytes: 1024 * 1024,
    ...changes,
  };
}

function boundaryContract(changes = {}) {
  return {
    ...structuredClone(PAPERCRANE_CONNECTOR_CONTRACT),
    ...changes,
  };
}

test("a versioned inventory-only connector joins the provider-neutral runtime registry", () => {
  const adapter = createPaperCraneInventoryAdapter({ readPage: async () => fixture });
  const registry = createConnectorRuntimeRegistry({
    contracts: [PAPERCRANE_CONNECTOR_CONTRACT],
    inventoryAdapters: [adapter],
    connectorCatalog: [PAPERCRANE_CONNECTOR_DEFINITION],
  });

  assert.deepEqual(registry.ids, ["papercrane"]);
  assert.deepEqual(registry.get("papercrane").contract, PAPERCRANE_CONNECTOR_CONTRACT);
  assert.equal(registry.getRuntime("inventory", PAPERCRANE_INVENTORY_ADAPTER_ID), adapter);
  assert.equal(registry.getRuntime("evidence", PAPERCRANE_INVENTORY_ADAPTER_ID), null);
  assert.deepEqual(registry.metadata()[0].definition, PAPERCRANE_CONNECTOR_DEFINITION);
  assert.equal(registry.metadata()[0].contract.capabilities.setup.length, 0);
});

test("canonical contracts bind existing setup, inventory and evidence registries without provider branches", () => {
  const setupConnectors = createDefaultSetupConnectors({
    runGh: async () => ({ stdout: "{}" }),
    root: new URL("..", import.meta.url).pathname,
  });
  const registry = createConnectorRuntimeRegistry({
    contracts: CONNECTOR_CONTRACTS,
    setupConnectors,
    inventoryAdapters: inventoryAdapterRegistry,
    evidenceAdapters: evidenceAdapterRegistry,
  });

  assert.deepEqual(registry.ids, connectorContractRegistry.ids);
  assert.equal(registry.get("vercel").runtimes.inventory[0].provider, "vercel");
  assert.equal(registry.get("vercel").runtimes.evidence[0].provider, "vercel");
  assert.equal(registry.get("vercel").runtimes.setup[0].connectorId, "vercel");
  assert.equal(registry.get("sentry").runtimes.evidence[0].provider, "sentry");
  assert.equal(registry.get("railway").runtimes.setup[0].connectorId, "railway");
});

test("the contract validator fails closed on unsafe boundaries, unsupported fields and core-limit overflow", () => {
  assert.throws(
    () => defineConnectorContract(boundaryContract({
      limits: { ...PAPERCRANE_CONNECTOR_CONTRACT.limits, deadlineMs: CONNECTOR_CONFORMANCE_CEILINGS.deadlineMs + 1 },
    })),
    (error) => error instanceof ConnectorConformanceError && error.code === "connector-limit-exceeded",
  );
  assert.throws(
    () => defineConnectorContract(boundaryContract({
      boundaries: { ...PAPERCRANE_CONNECTOR_CONTRACT.boundaries, catalogMatching: true },
    })),
    (error) => error instanceof ConnectorConformanceError && error.code === "unsafe-connector-contract",
  );
  assert.throws(
    () => defineConnectorContract(boundaryContract({ providerOptions: { endpoint: "https://provider.example.test" } })),
    (error) => error instanceof ConnectorConformanceError && error.code === "invalid-connector-contract",
  );
  assert.throws(
    () => defineConnectorContract(boundaryContract({
      capabilities: {
        profiles: [],
        setup: [{ id: "papercrane", formatVersion: 1 }],
        inventory: [],
        evidence: [],
      },
    })),
    /setup capability requires a versioned connection-profile capability/,
  );
  assert.throws(
    () => defineConnectorContract(boundaryContract({
      compatibility: {
        status: "deprecated",
        since: "0.10.0",
        deprecatedSince: null,
        replacementConnectorId: null,
      },
    })),
    /deprecated connector contracts require deprecatedSince/,
  );
  const deprecated = defineConnectorContract(boundaryContract({
    connectorId: "papercrane-legacy",
    compatibility: {
      status: "deprecated",
      since: "0.9.0",
      deprecatedSince: "0.10.0",
      replacementConnectorId: "papercrane",
    },
  }));
  assert.equal(deprecated.compatibility.status, "deprecated");
  assert.equal(deprecated.compatibility.replacementConnectorId, "papercrane");
});

test("registry binding requires canonical metadata and exact runtime provider identity", () => {
  const adapter = createPaperCraneInventoryAdapter({ readPage: async () => fixture });
  assert.throws(
    () => createConnectorRuntimeRegistry({ contracts: [PAPERCRANE_CONNECTOR_CONTRACT], inventoryAdapters: [adapter] }),
    (error) => error instanceof ConnectorConformanceError && error.code === "connector-definition-missing",
  );
  assert.throws(
    () => createConnectorRuntimeRegistry({
      contracts: [PAPERCRANE_CONNECTOR_CONTRACT],
      inventoryAdapters: [{ ...adapter, provider: "other-provider" }],
      connectorCatalog: [PAPERCRANE_CONNECTOR_DEFINITION],
    }),
    (error) => error instanceof ConnectorConformanceError && error.code === "connector-runtime-mismatch",
  );
  assert.throws(
    () => createConnectorRuntimeRegistry({
      contracts: [PAPERCRANE_CONNECTOR_CONTRACT],
      inventoryAdapters: [adapter, { ...adapter, id: "undeclared-inventory-v1" }],
      connectorCatalog: [PAPERCRANE_CONNECTOR_DEFINITION],
    }),
    (error) => error instanceof ConnectorConformanceError && error.code === "connector-runtime-unclaimed",
  );
  assert.throws(
    () => createConnectorRuntimeRegistry({
      contracts: [PAPERCRANE_CONNECTOR_CONTRACT],
      inventoryAdapters: [adapter],
      setupConnectors: [{ connectorId: "undeclared-setup", collect: async () => ({}) }],
      connectorCatalog: [PAPERCRANE_CONNECTOR_DEFINITION],
    }),
    (error) => error instanceof ConnectorConformanceError && error.code === "connector-runtime-unclaimed",
  );
  assert.throws(
    () => createConnectorRuntimeRegistry({
      contracts: [PAPERCRANE_CONNECTOR_CONTRACT],
      inventoryAdapters: [adapter],
      evidenceAdapters: [{
        id: "undeclared-evidence-v1",
        provider: "papercrane",
        validateIdentity: () => true,
        collect: async () => ({ status: "unavailable", reason: "unused" }),
      }],
      connectorCatalog: [PAPERCRANE_CONNECTOR_DEFINITION],
    }),
    (error) => error instanceof ConnectorConformanceError && error.code === "connector-runtime-unclaimed",
  );

  const ambiguousContract = defineConnectorContract({
    ...structuredClone(PAPERCRANE_CONNECTOR_CONTRACT),
    connectorId: "papercrane-shadow",
  });
  assert.throws(
    () => createConnectorRuntimeRegistry({
      contracts: [PAPERCRANE_CONNECTOR_CONTRACT, ambiguousContract],
      inventoryAdapters: [adapter],
      connectorCatalog: [
        PAPERCRANE_CONNECTOR_DEFINITION,
        { ...PAPERCRANE_CONNECTOR_DEFINITION, id: "papercrane-shadow", priority: 2 },
      ],
    }),
    (error) => error instanceof ConnectorConformanceError && error.code === "connector-runtime-claimed-multiple-times",
  );
});

test("fictional adapter isolates exact scope and credentials then emits normalized candidates only", async () => {
  let transportInput;
  const adapter = createPaperCraneInventoryAdapter({
    async readPage(input) {
      transportInput = input;
      return fixture;
    },
  });
  const result = await runInventoryAdapter({
    binding: binding(),
    adapter,
    environment: { PAPERCRANE_ACCESS_REF: "ephemeral-fixture-credential" },
    now: NOW,
  });

  assert.equal(transportInput.workspaceId, "paper-team");
  assert.equal(transportInput.credential, "ephemeral-fixture-credential");
  assert.equal(result.execution.state, "succeeded");
  assert.equal(result.freshness.state, "fresh");
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates[0].metadata, {
    region: "fictional-north-1",
    projectId: "folio-weather",
    environmentId: "lane-live",
    serviceId: "cell-forecast",
  });
  assert.equal(result.candidates[0].catalogMatch, undefined);
  assert.equal(result.candidates[0].owner, undefined);
  assert.doesNotMatch(JSON.stringify(result), /ephemeral-fixture-credential|billingContact|accountLabel/);

  let calls = 0;
  const rejected = await runInventoryAdapter({
    binding: binding({ scope: { kind: "workspace", id: "other-team" } }),
    adapter: createPaperCraneInventoryAdapter({ async readPage() { calls += 1; return fixture; } }),
    environment: { PAPERCRANE_ACCESS_REF: "ephemeral-fixture-credential" },
    now: NOW,
  });
  assert.equal(calls, 1);
  assert.equal(rejected.execution.reason, "provider-scope-mismatch");
  assert.deepEqual(rejected.candidates, []);
});

test("hard deadline, pagination, response and candidate bounds fail with no partial inventory", async () => {
  const timedOut = await runInventoryAdapter({
    binding: binding({ deadlineMs: 100 }),
    adapter: createPaperCraneInventoryAdapter({ readPage: async () => new Promise(() => {}) }),
    environment: { PAPERCRANE_ACCESS_REF: "runtime-only" },
    now: NOW,
  });
  assert.equal(timedOut.execution.reason, "adapter-timeout");
  assert.deepEqual(timedOut.candidates, []);

  const paginated = JSON.stringify({ ...JSON.parse(fixture), nextCursor: "page-two" });
  const pageLimited = await runInventoryAdapter({
    binding: binding({ maxPages: 1 }),
    adapter: createPaperCraneInventoryAdapter({ readPage: async () => paginated }),
    environment: { PAPERCRANE_ACCESS_REF: "runtime-only" },
    now: NOW,
  });
  assert.equal(pageLimited.execution.reason, "provider-page-limit-exceeded");
  assert.deepEqual(pageLimited.candidates, []);

  const responseLimited = await runInventoryAdapter({
    binding: binding({ maxResponseBytes: 64 }),
    adapter: createPaperCraneInventoryAdapter({ readPage: async () => fixture }),
    environment: { PAPERCRANE_ACCESS_REF: "runtime-only" },
    now: NOW,
  });
  assert.equal(responseLimited.execution.reason, "provider-response-too-large");
  assert.deepEqual(responseLimited.candidates, []);

  const twoCandidates = JSON.parse(fixture);
  twoCandidates.folios[0].lanes[0].cells.push({
    ...twoCandidates.folios[0].lanes[0].cells[0],
    cellRef: "cell-rain",
    caption: "Rain edge cell",
  });
  const candidateLimited = await runInventoryAdapter({
    binding: binding({ maxResources: 1 }),
    adapter: createPaperCraneInventoryAdapter({ readPage: async () => JSON.stringify(twoCandidates) }),
    environment: { PAPERCRANE_ACCESS_REF: "runtime-only" },
    now: NOW,
  });
  assert.equal(candidateLimited.execution.reason, "provider-resource-limit-exceeded");
  assert.deepEqual(candidateLimited.candidates, []);
});

test("freshness is explicit and secret-shaped normalized values are rejected", async () => {
  const staleFixture = JSON.stringify({
    ...JSON.parse(fixture),
    capturedAt: "2026-07-01T00:00:00.000Z",
  });
  const stale = await runInventoryAdapter({
    binding: binding(),
    adapter: createPaperCraneInventoryAdapter({ readPage: async () => staleFixture }),
    environment: { PAPERCRANE_ACCESS_REF: "runtime-only" },
    now: NOW,
  });
  assert.equal(stale.execution.state, "succeeded");
  assert.equal(stale.freshness.state, "stale");
  assert.equal(stale.candidates[0].freshness, "stale");

  const unsafeFixture = JSON.parse(fixture);
  unsafeFixture.folios[0].lanes[0].cells[0].caption = ["tok", "en=", "fictionalcredential123"].join("");
  const unsafe = await runInventoryAdapter({
    binding: binding(),
    adapter: createPaperCraneInventoryAdapter({ readPage: async () => JSON.stringify(unsafeFixture) }),
    environment: { PAPERCRANE_ACCESS_REF: "runtime-only" },
    now: NOW,
  });
  assert.equal(unsafe.execution.reason, "unsafe-adapter-result");
  assert.deepEqual(unsafe.candidates, []);
  assert.doesNotMatch(JSON.stringify(unsafe), /fictionalcredential123/);
});
