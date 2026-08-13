import type { EvidenceAdapter, EvidenceAdapterRequest, EvidenceAdapterObservation } from "../../evidence-adapters.mjs";

export type GitHubDeploymentIdentity = {
  owner: string;
  repository: string;
  workflowId: string;
  runId: string;
  environment: string;
  deploymentId: string;
  statusId: string;
};

export type GitHubFetch = (input: string, init: RequestInit) => Promise<Response>;
export type GitHubDeploymentAdapter = EvidenceAdapter & {
  collect(request: Readonly<EvidenceAdapterRequest>): Promise<EvidenceAdapterObservation>;
};

export function createGitHubDeploymentAdapter(options?: { fetch?: GitHubFetch; timeoutMs?: number; maxResponseBytes?: number }): GitHubDeploymentAdapter;
export const githubDeploymentAdapter: GitHubDeploymentAdapter;
