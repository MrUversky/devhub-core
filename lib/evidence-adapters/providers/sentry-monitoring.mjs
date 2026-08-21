import {
  asSentryNow,
  safeSentryUrl,
  sentryIsoDate,
  sentryJson,
  sentryUnavailable,
  validateSentryIdentity,
} from "./sentry-common.mjs";

export const SENTRY_MONITORING_ADAPTER_ID = "sentry-project-monitoring-v1";

export function createSentryMonitoringAdapter({
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs,
  maxResponseBytes,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("Sentry monitoring adapter requires an injected fetch function");

  return Object.freeze({
    id: SENTRY_MONITORING_ADAPTER_ID,
    provider: "sentry",
    validateIdentity: validateSentryIdentity,
    async collect(request) {
      const now = asSentryNow(request?.now);
      if (!now) throw new TypeError("Sentry monitoring adapter requires a valid now value");
      if (request?.provider !== "sentry" || !request?.checks?.some((check) => check === "monitoring" || check === "deployment")) {
        return sentryUnavailable("binding-not-applicable");
      }
      const identity = request.reviewedIdentity;
      if (!validateSentryIdentity(identity)) return sentryUnavailable("invalid-reviewed-identity");
      if (typeof request.credential !== "string" || request.credential.length === 0) {
        return sentryUnavailable("credential-unavailable");
      }
      if ((request.limits?.maxPages ?? 3) < 3) return sentryUnavailable("provider-page-limit-exceeded");
      const options = {
        timeoutMs: Math.min(timeoutMs ?? 8_000, request.limits?.deadlineMs ?? Number.MAX_SAFE_INTEGER),
        maxResponseBytes: Math.min(maxResponseBytes ?? 1024 * 1024, request.limits?.maxResponseBytes ?? Number.MAX_SAFE_INTEGER),
        signal: request.signal,
      };

      const prefix = `/api/0/projects/${encodeURIComponent(identity.organizationSlug)}/${encodeURIComponent(identity.projectSlug)}`;
      const issueQuery = new URLSearchParams({
        environment: identity.environment,
        per_page: "100",
        query: "is:unresolved",
        statsPeriod: `${identity.lookbackHours}h`,
      });
      const releaseQuery = new URLSearchParams({
        environment: identity.environment,
        per_page: "2",
      });
      const [project, releases, issues] = await Promise.all([
        sentryJson(fetchImpl, `${prefix}/`, request.credential, options),
        sentryJson(fetchImpl, `${prefix}/releases/?${releaseQuery}`, request.credential, options),
        sentryJson(fetchImpl, `${prefix}/issues/?${issueQuery}`, request.credential, options),
      ]);
      const unavailable = [project, releases, issues].find((result) => !result.ok);
      if (unavailable) return sentryUnavailable(unavailable.reason);
      if (!projectMatches(project.value, identity) || !Array.isArray(releases.value) || !Array.isArray(issues.value)) {
        return sentryUnavailable("provider-identity-mismatch");
      }
      if (releases.value.length > 2 || issues.value.length > 100) {
        return sentryUnavailable("provider-observation-truncated");
      }

      const release = releases.value.find((candidate) => candidate?.version === identity.expectedRelease);
      const releaseObservedAt = sentryIsoDate(release?.dateReleased ?? release?.dateCreated);
      const issueDates = issues.value
        .map((issue) => sentryIsoDate(issue?.lastSeen))
        .filter(Boolean)
        .sort();
      const observedAt = [releaseObservedAt, issueDates.at(-1), now.toISOString()]
        .filter(Boolean)
        .sort()
        .at(-1);
      const evidenceUrl = safeSentryUrl(project.value?.organization?.links?.organizationUrl)
        ?? safeSentryUrl(project.value?.webUrl);
      const evidence = [];

      if (request.checks.includes("monitoring")) {
        const lastEvent = issueDates.at(-1) ?? "none observed in the bounded query";
        evidence.push({
          id: "sentry-project-monitoring",
          check: "monitoring",
          state: "verified",
          note: `Sentry project ${identity.organizationSlug}/${identity.projectSlug} bounded query returned ${issues.value.length} unresolved issue${issues.value.length === 1 ? "" : "s"} for ${identity.environment} in ${identity.lookbackHours}h; last issue event ${lastEvent}. No events is not proof of runtime health.`,
          ...(evidenceUrl ? { url: evidenceUrl } : {}),
        });
      }
      if (request.checks.includes("deployment")) {
        evidence.push({
          id: "sentry-release-deployment",
          check: "deployment",
          state: release ? "verified" : "unknown",
          note: release
            ? `Sentry observed reviewed release ${identity.expectedRelease} for ${identity.environment}; this matches release identity, not live runtime health.`
            : `Sentry did not return reviewed release ${identity.expectedRelease} in the bounded ${identity.environment} release query.`,
          ...(evidenceUrl ? { url: evidenceUrl } : {}),
        });
      }

      return {
        status: "success",
        observedIdentity: { ...identity },
        observedAt,
        evidence,
        ...(release ? { deployment: { identity: `sentry:${identity.organizationSlug}/${identity.projectSlug}@${identity.expectedRelease}` } } : {}),
      };
    },
  });
}

export const sentryMonitoringAdapter = createSentryMonitoringAdapter();

function projectMatches(project, identity) {
  if (!project || typeof project !== "object" || Array.isArray(project)) return false;
  const projectSlug = project.slug ?? project.id;
  const organizationSlug = project.organization?.slug;
  return projectSlug === identity.projectSlug && organizationSlug === identity.organizationSlug;
}
