import type { ConnectorDefinition } from "./connectors.mjs";
import type { EvidenceAdapter } from "./evidence-adapters.mjs";
import type { InventoryAdapter } from "./inventory-adapters.mjs";
import type { SetupConnector } from "./setup-session.mjs";

export type ConnectorCompatibility = Readonly<{
  status: "experimental" | "supported" | "deprecated";
  since: string;
  deprecatedSince: string | null;
  replacementConnectorId: string | null;
}>;

export type ConnectorContractCapability = Readonly<{ id: string; formatVersion: 1 }>;
export type ConnectorContract = Readonly<{
  formatVersion: 1;
  connectorId: string;
  provider: string;
  compatibility: ConnectorCompatibility;
  capabilities: Readonly<{
    profiles: readonly ConnectorContractCapability[];
    setup: readonly ConnectorContractCapability[];
    inventory: readonly ConnectorContractCapability[];
    evidence: readonly ConnectorContractCapability[];
  }>;
  limits: Readonly<{
    deadlineMs: number;
    maxPages: number;
    maxResponseBytes: number;
    maxCandidates: number;
  }>;
  boundaries: Readonly<{
    exactScope: true;
    credentialIsolation: true;
    readOnly: true;
    hardDeadline: true;
    boundedPagination: true;
    boundedResponses: true;
    boundedCandidates: true;
    freshnessRequired: true;
    secretsRejected: true;
    normalizedOnly: true;
    providerMutations: false;
    catalogWrites: false;
    catalogMatching: false;
    ownershipDecisions: false;
  }>;
}>;

export type ConnectorRuntimeEntry = Readonly<{
  definition: ConnectorDefinition;
  contract: ConnectorContract;
  runtimes: Readonly<{
    setup: readonly SetupConnector[];
    inventory: readonly InventoryAdapter[];
    evidence: readonly EvidenceAdapter[];
  }>;
}>;

export class ConnectorConformanceError extends Error { code: string }
export const CONNECTOR_CONTRACT_VERSION: 1;
export const CONNECTOR_CONFORMANCE_CEILINGS: Readonly<{
  deadlineMs: 30000;
  maxPages: 100;
  maxResponseBytes: 2097152;
  maxCandidates: 1000;
}>;
export function validateConnectorContract(value: unknown): ConnectorContract;
export function defineConnectorContract(value: ConnectorContract): ConnectorContract;
export function validateConnectorInventoryExecution(options: {
  contracts: readonly ConnectorContract[];
  binding: import("./inventory-adapters.mjs").InventoryAdapterBinding;
  adapter: InventoryAdapter;
}): Readonly<{
  contract: ConnectorContract;
  binding: Readonly<import("./inventory-adapters.mjs").InventoryAdapterBinding & {
    credentialEnv: string | null;
    maxResources: number;
    maxPages: number;
    deadlineMs: number;
    maxResponseBytes: number;
  }>;
  adapter: InventoryAdapter;
}>;
export function validateConnectorEvidenceExecution(options: {
  contracts: readonly ConnectorContract[];
  binding: import("./evidence-adapters.mjs").EvidenceAdapterBinding;
  adapter: EvidenceAdapter;
}): Readonly<{
  contract: ConnectorContract;
  binding: Readonly<import("./evidence-adapters.mjs").EvidenceAdapterBinding & {
    credentialEnv: string | null;
    deadlineMs: number;
    maxPages: number;
    maxResponseBytes: number;
    maxCandidates: number;
  }>;
  adapter: EvidenceAdapter;
}>;
export function createConnectorContractRegistry(options: {
  contracts: readonly ConnectorContract[];
  connectorCatalog?: readonly ConnectorDefinition[];
}): Readonly<{
  formatVersion: 1;
  ids: readonly string[];
  get(connectorId: string): Readonly<{ definition: ConnectorDefinition; contract: ConnectorContract }> | null;
  list(): readonly Readonly<{ definition: ConnectorDefinition; contract: ConnectorContract }>[];
}>;
export function createConnectorRuntimeRegistry(options: {
  contracts: readonly ConnectorContract[];
  setupConnectors?: readonly SetupConnector[] | ReadonlyMap<string, SetupConnector> | Record<string, SetupConnector>;
  inventoryAdapters?: readonly InventoryAdapter[] | ReadonlyMap<string, InventoryAdapter> | Record<string, InventoryAdapter>;
  evidenceAdapters?: readonly EvidenceAdapter[] | ReadonlyMap<string, EvidenceAdapter> | Record<string, EvidenceAdapter> | {
    ids: readonly string[];
    get(id: string): EvidenceAdapter | null;
  };
  connectorCatalog?: readonly ConnectorDefinition[];
}): Readonly<{
  formatVersion: 1;
  ids: readonly string[];
  get(connectorId: string): ConnectorRuntimeEntry | null;
  list(): readonly ConnectorRuntimeEntry[];
  metadata(): readonly Readonly<{ definition: ConnectorDefinition; contract: ConnectorContract }>[];
  getRuntime(kind: "setup", id: string): SetupConnector | null;
  getRuntime(kind: "inventory", id: string): InventoryAdapter | null;
  getRuntime(kind: "evidence", id: string): EvidenceAdapter | null;
  runInventory(connectorId: string, options: {
    binding: import("./inventory-adapters.mjs").InventoryAdapterBinding;
    environment?: Record<string, string | undefined>;
    now?: Date | string | number;
  }): Promise<import("./inventory-adapters.mjs").NormalizedInventoryResult>;
  runEvidence(connectorId: string, options: {
    binding: import("./evidence-adapters.mjs").EvidenceAdapterBinding;
    environment?: Record<string, string | undefined>;
    now?: Date | string | number;
    cache?: ReturnType<typeof import("./evidence-adapters.mjs").createMemoryEvidenceCache> | null;
  }): Promise<import("./evidence-adapters.mjs").NormalizedEvidenceAdapterResult>;
}>;
