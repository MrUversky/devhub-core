import type { EvidenceAdapter } from "../evidence-adapters.mjs";
import type { GitHubFetch } from "./providers/github-deployment.mjs";

export type EvidenceAdapterRegistry = {
  ids: readonly string[];
  get(adapterId: string): EvidenceAdapter | null;
};

export function createEvidenceAdapterRegistry(options?: {
  fetch?: GitHubFetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}): EvidenceAdapterRegistry;
export const evidenceAdapterRegistry: EvidenceAdapterRegistry;
