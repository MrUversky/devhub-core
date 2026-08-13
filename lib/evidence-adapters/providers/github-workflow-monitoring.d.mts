import type { EvidenceAdapter, EvidenceAdapterRequest, EvidenceAdapterObservation } from "../../evidence-adapters.mjs";
import type { GitHubFetch } from "./github-deployment.mjs";

export type GitHubWorkflowMonitoringIdentity = {
  owner: string;
  repository: string;
  workflowId: string;
  branch: string;
  lookbackHours: number;
};

export type GitHubWorkflowMonitoringAdapter = EvidenceAdapter & {
  collect(request: Readonly<EvidenceAdapterRequest>): Promise<EvidenceAdapterObservation>;
};

export function createGitHubWorkflowMonitoringAdapter(options?: { fetch?: GitHubFetch; timeoutMs?: number; maxResponseBytes?: number }): GitHubWorkflowMonitoringAdapter;
export const githubWorkflowMonitoringAdapter: GitHubWorkflowMonitoringAdapter;
