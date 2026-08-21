import type { ReadinessCheck } from "./catalog";

export type EvidenceIdentityValue = string | number | boolean | null | EvidenceIdentityValue[] | {
  [key: string]: EvidenceIdentityValue;
};
export type EvidenceAdapterBinding = {
  projectId: string;
  serviceId: string;
  adapterId: string;
  provider: string;
  reviewedIdentity: Record<string, EvidenceIdentityValue>;
  credentialEnv?: string | null;
  credentialRef?: { kind: "environment" | "keychain" | "secret-manager"; locator: string } | null;
  checks: ReadinessCheck[];
  freshForSeconds: number;
  deadlineMs?: number;
  maxPages?: number;
  maxResponseBytes?: number;
  maxCandidates?: number;
};
export type EvidenceAdapterRequest = {
  provider: string;
  reviewedIdentity: Record<string, EvidenceIdentityValue>;
  checks: ReadinessCheck[];
  credential: string | null;
  now: string;
  signal: AbortSignal;
  limits: { deadlineMs: number; maxPages: number; maxResponseBytes: number; maxCandidates: number };
};
export type EvidenceAdapterObservation = {
  status: "success";
  observedIdentity: Record<string, EvidenceIdentityValue>;
  observedAt: string;
  evidence: Array<{
    id: string;
    check: ReadinessCheck;
    state: "verified" | "declared" | "unknown";
    note: string;
    url?: string;
  }>;
  deployment?: { identity?: string; revision?: string; url?: string; host?: string; deployedAt?: string };
  recurringCost?: { state: "present" | "absent" | "unknown"; url?: string };
} | { status: "unavailable"; reason: string };
export type EvidenceAdapter = {
  id: string;
  provider: string;
  validateIdentity(identity: Record<string, EvidenceIdentityValue>): boolean;
  collect(request: Readonly<EvidenceAdapterRequest>): Promise<EvidenceAdapterObservation>;
};
export type NormalizedEvidenceAdapterResult = {
  formatVersion: 1;
  identity: {
    projectId: string;
    serviceId: string;
    adapterId: string;
    provider: string;
    reviewedIdentity: Record<string, EvidenceIdentityValue>;
  };
  execution: {
    state: "succeeded" | "failed";
    reason: string;
    cache: "none" | "fresh" | "stale";
  };
  freshness: {
    state: "fresh" | "stale" | "unknown";
    observedAt: string | null;
    validUntil: string | null;
    evaluatedAt: string;
  };
  evidence: Array<{
    id: string;
    check: ReadinessCheck;
    state: "verified" | "declared" | "unknown";
    source: "integration";
    note: string;
    observedAt?: string;
    validUntil?: string;
    url?: string;
  }>;
  deployment?: { identity?: string; revision?: string; url?: string; host?: string; deployedAt?: string };
  recurringCost?: { state: "present" | "absent" | "unknown"; observedAt: string; url?: string };
};
export class EvidenceAdapterContractError extends Error { code: string }
export function validateEvidenceBinding(binding: EvidenceAdapterBinding, adapter: EvidenceAdapter): Readonly<EvidenceAdapterBinding>;
export function evidenceBindingKey(binding: EvidenceAdapterBinding): string;
export function createMemoryEvidenceCache(): {
  get(key: string): NormalizedEvidenceAdapterResult | null;
  set(key: string, value: NormalizedEvidenceAdapterResult): void;
  clear(): void;
};
export function runEvidenceAdapter(options: {
  binding: EvidenceAdapterBinding;
  adapter: EvidenceAdapter;
  environment?: Record<string, string | undefined>;
  resolveCredential?: (reference: Readonly<{ kind: "environment" | "keychain" | "secret-manager"; locator: string }>) => Promise<string | undefined> | string | undefined;
  now?: Date | string | number;
  cache?: ReturnType<typeof createMemoryEvidenceCache> | null;
}): Promise<NormalizedEvidenceAdapterResult>;
export function validateEvidenceAdapterResult(value: unknown): NormalizedEvidenceAdapterResult;
export function parseEvidenceAdapterResult(json: string): NormalizedEvidenceAdapterResult;
