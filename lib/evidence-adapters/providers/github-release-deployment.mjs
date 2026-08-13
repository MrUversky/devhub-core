import {
  asNow,
  githubJson,
  isoDate,
  providerIdMatches,
  safeGitHubUrl,
  unavailableResult,
  validateGitHubIdentity,
} from "./github-common.mjs";

const ADAPTER_ID = "github-release-deployment-v1";

export function createGitHubReleaseDeploymentAdapter({
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs,
  maxResponseBytes,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("GitHub release adapter requires an injected fetch function");
  const requestOptions = { timeoutMs, maxResponseBytes };

  return Object.freeze({
    id: ADAPTER_ID,
    provider: "github",
    validateIdentity(identity) {
      return validateGitHubIdentity(identity, "release");
    },
    async collect(request) {
      const now = asNow(request?.now);
      if (!now) throw new TypeError("GitHub release adapter requires a valid now value");
      if (request?.provider !== "github" || !request?.checks?.includes("deployment")) {
        return unavailableResult("binding-not-applicable");
      }
      const identity = request.reviewedIdentity;
      if (!validateGitHubIdentity(identity, "release")) return unavailableResult("invalid-reviewed-identity");

      const prefix = `/repos/${identity.owner}/${identity.repository}`;
      const encodedTag = encodeURIComponent(identity.tag);
      const [release, ref] = await Promise.all([
        githubJson(fetchImpl, `${prefix}/releases/tags/${encodedTag}`, request.credential, requestOptions),
        githubJson(fetchImpl, `${prefix}/git/ref/tags/${encodedTag}`, request.credential, requestOptions),
      ]);
      const unavailable = [release, ref].find((result) => !result.ok);
      if (unavailable) return unavailableResult(unavailable.reason);

      if (
        !providerIdMatches(release.value.id, identity.releaseId)
        || release.value.tag_name !== identity.tag
        || release.value.target_commitish !== identity.targetCommitish
        || release.value.draft !== false
        || !ref.value.ref?.endsWith(`/tags/${identity.tag}`)
        || !["tag", "commit"].includes(ref.value.object?.type)
        || typeof ref.value.object?.sha !== "string"
      ) return unavailableResult("provider-identity-mismatch");

      let resolvedSha = ref.value.object.sha;
      if (ref.value.object.type === "tag") {
        const tagObject = await githubJson(fetchImpl, `${prefix}/git/tags/${resolvedSha}`, request.credential, requestOptions);
        if (!tagObject.ok) return unavailableResult(tagObject.reason);
        if (tagObject.value.tag !== identity.tag || tagObject.value.object?.type !== "commit" || typeof tagObject.value.object?.sha !== "string") {
          return unavailableResult("provider-identity-mismatch");
        }
        resolvedSha = tagObject.value.object.sha;
      }

      const commit = await githubJson(fetchImpl, `${prefix}/git/commits/${identity.targetSha}`, request.credential, requestOptions);
      if (!commit.ok) return unavailableResult(commit.reason);
      if (resolvedSha !== identity.targetSha || commit.value.sha !== identity.targetSha) {
        return unavailableResult("provider-identity-mismatch");
      }
      const observedAt = isoDate(release.value.published_at);
      if (!observedAt) return unavailableResult("provider-observation-undated");
      const evidenceUrl = safeGitHubUrl(release.value.html_url);
      const shortRevision = identity.targetSha.slice(0, 12);

      return {
        status: "success",
        observedIdentity: { ...identity },
        observedAt,
        evidence: [{
          id: "github-release-source-deployment",
          check: "deployment",
          state: "verified",
          note: `GitHub release ${identity.tag} verifies released source identity ${shortRevision}; it does not verify live runtime health.`,
          ...(evidenceUrl ? { url: evidenceUrl } : {}),
        }],
        deployment: {
          identity: `${identity.owner}/${identity.repository}#release-${identity.releaseId}/${identity.tag}`,
          revision: identity.targetSha,
        },
      };
    },
  });
}

export const githubReleaseDeploymentAdapter = createGitHubReleaseDeploymentAdapter();
