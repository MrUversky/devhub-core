import {
  asNow,
  githubJson,
  isoDate,
  providerIdMatches,
  repositoryMatches,
  safeGitHubUrl,
  unavailableResult,
  validateGitHubIdentity,
} from "./github-common.mjs";

const ADAPTER_ID = "github-actions-workflow-monitoring-v1";
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

export function createGitHubWorkflowMonitoringAdapter({ fetch: fetchImpl = globalThis.fetch, timeoutMs, maxResponseBytes } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("GitHub workflow monitoring adapter requires an injected fetch function");

  return Object.freeze({
    id: ADAPTER_ID,
    provider: "github",
    validateIdentity(identity) {
      return validateGitHubIdentity(identity, "monitoring");
    },
    async collect(request) {
      const now = asNow(request?.now);
      if (!now) throw new TypeError("GitHub workflow monitoring adapter requires a valid now value");
      if (request?.provider !== "github" || !request?.checks?.includes("monitoring")) {
        return unavailableResult("binding-not-applicable");
      }
      const identity = request.reviewedIdentity;
      if (!validateGitHubIdentity(identity, "monitoring")) return unavailableResult("invalid-reviewed-identity");
      if ((request.limits?.maxPages ?? 2) < 2) return unavailableResult("provider-page-limit-exceeded");
      const requestOptions = {
        timeoutMs: Math.min(timeoutMs ?? DEFAULT_TIMEOUT_MS, request.limits?.deadlineMs ?? Number.MAX_SAFE_INTEGER),
        maxResponseBytes: Math.min(maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, request.limits?.maxResponseBytes ?? Number.MAX_SAFE_INTEGER),
        signal: request.signal,
      };

      const createdAfter = new Date(now.getTime() - identity.lookbackHours * 60 * 60 * 1000).toISOString();
      const query = new URLSearchParams({
        branch: identity.branch,
        created: `>=${createdAfter}`,
        per_page: "100",
      });
      const prefix = `/repos/${identity.owner}/${identity.repository}`;
      const [workflow, runs] = await Promise.all([
        githubJson(fetchImpl, `${prefix}/actions/workflows/${identity.workflowId}`, request.credential, requestOptions),
        githubJson(fetchImpl, `${prefix}/actions/workflows/${identity.workflowId}/runs?${query}`, request.credential, requestOptions),
      ]);
      const unavailable = [workflow, runs].find((result) => !result.ok);
      if (unavailable) return unavailableResult(unavailable.reason);
      if (!providerIdMatches(workflow.value.id, identity.workflowId) || !Array.isArray(runs.value.workflow_runs) || !Number.isSafeInteger(runs.value.total_count)) {
        return unavailableResult("provider-identity-mismatch");
      }
      if (runs.value.total_count !== runs.value.workflow_runs.length) return unavailableResult("provider-observation-truncated");

      const reviewedRuns = runs.value.workflow_runs.filter((run) => (
        providerIdMatches(run.workflow_id, identity.workflowId)
        && run.head_branch === identity.branch
        && repositoryMatches(run.repository?.full_name, identity.owner, identity.repository)
      ));
      if (reviewedRuns.length !== runs.value.workflow_runs.length) {
        return unavailableResult("provider-identity-mismatch");
      }
      const completedRuns = reviewedRuns.filter((run) => typeof run.conclusion === "string" && isoDate(run.updated_at));
      if (!completedRuns.length) return unavailableResult("no-completed-observation");

      completedRuns.sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
      const latest = completedRuns[0];
      const observedAt = isoDate(latest.updated_at);
      const failedRuns = completedRuns.filter((run) => run.conclusion !== "success" && run.conclusion !== "skipped").length;
      const evidenceUrl = safeGitHubUrl(workflow.value.html_url);
      const note = `GitHub Actions monitoring workflow ${identity.workflowId} observed ${completedRuns.length} completed run${completedRuns.length === 1 ? "" : "s"} on ${identity.branch} in ${identity.lookbackHours}h; latest conclusion ${latest.conclusion}; ${failedRuns} failed.`;

      return {
        status: "success",
        observedIdentity: { ...identity },
        observedAt,
        evidence: [{
          id: "github-actions-workflow-monitoring",
          check: "monitoring",
          state: "verified",
          note,
          ...(evidenceUrl ? { url: evidenceUrl } : {}),
        }],
      };
    },
  });
}

export const githubWorkflowMonitoringAdapter = createGitHubWorkflowMonitoringAdapter();
