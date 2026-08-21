import { createHash } from "node:crypto";

export const ONBOARD_PLAN_VERSION = 1;
export const ONBOARD_MAX_PLAN_BYTES = 1024 * 1024;

const stableIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const hostnamePattern = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const secretValuePattern = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bbearer(?:\s|[-_%])+[A-Za-z0-9._~+/-]{8,}|\b(?:github_pat_|gh[oprsu]_|sk-(?:proj-)?|xox[baprs]-|AKIA)[A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}|\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s/:@]+:[^\s/@]+@|\b(?:api[-_]?key|access[-_]?token|client[-_]?secret|password|passwd|secret|token)\s*[:=]\s*["']?(?!\$|\$\{|<|example\b|redacted\b)[A-Za-z0-9_./+=-]{8,})/i;
const genericHostnames = new Set(["localhost", "localhost.localdomain", "computer", "desktop", "host", "unknown"]);
const healthCoverageClassifications = Object.freeze([
  "direct-https-probe",
  "reviewed-tailnet-publisher",
  "provider-evidence-only",
  "intentionally-not-checked",
  "missing-health-contract",
]);

export class OnboardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OnboardError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new OnboardError(code, message);
}

function compareCodepoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort(compareCodepoints).map((key) => [key, canonical(value[key])]));
}

function digest(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(canonical(value))).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactFields(value, fields, label) {
  if (!plainObject(value)) fail("onboard-plan-invalid", `${label} must be an object`);
  const extra = Object.keys(value).filter((field) => !fields.has(field));
  if (extra.length) fail("onboard-plan-invalid", `${label} contains unsupported fields: ${extra.join(", ")}`);
}

function repositoryPath(value, label, { dot = false } = {}) {
  if (typeof value !== "string" || !value || value.length > 500 || value.includes("\\") || value.startsWith("/")) {
    fail("onboard-plan-invalid", `${label} must be a bounded repository-relative path`);
  }
  if (value === "." && dot) return value;
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part === ".git" || /[\0\r\n]/.test(part))) {
    fail("onboard-plan-invalid", `${label} must stay inside the catalog repository`);
  }
  return value;
}

function validateCatalogBinding(binding) {
  if (!plainObject(binding) || binding.version !== 1 || !new Set(["bound", "unbound"]).has(binding.state)) {
    fail("onboard-plan-invalid", "onboard plan catalog binding is invalid");
  }
  if (binding.state === "unbound") {
    exactFields(binding, new Set(["version", "state", "reason", "catalogState", "catalogFingerprint"]), "catalog binding");
    if (!new Set(["catalog-not-in-git-repository", "git-unavailable"]).has(binding.reason)
        || !new Set(["absent", "empty", "nonempty"]).has(binding.catalogState)
        || !/^sha256:[a-f0-9]{64}$/.test(binding.catalogFingerprint ?? "")) {
      fail("onboard-plan-invalid", "unbound catalog revision is invalid");
    }
    return;
  }
  exactFields(binding, new Set([
    "version", "state", "repositoryId", "baseRevision", "catalogPath", "catalogState",
    "catalogFingerprint", "generated", "connectionProfiles",
  ]), "catalog binding");
  if (!/^sha256:[a-f0-9]{64}$/.test(binding.repositoryId ?? "")
      || !/^[a-f0-9]{40,64}$/.test(binding.baseRevision ?? "")
      || !/^sha256:[a-f0-9]{64}$/.test(binding.catalogFingerprint ?? "")
      || !new Set(["absent", "empty", "nonempty"]).has(binding.catalogState)) {
    fail("onboard-plan-invalid", "bound catalog revision identifiers are invalid");
  }
  repositoryPath(binding.catalogPath, "catalog binding path", { dot: true });
  exactFields(binding.generated, new Set(["mode", "paths", "configuredDirectory"]), "generated binding");
  if (!Array.isArray(binding.generated.paths) || binding.generated.paths.length !== 2 || new Set(binding.generated.paths).size !== 2) {
    fail("onboard-plan-invalid", "generated binding must contain two unique output paths");
  }
  for (const [index, filename] of binding.generated.paths.entries()) repositoryPath(filename, `generated binding path ${index}`);
  if (binding.generated.mode === "ephemeral") {
    if (binding.generated.configuredDirectory !== null
        || JSON.stringify(binding.generated.paths) !== JSON.stringify(["app-catalog.json", "public-catalog.json"])) {
      fail("onboard-plan-invalid", "ephemeral generated binding is invalid");
    }
  } else if (binding.generated.mode === "repository") {
    const directory = binding.generated.configuredDirectory;
    const configuredDirectory = directory === null
      ? null
      : repositoryPath(directory, "configured generated directory", { dot: true });
    const prefix = configuredDirectory === "." ? "" : `${configuredDirectory}/`;
    const expected = directory === null
      ? ["app/generated/catalog.json", "public/catalog.json"]
      : [`${prefix}app-catalog.json`, `${prefix}public-catalog.json`];
    if (JSON.stringify(binding.generated.paths) !== JSON.stringify(expected)) fail("onboard-plan-invalid", "repository generated paths do not match their exact configuration");
  } else fail("onboard-plan-invalid", "generated binding mode is invalid");
  exactFields(binding.connectionProfiles, new Set(["mode", "path"]), "connection-profile binding");
  if (binding.connectionProfiles.mode === "none") {
    if (binding.connectionProfiles.path !== null) fail("onboard-plan-invalid", "unbound connection profile path must be null");
  } else if (binding.connectionProfiles.mode === "repository") {
    repositoryPath(binding.connectionProfiles.path, "connection profile path");
  } else fail("onboard-plan-invalid", "connection profile binding mode is invalid");
}

function platformKind(platform) {
  if (platform === "darwin") return "mac";
  if (platform === "linux") return "linux";
  if (platform === "win32") return "windows";
  fail("onboard-platform-unsupported", "onboard can suggest host identity only on macOS, Linux or Windows");
}

function safeHostname(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\.+$/, "");
  if (!normalized || normalized.length > 253 || !hostnamePattern.test(normalized) || secretValuePattern.test(normalized)) return null;
  return normalized;
}

function hostSlug(hostname) {
  const slug = hostname.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return stableIdPattern.test(slug) ? slug : "this-computer";
}

function isHttpsProbe(service) {
  if (service?.probe?.type !== "http" || typeof service.probe.url !== "string") return false;
  try {
    return new URL(service.probe.url).protocol === "https:";
  } catch {
    return false;
  }
}

function hasReviewedProviderEvidence(service, host) {
  if (service?.mode !== "managed" && host?.kind !== "cloud") return false;
  const deployment = service?.readiness?.deployment;
  const deploymentRecord = plainObject(deployment)
    && typeof deployment.provider === "string"
    && deployment.provider.length > 0
    && (typeof deployment.revision === "string" || typeof deployment.deployedAt === "string");
  const deploymentEvidence = (service?.readiness?.evidence ?? []).some((entry) =>
    entry?.check === "deployment" && new Set(["verified", "declared"]).has(entry.state));
  return deploymentRecord || deploymentEvidence;
}

function statusEvidenceFor(service, classification) {
  if (classification === "direct-https-probe" || classification === "reviewed-tailnet-publisher") return "probe-contract";
  if (classification === "provider-evidence-only") return "provider-deployment-only";
  return service.reported ? "reported-only" : "catalog-only";
}

function classifyHealthCoverageService(project, service, host) {
  let classification;
  let reason;
  let nextAction;
  if (service?.probe?.publish?.type === "tailscale-serve" && isHttpsProbe(service)) {
    classification = "reviewed-tailnet-publisher";
    reason = "reviewed-tailnet-publisher-configured";
    nextAction = "preview-host-monitoring-then-verify-centrally";
  } else if (isHttpsProbe(service)) {
    classification = "direct-https-probe";
    reason = "reviewed-direct-https-probe-configured";
    nextAction = "verify-central-probe-observation";
  } else if (service.mode === "on-demand" || service.mode === "internal") {
    classification = "intentionally-not-checked";
    reason = service.mode === "on-demand" ? "on-demand-service" : "internal-service-without-live-probe";
    nextAction = "preserve-honest-non-live-state";
  } else if (hasReviewedProviderEvidence(service, host)) {
    classification = "provider-evidence-only";
    reason = "reviewed-provider-deployment-evidence-is-not-runtime-health";
    nextAction = "add-minimal-runtime-health-contract-or-document-boundary";
  } else {
    classification = "missing-health-contract";
    reason = `${service.mode}-service-without-reviewed-live-probe`;
    nextAction = "add-minimal-runtime-health-contract-or-document-boundary";
  }
  const acceptedStatuses = service?.probe?.successStatuses ?? [];
  return {
    key: `${project.id}/${service.id}`,
    projectId: project.id,
    serviceId: service.id,
    lifecycle: project.lifecycle,
    mode: service.mode,
    hostId: service.host,
    hostKind: host.kind,
    classification,
    statusEvidence: statusEvidenceFor(service, classification),
    expectedAccess: acceptedStatuses.some((status) => status === 401 || status === 403) ? "protected-or-success" : "success-or-not-observed",
    reason,
    nextAction,
  };
}

export function classifyOnboardServiceCoverage(sourceCatalog) {
  if (!plainObject(sourceCatalog) || !Array.isArray(sourceCatalog.hosts) || !Array.isArray(sourceCatalog.projects)) {
    fail("onboard-catalog-result-invalid", "onboard health coverage requires one validated reviewed catalog");
  }
  const hosts = new Map(sourceCatalog.hosts.map((host) => [host.id, host]));
  const services = [];
  for (const entry of sourceCatalog.projects) {
    const project = entry?.manifest ?? entry;
    if (!plainObject(project) || !new Set(["active", "production"]).has(project.lifecycle)) continue;
    for (const service of project.services ?? []) {
      const host = hosts.get(service.host);
      if (!host) fail("onboard-catalog-result-invalid", `onboard health coverage cannot resolve host ${service.host}`);
      services.push(classifyHealthCoverageService(project, service, host));
    }
  }
  services.sort((left, right) => compareCodepoints(left.key, right.key));
  const counts = Object.fromEntries(healthCoverageClassifications.map((classification) => [
    classification,
    services.filter((service) => service.classification === classification).length,
  ]));
  const publisherHosts = [...new Set(services
    .filter((service) => service.classification === "reviewed-tailnet-publisher")
    .map((service) => service.hostId))]
    .sort(compareCodepoints)
    .map((hostId) => ({
      hostId,
      serviceKeys: services
        .filter((service) => service.classification === "reviewed-tailnet-publisher" && service.hostId === hostId)
        .map((service) => service.key),
      preview: { command: "setup-host-monitoring", apply: false },
      applyRequiresExplicitApproval: true,
      centralVerification: "required-after-device-local-publication",
    }));
  return deepFreeze({
    version: 1,
    scope: "active-production-services",
    observation: "catalog-contracts-only",
    semantics: {
      liveRequires: "fresh-source-probe",
      providerDeploymentIsRuntimeLive: false,
      publisherApplyRequiresExplicitApproval: true,
      centralVerificationSeparate: true,
    },
    counts,
    services,
    publisherHosts,
  });
}

export function suggestOnboardHostIdentity({ platform, hostname }) {
  const kind = platformKind(platform);
  const safe = safeHostname(hostname);
  const normalizedHostname = safe?.toLowerCase() ?? "unavailable";
  const id = `${hostSlug(safe ?? "this-computer")}-${digest(`${kind}\0${normalizedHostname}`).slice(0, 10)}`;
  return deepFreeze({
    id,
    name: safe ?? "This computer",
    kind,
    location: "local",
    provenance: {
      source: "non-secret-local-facts",
      os: platform,
      hostnameAvailable: safe !== null,
    },
    ambiguous: safe === null || genericHostnames.has(normalizedHostname),
  });
}

function questionProjection(group) {
  const choices = Array.isArray(group?.choices)
    ? group.choices.slice(0, 8).map((choice) => ({ id: choice.id, label: choice.label }))
    : [];
  return {
    id: group.id,
    source: group.provider,
    kind: group.type ?? group.state ?? "review",
    prompt: group.prompt,
    candidateCount: Array.isArray(group.candidateIds) ? group.candidateIds.length : 0,
    choices,
  };
}

function sourceProjection(setupReview) {
  const presentation = setupReview.review.presentation.sourcePreflight;
  const states = new Map();
  for (const source of presentation.ready) states.set(source.connectorId, { checked: source.checked, state: source.checkState });
  for (const source of presentation.taskOnly ?? []) states.set(source.connectorId, { checked: true, state: "checked-this-task" });
  for (const source of presentation.notChecked) states.set(source.connectorId, { checked: false, state: "not-checked" });
  for (const source of presentation.needsAttention) states.set(source.connectorId, { checked: false, state: source.state });
  return setupReview.preflight.selected.map((source) => ({
    id: source.connectorId,
    name: source.name,
    preflight: source.status,
    checked: states.get(source.connectorId)?.checked ?? false,
    result: states.get(source.connectorId)?.state ?? "not-checked",
  }));
}

function decisionForState(state) {
  if (state === "exact-match") return "preserve-existing";
  if (state === "possible-match") return "review-match";
  if (state === "new") return "review-new";
  if (state === "reviewed-external") return "preserve-external";
  if (state === "ignored") return "preserve-ignored";
  return "defer-unknown";
}

function candidateDecisionProjection(finding) {
  const proposal = finding.proposal ? {
    projectId: finding.proposal.manifest.id,
    contentSha256: `sha256:${digest(finding.proposal.yaml)}`,
  } : null;
  const reviewed = finding.reviewedDecision ? {
    artifactId: finding.reviewedDecision.artifactId,
    candidateId: finding.reviewedDecision.candidateId,
    reviewedAt: finding.reviewedDecision.reviewedAt,
    disposition: finding.reviewedDecision.disposition,
  } : null;
  return {
    id: finding.candidateId,
    kind: finding.identity.resourceType,
    source: finding.identity.provider,
    label: finding.label,
    state: finding.state,
    decision: proposal ? "create-overlay-project" : decisionForState(finding.state),
    reason: finding.reason,
    possibleTargets: (finding.possibleMatches ?? []).slice(0, 20).map((match) => ({
      projectId: match.projectId,
      serviceId: match.serviceId,
      signal: match.signal,
    })),
    evidence: {
      artifactId: reviewed?.artifactId ?? null,
      observedAt: finding.provenance.observedAt,
      validUntil: finding.provenance.validUntil,
      freshness: finding.provenance.freshness,
      uncertainty: finding.provenance.uncertainty,
    },
    reviewed,
    proposal,
  };
}

function assertBoundedPublicPlan(plan) {
  const serialized = JSON.stringify(plan);
  if (Buffer.byteLength(serialized) > ONBOARD_MAX_PLAN_BYTES) {
    fail("onboard-plan-too-large", `onboard plan exceeds ${ONBOARD_MAX_PLAN_BYTES} bytes`);
  }
  if (secretValuePattern.test(serialized)) fail("onboard-plan-unsafe", "onboard plan contains secret-shaped output");
}

export function createOnboardPlan(input) {
  const setupReview = input?.setupReview;
  if (!setupReview || setupReview.version !== 1 || setupReview.command !== "setup-run" || setupReview.readOnly !== true) {
    fail("onboard-setup-result-invalid", "onboard requires one validated read-only setup-run result");
  }
  if (!input.catalog || !new Set(["empty", "existing"]).has(input.catalog.mode)) {
    fail("onboard-catalog-result-invalid", "onboard requires an empty or existing reviewed catalog result");
  }
  const healthCoverage = classifyOnboardServiceCoverage(input.sourceCatalog);
  const rootIds = [...new Set(input.rootIds ?? [])].sort(compareCodepoints);
  if (rootIds.some((id) => !/^root-[a-f0-9]{16}$/.test(id))) fail("onboard-root-result-invalid", "onboard local root identities are invalid");
  const host = input.host;
  if (!host?.suggestion || !stableIdPattern.test(host.suggestion.id) || !new Set(["mac", "linux", "windows"]).has(host.suggestion.kind)) {
    fail("onboard-host-result-invalid", "onboard host suggestion is invalid");
  }

  const setupQuestions = setupReview.review.questionGroups.map(questionProjection);
  const hostQuestions = host.reviewRequired ? [{
    id: "onboard-host-identity",
    source: "this-computer",
    kind: "host-identity",
    prompt: "Confirm which reviewed host represents this computer before local discovery is used.",
    candidateCount: 1,
    choices: [
      { id: "use-suggestion", label: "Use the suggested identity" },
      { id: "choose-reviewed-host", label: "Choose a reviewed host" },
      { id: "defer-local-discovery", label: "Defer local discovery" },
    ],
  }] : [];
  const unresolvedQuestions = [...hostQuestions, ...setupQuestions];
  const discoveryDecisions = setupReview.review.findings.map(candidateDecisionProjection);
  const candidateDecisions = [{
    id: "host-identity",
    kind: "host-identity",
    source: host.selectedSource ?? "non-secret-local-facts",
    state: host.selectedId ? "selected" : "suggested",
    decision: host.selectedId ? "use-reviewed-identity" : host.reviewRequired ? "review-required" : "not-required",
    suggestedId: host.suggestion.id,
    selectedId: host.selectedId ?? null,
  }, ...discoveryDecisions];

  const reviewCandidateIds = discoveryDecisions
    .filter((decision) => new Set(["review-match", "review-new"]).has(decision.decision))
    .map((decision) => decision.id);
  const intendedWrites = [];
  if (input.catalog.mode === "empty") {
    intendedWrites.push({
      kind: "starter-catalog",
      status: "review-required",
      targets: ["catalog-hosts", "catalog-projects"],
      hostId: host.selectedId ?? host.suggestion.id,
    });
  }
  if (reviewCandidateIds.length) {
    intendedWrites.push({
      kind: "catalog-candidate-proposals",
      status: "candidate-review-required",
      candidateIds: reviewCandidateIds,
    });
  }
  if (intendedWrites.length) {
    intendedWrites.push({
      kind: "generated-catalog-refresh",
      status: "after-reviewed-catalog-change",
      targets: ["generated-app-catalog", "generated-public-catalog"],
    });
  }

  const primaryOperations = [];
  if (input.catalog.mode === "empty" && !host.reviewRequired) {
    primaryOperations.push({
      id: "starter-catalog",
      kind: "create-starter-catalog",
      host: structuredClone(input.catalog.starterHost),
    });
  }
  for (const finding of setupReview.review.findings) {
    if (!finding.proposal) continue;
    primaryOperations.push({
      id: finding.candidateId,
      kind: "create-overlay-project",
      candidateId: finding.candidateId,
      projectId: finding.proposal.manifest.id,
      yaml: finding.proposal.yaml,
      contentSha256: `sha256:${digest(finding.proposal.yaml)}`,
      evidence: {
        artifactId: finding.reviewedDecision?.artifactId ?? null,
        reviewedAt: finding.reviewedDecision?.reviewedAt ?? null,
        validUntil: finding.provenance.validUntil,
        freshness: finding.provenance.freshness,
      },
    });
  }
  const operations = [...primaryOperations];
  if (primaryOperations.length) {
    operations.push({
      id: "generated-catalog-refresh",
      kind: "refresh-generated-catalog",
      generated: structuredClone(input.catalog.binding?.generated ?? { mode: "ephemeral", paths: ["app-catalog.json", "public-catalog.json"], configuredDirectory: null }),
    });
  }
  const blockers = [];
  if (input.catalog.binding?.state !== "bound") blockers.push("catalog-git-binding-required");
  if (unresolvedQuestions.length) blockers.push("unresolved-review-questions");
  if (discoveryDecisions.some((decision) => new Set(["review-match", "review-new"]).has(decision.decision))) blockers.push("candidate-review-required");
  if (discoveryDecisions.some((decision) => decision.decision === "defer-unknown")) blockers.push("candidate-evidence-unknown");
  if (!setupReview.selectedOnly) blockers.push("selected-only-authority-unverified");
  if (input.validation.state !== "passed") blockers.push("catalog-validation-required");
  if (!primaryOperations.length) blockers.push("no-approved-catalog-writes");

  const planBody = {
    planVersion: ONBOARD_PLAN_VERSION,
    command: "onboard",
    readOnly: true,
    persistent: false,
    status: unresolvedQuestions.length || intendedWrites.length ? "review-required" : "ready",
    authority: {
      selectedOnly: setupReview.selectedOnly === true,
      sources: setupReview.preflight.selected.map((source) => source.connectorId),
      localRoots: { selectedOnly: true, count: rootIds.length, rootIds },
    },
    provenance: {
      workflowContractVersion: input.workflowContractVersion,
      runtimeVersion: input.runtimeVersion,
      catalog: {
        state: input.catalog.mode === "empty" ? "starter-preview" : "reviewed-existing",
        destinationState: input.catalog.destinationState,
        hosts: input.catalog.hostCount,
        projects: input.catalog.projectCount,
        binding: structuredClone(input.catalog.binding ?? {
          version: 1,
          state: "unbound",
          reason: "catalog-not-in-git-repository",
          catalogState: input.catalog.destinationState,
          catalogFingerprint: null,
        }),
      },
      hostSuggestion: host.suggestion,
      setupArtifactId: setupReview.review.artifactId,
      localDiscovery: input.localDiscovery ? {
        status: input.localDiscovery.status,
        freshness: input.localDiscovery.status === "complete" ? "current" : "unknown",
        reason: input.localDiscovery.reason,
      } : {
        status: "not-run",
        freshness: "not-observed",
        reason: input.localDiscoveryReason ?? (host.reviewRequired && rootIds.length ? "host-identity-review-required" : "no-local-roots-selected"),
      },
    },
    sourceResults: sourceProjection(setupReview),
    healthCoverage,
    unresolvedQuestions,
    candidateDecisions,
    intendedWrites,
    application: {
      version: 1,
      mode: "isolated-git-proposal",
      previewDefault: true,
      eligible: blockers.length === 0,
      blockers,
      operations,
    },
    verificationSteps: [
      {
        id: "catalog-source-validation",
        state: input.validation.state,
        scope: input.catalog.mode === "empty" ? "starter-catalog-contract" : "reviewed-source-catalog",
      },
      { id: "catalog-generated-check", state: "after-reviewed-apply", command: "validate-check" },
      { id: "onboard-replay", state: "expected-no-diff", expectation: "same-evidence-same-plan" },
    ],
    diff: { changed: false, state: "none", reason: "preview-only" },
    safety: {
      catalogWrites: false,
      profileWrites: false,
      providerMutations: false,
      repositoryWrites: false,
      generatedWrites: false,
      absolutePathsReturned: false,
      credentialValuesReturned: false,
    },
  };
  const plan = { ...planBody, planId: `sha256:${digest(planBody)}` };
  assertBoundedPublicPlan(plan);
  return deepFreeze(plan);
}

export function calculateOnboardPlanId(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) fail("onboard-plan-invalid", "onboard plan must be an object");
  const body = { ...plan };
  delete body.planId;
  return `sha256:${digest(body)}`;
}

export function validateOnboardPlanDocument(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("onboard-plan-invalid", "onboard plan must be an object");
  const plan = structuredClone(value);
  assertBoundedPublicPlan(plan);
  if (plan.planVersion !== ONBOARD_PLAN_VERSION || plan.command !== "onboard" || plan.readOnly !== true || plan.persistent !== false) {
    fail("onboard-plan-invalid", "onboard apply requires one version 1 read-only onboarding plan");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(plan.planId ?? "") || calculateOnboardPlanId(plan) !== plan.planId) {
    fail("onboard-plan-drift", "onboard plan ID does not match its exact contents");
  }
  const application = plan.application;
  if (!application || application.version !== 1 || application.mode !== "isolated-git-proposal" || application.previewDefault !== true
      || typeof application.eligible !== "boolean" || !Array.isArray(application.blockers) || !Array.isArray(application.operations)) {
    fail("onboard-plan-invalid", "onboard plan does not contain the isolated apply contract");
  }
  if (!Array.isArray(plan.intendedWrites) || !Array.isArray(plan.candidateDecisions) || !Array.isArray(plan.unresolvedQuestions)) {
    fail("onboard-plan-invalid", "onboard plan review and intended-write collections are invalid");
  }
  const healthCoverage = plan.healthCoverage;
  if (!plainObject(healthCoverage) || healthCoverage.version !== 1
      || healthCoverage.scope !== "active-production-services"
      || healthCoverage.observation !== "catalog-contracts-only"
      || !plainObject(healthCoverage.counts) || !Array.isArray(healthCoverage.services)
      || !Array.isArray(healthCoverage.publisherHosts)) {
    fail("onboard-plan-invalid", "onboard plan health coverage is invalid");
  }
  const serviceKeys = new Set();
  const actualCounts = Object.fromEntries(healthCoverageClassifications.map((classification) => [classification, 0]));
  for (const service of healthCoverage.services) {
    if (!plainObject(service) || !healthCoverageClassifications.includes(service.classification)
        || typeof service.key !== "string" || service.key !== `${service.projectId}/${service.serviceId}`
        || serviceKeys.has(service.key)) {
      fail("onboard-plan-invalid", "onboard plan health coverage services are invalid");
    }
    serviceKeys.add(service.key);
    actualCounts[service.classification] += 1;
  }
  if (JSON.stringify(canonical(healthCoverage.counts)) !== JSON.stringify(canonical(actualCounts))) {
    fail("onboard-plan-invalid", "onboard plan health coverage counts are invalid");
  }
  const publisherKeys = healthCoverage.services
    .filter((service) => service.classification === "reviewed-tailnet-publisher")
    .map((service) => service.key)
    .sort(compareCodepoints);
  const declaredPublisherKeys = healthCoverage.publisherHosts
    .flatMap((host) => Array.isArray(host?.serviceKeys) ? host.serviceKeys : [])
    .sort(compareCodepoints);
  if (JSON.stringify(publisherKeys) !== JSON.stringify(declaredPublisherKeys)
      || healthCoverage.semantics?.liveRequires !== "fresh-source-probe"
      || healthCoverage.semantics?.providerDeploymentIsRuntimeLive !== false
      || healthCoverage.semantics?.publisherApplyRequiresExplicitApproval !== true
      || healthCoverage.semantics?.centralVerificationSeparate !== true) {
    fail("onboard-plan-invalid", "onboard plan health coverage semantics are invalid");
  }
  const binding = plan.provenance?.catalog?.binding;
  validateCatalogBinding(binding);
  if (typeof plan.provenance?.runtimeVersion !== "string"
      || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(plan.provenance.runtimeVersion)) {
    fail("onboard-plan-invalid", "onboard plan runtime version is invalid");
  }
  const supportedBlockers = new Set([
    "catalog-git-binding-required", "unresolved-review-questions", "candidate-review-required",
    "candidate-evidence-unknown", "selected-only-authority-unverified", "catalog-validation-required",
    "no-approved-catalog-writes",
  ]);
  if (new Set(application.blockers).size !== application.blockers.length
      || application.blockers.some((blocker) => typeof blocker !== "string" || !supportedBlockers.has(blocker))) {
    fail("onboard-plan-invalid", "onboard plan apply blockers are invalid");
  }
  const operationIds = new Set();
  const operationCandidates = new Set();
  let primaryCount = 0;
  let refreshCount = 0;
  for (const operation of application.operations) {
    if (!operation || typeof operation !== "object" || typeof operation.id !== "string" || operationIds.has(operation.id)) {
      fail("onboard-plan-invalid", "onboard plan operations must have unique IDs");
    }
    operationIds.add(operation.id);
    if (operation.kind === "create-starter-catalog") {
      exactFields(operation, new Set(["id", "kind", "host"]), `operation ${operation.id}`);
      primaryCount += 1;
      if (operation.id !== "starter-catalog" || !operation.host || operation.host.id !== plan.intendedWrites.find((write) => write.kind === "starter-catalog")?.hostId) {
        fail("onboard-plan-invalid", "starter catalog operation is not bound to the reviewed intended write");
      }
    } else if (operation.kind === "create-overlay-project") {
      exactFields(operation, new Set(["id", "kind", "candidateId", "projectId", "yaml", "contentSha256", "evidence"]), `operation ${operation.id}`);
      exactFields(operation.evidence, new Set(["artifactId", "reviewedAt", "validUntil", "freshness"]), `operation ${operation.id} evidence`);
      primaryCount += 1;
      const candidate = plan.candidateDecisions.find((decision) => decision.id === operation.candidateId);
      if (operationCandidates.has(operation.candidateId)) fail("onboard-plan-invalid", `candidate ${operation.candidateId} has duplicate operations`);
      operationCandidates.add(operation.candidateId);
      if (operation.id !== operation.candidateId || !/^candidate-[a-f0-9]{20}$/.test(operation.candidateId ?? "")
          || !stableIdPattern.test(operation.projectId ?? "") || typeof operation.yaml !== "string"
          || !candidate || candidate.decision !== "create-overlay-project" || candidate.proposal?.projectId !== operation.projectId
          || candidate.proposal?.contentSha256 !== operation.contentSha256 || `sha256:${digest(operation.yaml ?? "")}` !== operation.contentSha256
          || candidate.reviewed?.disposition !== "new" || operation.evidence?.artifactId !== candidate.reviewed.artifactId
          || operation.evidence?.artifactId !== plan.provenance.setupArtifactId
          || operation.evidence?.reviewedAt !== candidate.reviewed.reviewedAt
          || operation.evidence?.validUntil !== candidate.evidence?.validUntil
          || operation.evidence?.freshness !== candidate.evidence?.freshness
          || operation.evidence?.freshness !== "fresh"
          || !Number.isFinite(Date.parse(operation.evidence.reviewedAt))
          || !Number.isFinite(Date.parse(operation.evidence.validUntil))) {
        fail("onboard-plan-invalid", `overlay operation ${operation.id} is not bound to its reviewed candidate decision`);
      }
    } else if (operation.kind === "refresh-generated-catalog") {
      exactFields(operation, new Set(["id", "kind", "generated"]), `operation ${operation.id}`);
      refreshCount += 1;
      if (operation.id !== "generated-catalog-refresh" || JSON.stringify(canonical(operation.generated)) !== JSON.stringify(canonical(binding.generated))) {
        fail("onboard-plan-invalid", "generated refresh operation is not bound to the exact catalog repository outputs");
      }
    } else fail("onboard-plan-invalid", `unsupported onboard operation ${operation.kind}`);
  }
  if ((primaryCount > 0 && refreshCount !== 1) || (primaryCount === 0 && refreshCount !== 0) || refreshCount > 1) {
    fail("onboard-plan-invalid", "onboard plan generated refresh does not match its catalog writes");
  }
  const proposalCandidates = plan.candidateDecisions.filter((decision) => decision.decision === "create-overlay-project").map((decision) => decision.id).sort();
  if (JSON.stringify([...operationCandidates].sort()) !== JSON.stringify(proposalCandidates)) {
    fail("onboard-plan-invalid", "reviewed candidate proposals do not match the exact overlay operations");
  }
  const expectedBlockers = [];
  if (binding.state !== "bound") expectedBlockers.push("catalog-git-binding-required");
  if (plan.unresolvedQuestions.length) expectedBlockers.push("unresolved-review-questions");
  if (plan.candidateDecisions.some((decision) => new Set(["review-match", "review-new"]).has(decision.decision))) expectedBlockers.push("candidate-review-required");
  if (plan.candidateDecisions.some((decision) => decision.decision === "defer-unknown")) expectedBlockers.push("candidate-evidence-unknown");
  if (plan.authority?.selectedOnly !== true) expectedBlockers.push("selected-only-authority-unverified");
  if (plan.verificationSteps?.find((step) => step.id === "catalog-source-validation")?.state !== "passed") expectedBlockers.push("catalog-validation-required");
  if (primaryCount === 0) expectedBlockers.push("no-approved-catalog-writes");
  if (JSON.stringify(application.blockers) !== JSON.stringify(expectedBlockers)
      || application.eligible !== (expectedBlockers.length === 0)
      || (application.eligible && (binding.state !== "bound" || primaryCount === 0))) {
    fail("onboard-plan-invalid", "onboard plan apply eligibility is inconsistent");
  }
  return deepFreeze(plan);
}

export function formatOnboardPlan(plan) {
  const catalog = plan.provenance.catalog.state === "starter-preview"
    ? "new starter catalog"
    : `${plan.provenance.catalog.projects} reviewed projects on ${plan.provenance.catalog.hosts} hosts`;
  const sourceLines = plan.sourceResults.map((source) => `- ${source.name}: ${source.checked ? source.result : source.preflight}`);
  const host = plan.provenance.hostSuggestion;
  const local = plan.authority.localRoots.count
    ? `${plan.authority.localRoots.count} explicit local ${plan.authority.localRoots.count === 1 ? "root" : "roots"}; ${plan.provenance.localDiscovery.status}`
    : "no local roots selected";
  const coverage = plan.healthCoverage.counts;
  return [
    `DevHub onboard preview ${plan.planId.slice(0, 19)}`,
    `Catalog: ${catalog}.`,
    `Host suggestion: ${host.name} · ${host.kind} · ${host.id}.`,
    `Local discovery: ${local}.`,
    `Health contracts (not live observations): ${coverage["direct-https-probe"]} direct HTTPS; ${coverage["reviewed-tailnet-publisher"]} reviewed tailnet publisher; ${coverage["provider-evidence-only"]} provider-only; ${coverage["intentionally-not-checked"]} intentionally not checked; ${coverage["missing-health-contract"]} missing.`,
    ...(plan.healthCoverage.publisherHosts.length ? ["Publisher setup is preview-only through setup-host-monitoring; apply needs separate approval and central verification."] : []),
    "Selected source results:",
    ...sourceLines,
    `Review: ${plan.unresolvedQuestions.length} unresolved ${plan.unresolvedQuestions.length === 1 ? "question" : "questions"}; ${plan.candidateDecisions.length} candidate ${plan.candidateDecisions.length === 1 ? "decision" : "decisions"}.`,
    `Intended writes after review: ${plan.intendedWrites.length}. Current diff: none.`,
    `Isolated apply: ${plan.application.eligible ? "ready for an exact preview" : `blocked (${plan.application.blockers.join(", ")})`}.`,
    "No files, profiles, providers, generated data or repositories were changed.",
  ].join("\n");
}
