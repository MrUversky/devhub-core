import type { EvidenceAdapter, EvidenceAdapterRequest, EvidenceAdapterObservation } from "../../evidence-adapters.mjs";
import type { GitHubFetch } from "./github-deployment.mjs";

export type GitHubReleaseDeploymentIdentity = {
  owner: string;
  repository: string;
  tag: string;
  releaseId: string;
  targetCommitish: string;
  targetSha: string;
};

export type GitHubReleaseDeploymentAdapter = EvidenceAdapter & {
  collect(request: Readonly<EvidenceAdapterRequest>): Promise<EvidenceAdapterObservation>;
};

export function createGitHubReleaseDeploymentAdapter(options?: {
  fetch?: GitHubFetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}): GitHubReleaseDeploymentAdapter;
export const githubReleaseDeploymentAdapter: GitHubReleaseDeploymentAdapter;
