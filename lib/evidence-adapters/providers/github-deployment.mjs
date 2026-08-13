import {
  asNow,
  deploymentUrlMatches,
  githubJson,
  isoDate,
  providerIdMatches,
  repositoryMatches,
  safeGitHubUrl,
  unavailableResult,
  validateGitHubIdentity,
} from "./github-common.mjs";

const ADAPTER_ID = "github-actions-deployment-v1";

export function createGitHubDeploymentAdapter({ fetch: fetchImpl = globalThis.fetch, timeoutMs, maxResponseBytes } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("GitHub deployment adapter requires an injected fetch function");

  return Object.freeze({
    id: ADAPTER_ID,
    provider: "github",
    validateIdentity(identity) {
      return validateGitHubIdentity(identity, "deployment");
    },
    async collect(request) {
      const now = asNow(request?.now);
      if (!now) throw new TypeError("GitHub deployment adapter requires a valid now value");
      if (request?.provider !== "github" || !request?.checks?.includes("deployment")) {
        return unavailableResult("binding-not-applicable");
      }
      const identity = request.reviewedIdentity;
      if (!validateGitHubIdentity(identity, "deployment")) return unavailableResult("invalid-reviewed-identity");

      const prefix = `/repos/${identity.owner}/${identity.repository}`;
      const [workflow, run, deployment, status] = await Promise.all([
        githubJson(fetchImpl, `${prefix}/actions/workflows/${identity.workflowId}`, request.credential, { timeoutMs, maxResponseBytes }),
        githubJson(fetchImpl, `${prefix}/actions/runs/${identity.runId}`, request.credential, { timeoutMs, maxResponseBytes }),
        githubJson(fetchImpl, `${prefix}/deployments/${identity.deploymentId}`, request.credential, { timeoutMs, maxResponseBytes }),
        githubJson(fetchImpl, `${prefix}/deployments/${identity.deploymentId}/statuses/${identity.statusId}`, request.credential, { timeoutMs, maxResponseBytes }),
      ]);
      const unavailable = [workflow, run, deployment, status].find((result) => !result.ok);
      if (unavailable) return unavailableResult(unavailable.reason);

      const exactIdentity = providerIdMatches(workflow.value.id, identity.workflowId)
        && providerIdMatches(run.value.id, identity.runId)
        && providerIdMatches(run.value.workflow_id, identity.workflowId)
        && repositoryMatches(run.value.repository?.full_name, identity.owner, identity.repository)
        && providerIdMatches(deployment.value.id, identity.deploymentId)
        && deployment.value.environment === identity.environment
        && providerIdMatches(status.value.id, identity.statusId)
        && deploymentUrlMatches(status.value.deployment_url, identity)
        && typeof deployment.value.sha === "string"
        && deployment.value.sha === run.value.head_sha;
      if (!exactIdentity) return unavailableResult("provider-identity-mismatch");

      const observedAt = isoDate(status.value.updated_at) ?? isoDate(run.value.updated_at);
      if (!observedAt) return unavailableResult("provider-observation-undated");
      if (status.value.state !== "success" || run.value.conclusion !== "success") {
        return unavailableResult("deployment-not-successful");
      }
      const evidenceUrl = safeGitHubUrl(run.value.html_url);
      const shortRevision = run.value.head_sha.slice(0, 12);
      const note = `GitHub Actions workflow ${identity.workflowId} verified deployment ${identity.deploymentId} to ${identity.environment} at revision ${shortRevision}.`;

      return {
        status: "success",
        observedIdentity: { ...identity },
        observedAt,
        evidence: [{
          id: "github-actions-deployment",
          check: "deployment",
          state: "verified",
          note,
          ...(evidenceUrl ? { url: evidenceUrl } : {}),
        }],
        deployment: {
          identity: `${identity.owner}/${identity.repository}#environment-${identity.environment}/deployment-${identity.deploymentId}/status-${identity.statusId}`,
          revision: run.value.head_sha,
        },
      };
    },
  });
}

export const githubDeploymentAdapter = createGitHubDeploymentAdapter();
