export type InventoryScope = {
  kind: "account" | "team" | "workspace" | "project";
  id: string;
  parent?: { kind: "account" | "team" | "workspace"; id: string };
};
export type InventoryAdapterBinding = {
  adapterId: string;
  provider: string;
  scope: InventoryScope;
  credentialEnv?: string | null;
  credentialRef?: { kind: "environment" | "keychain" | "secret-manager"; locator: string } | null;
  freshForSeconds: number;
  maxResources?: number;
  maxPages?: number;
  deadlineMs?: number;
  maxResponseBytes?: number;
};
export type InventoryUrl = { kind: "service" | "console" | "status" | "documentation"; url: string };
export type InventoryRepository = { provider: string; owner: string; name: string; ref?: string };
export type InventoryCandidateInput = {
  provider: string;
  resourceType: string;
  resourceId: string;
  parentResourceId?: string;
  name: string;
  environment?: string;
  runtime?: string;
  status?: "running" | "stopped" | "deploying" | "failed" | "unknown";
  urls: InventoryUrl[];
  repository?: InventoryRepository;
  observedAt?: string;
  metadata?: Partial<Record<"region" | "plan" | "version" | "revision" | "deployedAt" | "workspaceId" | "projectId" | "serviceId" | "environmentId" | "deploymentId", string | number | boolean>>;
};
export type InventoryAdapterRequest = {
  provider: string;
  scope: InventoryScope;
  credential: string | null;
  now: string;
  limits: { maxResources: number; maxPages: number; deadlineMs: number; maxResponseBytes: number };
  signal: AbortSignal;
};
export type InventoryAdapterObservation = {
  status: "success";
  observedAt: string;
  pagesRead: number;
  candidates: InventoryCandidateInput[];
} | { status: "unavailable"; reason: string };
export type InventoryAdapter = {
  id: string;
  provider: string;
  validateScope(scope: Readonly<InventoryScope>): boolean;
  collect(request: Readonly<InventoryAdapterRequest>): Promise<InventoryAdapterObservation>;
};
export type NormalizedInventoryCandidate = InventoryCandidateInput & {
  observedAt: string;
  validUntil: string;
  freshness: "fresh" | "stale";
};
export type NormalizedInventoryResult = {
  formatVersion: 1;
  source: { adapterId: string; provider: string; scope: InventoryScope };
  execution: { state: "succeeded" | "failed"; reason: string; pagesRead: number };
  freshness: {
    state: "fresh" | "stale" | "unknown";
    observedAt: string | null;
    validUntil: string | null;
    evaluatedAt: string;
  };
  candidates: NormalizedInventoryCandidate[];
};
export class InventoryAdapterContractError extends Error { code: string }
export function validateInventoryBinding(binding: InventoryAdapterBinding, adapter: InventoryAdapter): Readonly<Required<InventoryAdapterBinding>>;
export function runInventoryAdapter(options: {
  binding: InventoryAdapterBinding;
  adapter: InventoryAdapter;
  environment?: Record<string, string | undefined>;
  resolveCredential?: (reference: Readonly<{ kind: "environment" | "keychain" | "secret-manager"; locator: string }>) => Promise<string | undefined> | string | undefined;
  now?: Date | string | number;
}): Promise<NormalizedInventoryResult>;
export function validateNormalizedInventoryResult(value: unknown): NormalizedInventoryResult;
export function parseNormalizedInventoryResult(json: string): NormalizedInventoryResult;
