import type {
  EvidenceAdapter,
  EvidenceAdapterObservation,
  EvidenceAdapterRequest,
} from "../../evidence-adapters.mjs";
import type { VercelFetch } from "../../inventory-adapters/providers/vercel.mjs";

export type VercelDeploymentIdentity = {
  scope: { kind: "account" | "team"; id: string };
  projectId: string;
  deploymentId: string;
  environment: "production" | "preview";
  revision: string | null;
};
export type VercelDeploymentAdapter = EvidenceAdapter & {
  collect(request: Readonly<EvidenceAdapterRequest>): Promise<EvidenceAdapterObservation>;
};

export const VERCEL_DEPLOYMENT_ADAPTER_ID: "vercel-deployment-v1";
export function validateVercelDeploymentIdentity(identity: unknown): identity is VercelDeploymentIdentity;
export function createVercelDeploymentAdapter(options?: {
  fetch?: VercelFetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}): VercelDeploymentAdapter;
export const vercelDeploymentAdapter: VercelDeploymentAdapter;
