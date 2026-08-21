export const ONBOARD_PLAN_VERSION: 1;
export const ONBOARD_MAX_PLAN_BYTES: 1048576;

export class OnboardError extends Error { code: string; }

export type OnboardHostSuggestion = Readonly<{
  id: string;
  name: string;
  kind: "mac" | "linux" | "windows";
  location: "local";
  provenance: Readonly<{
    source: "non-secret-local-facts";
    os: NodeJS.Platform;
    hostnameAvailable: boolean;
  }>;
  ambiguous: boolean;
}>;

export type OnboardHealthCoverageClassification =
  | "direct-https-probe"
  | "reviewed-tailnet-publisher"
  | "provider-evidence-only"
  | "intentionally-not-checked"
  | "missing-health-contract";

export type OnboardHealthCoverage = Readonly<{
  version: 1;
  scope: "active-production-services";
  observation: "catalog-contracts-only";
  semantics: Readonly<{
    liveRequires: "fresh-source-probe";
    providerDeploymentIsRuntimeLive: false;
    publisherApplyRequiresExplicitApproval: true;
    centralVerificationSeparate: true;
  }>;
  counts: Readonly<Record<OnboardHealthCoverageClassification, number>>;
  services: readonly Readonly<{
    key: string;
    projectId: string;
    serviceId: string;
    lifecycle: "active" | "production";
    mode: "always-on" | "on-demand" | "managed" | "internal";
    hostId: string;
    hostKind: "mac" | "windows" | "linux" | "cloud";
    classification: OnboardHealthCoverageClassification;
    statusEvidence: "probe-contract" | "provider-deployment-only" | "reported-only" | "catalog-only";
    expectedAccess: "protected-or-success" | "success-or-not-observed";
    reason: string;
    nextAction: string;
  }>[];
  publisherHosts: readonly Readonly<{
    hostId: string;
    serviceKeys: readonly string[];
    preview: Readonly<{ command: "setup-host-monitoring"; apply: false }>;
    applyRequiresExplicitApproval: true;
    centralVerification: "required-after-device-local-publication";
  }>[];
}>;

export type OnboardPlan = Readonly<{
  planVersion: 1;
  command: "onboard";
  readOnly: true;
  persistent: false;
  status: "review-required" | "ready";
  planId: `sha256:${string}`;
  authority: Readonly<Record<string, unknown>>;
  provenance: Readonly<Record<string, unknown>>;
  sourceResults: readonly Readonly<Record<string, unknown>>[];
  healthCoverage: OnboardHealthCoverage;
  unresolvedQuestions: readonly Readonly<Record<string, unknown>>[];
  candidateDecisions: readonly Readonly<Record<string, unknown>>[];
  intendedWrites: readonly Readonly<Record<string, unknown>>[];
  application: Readonly<Record<string, unknown>>;
  verificationSteps: readonly Readonly<Record<string, unknown>>[];
  diff: Readonly<{ changed: false; state: "none"; reason: "preview-only" }>;
  safety: Readonly<Record<string, false>>;
}>;

export function suggestOnboardHostIdentity(input: {
  platform: NodeJS.Platform;
  hostname: string;
}): OnboardHostSuggestion;

export function classifyOnboardServiceCoverage(sourceCatalog: Readonly<Record<string, unknown>>): OnboardHealthCoverage;
export function createOnboardPlan(input: Readonly<Record<string, unknown>>): OnboardPlan;
export function calculateOnboardPlanId(plan: Readonly<Record<string, unknown>>): `sha256:${string}`;
export function validateOnboardPlanDocument(plan: Readonly<Record<string, unknown>>): OnboardPlan;
export function formatOnboardPlan(plan: OnboardPlan): string;
