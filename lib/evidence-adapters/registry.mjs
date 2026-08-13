import { createGitHubDeploymentAdapter } from "./providers/github-deployment.mjs";
import { createGitHubReleaseDeploymentAdapter } from "./providers/github-release-deployment.mjs";
import { createGitHubWorkflowMonitoringAdapter } from "./providers/github-workflow-monitoring.mjs";

export function createEvidenceAdapterRegistry(options = {}) {
  const adapters = [
    createGitHubDeploymentAdapter(options),
    createGitHubReleaseDeploymentAdapter(options),
    createGitHubWorkflowMonitoringAdapter(options),
  ];
  const byId = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  return Object.freeze({
    ids: Object.freeze(adapters.map((adapter) => adapter.id).sort()),
    get(adapterId) {
      return byId.get(adapterId) ?? null;
    },
  });
}

export const evidenceAdapterRegistry = createEvidenceAdapterRegistry();
