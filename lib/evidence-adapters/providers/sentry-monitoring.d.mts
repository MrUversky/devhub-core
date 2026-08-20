import type { EvidenceAdapter, EvidenceAdapterObservation, EvidenceAdapterRequest } from "../../evidence-adapters.mjs";
import type { GitHubFetch } from "./github-deployment.mjs";

export type SentryMonitoringIdentity = {
  organizationSlug: string;
  projectSlug: string;
  environment: string;
  expectedRelease: string;
  lookbackHours: number;
};

export type SentryMonitoringAdapter = EvidenceAdapter & {
  collect(request: Readonly<EvidenceAdapterRequest>): Promise<EvidenceAdapterObservation>;
};

export const SENTRY_MONITORING_ADAPTER_ID: "sentry-project-monitoring-v1";
export function createSentryMonitoringAdapter(options?: {
  fetch?: GitHubFetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}): SentryMonitoringAdapter;
export const sentryMonitoringAdapter: SentryMonitoringAdapter;
