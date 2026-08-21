import {
  evaluateReadiness,
  PROFILE_EXPECTATIONS,
  resolveServiceReadinessContext,
} from "../lib/readiness.mjs";
import { validateEvidenceAdapterResult } from "../lib/evidence-adapters.mjs";
import {
  STEWARDSHIP_ROLES,
  resolveAccessFacts,
  resolveCredentialInventory,
  resolveServiceStewardshipContext,
} from "../lib/stewardship.mjs";

const STATE_ORDER = Object.freeze({ drift: 0, missing: 1, stale: 2, unknown: 3 });
const SEVERITY_ORDER = Object.freeze({ high: 0, medium: 1, low: 2 });

const NEXT_ACTIONS = Object.freeze({
  monitoring: "Register a reviewed health probe or fresh monitoring evidence.",
  alerting: "Register evidence that alerts reach a named operator, or explicitly document why alerting is not applicable.",
  backup: "Document the backup boundary and register fresh evidence for the current data-bearing service.",
  restore: "Run an isolated restore exercise and register its reviewed evidence and freshness window.",
  rollback: "Document and verify a reversible rollback path for the deployed service.",
  "security-review": "Perform a scoped security review and register its evidence without copying findings or secrets into DevHub.",
  privacy: "Review the service data boundary and register privacy evidence or an explicit not-applicable rationale.",
  ownership: "Name the operator and record reviewed ownership evidence for the service and its critical accounts.",
  cost: "Record who owns the bill and where the current cost evidence can be reviewed.",
  deployment: "Register evidence for the deployed revision and deployment procedure.",
  "readiness-profile": "Choose the smallest fitting App Passport profile and add only evidence that can be reviewed.",
  "recovery-guidance": "Add a reviewed logs or recovery entry point, then verify rollback or restore where applicable.",
  "provider-evidence": "Refresh this exact reviewed evidence binding; do not enumerate the provider account.",
  "deployment-identity": "Open an owner review of the observed deployment identity before changing its binding or catalog record.",
  "deployment-url": "Open an owner review of the observed service URL before changing the catalog.",
  "deployment-host": "Open an owner review of the observed host before changing the catalog.",
  "recurring-cost": "Open an owner review of the linked recurring-cost evidence before changing provider state.",
  "stewardship-accountableOwner": "Review who is accountable for this service and register a dated person or team assignment.",
  "stewardship-operator": "Review who operates this service and register a dated person or team assignment.",
  "stewardship-billingOwner": "Review who owns the bill; provider access and billing access remain separate facts.",
  "stewardship-credentialOwner": "Review who owns credential rotation without copying the credential value into DevHub.",
  "stewardship-single-owner": "Add a reviewed second person or team boundary for an important operational role; do not change provider access automatically.",
  "access-freshness": "Refresh this exact access fact with its owner; do not infer access from another account or role.",
  "credential-owner": "Review who currently owns this credential lifecycle without copying the credential value into DevHub.",
  "credential-payer": "Review who pays for this credential's provider usage and record the steward reference.",
  "credential-orphan": "Review whether this external credential reference still has a consumer and document its retained or retired state before any provider action.",
  "credential-rotation": "Verify or rotate the credential in its external secret store, then refresh only its non-secret metadata.",
});

function asDate(now) {
  const value = now instanceof Date ? new Date(now) : new Date(now ?? Date.now());
  if (!Number.isFinite(value.getTime())) throw new TypeError("Portfolio review needs a valid now value.");
  return value;
}

function serviceIdentity(project, service) {
  return { project: project.id, service: service?.id ?? null };
}

function finding(project, service, {
  check,
  state,
  evidence = null,
  reason,
  severity,
  uncertainty = null,
  recommendedNextAction = NEXT_ACTIONS[check],
}) {
  return {
    ...serviceIdentity(project, service),
    check,
    state,
    evidence,
    reason,
    uncertainty,
    recommendedNextAction,
    severity,
  };
}

function severityFor(profile, check, state) {
  const dataLossOrExposure = ["backup", "restore", "security-review", "privacy"].includes(check);
  if (["customer-facing", "sensitive"].includes(profile) && dataLossOrExposure && ["missing", "stale"].includes(state)) {
    return "high";
  }
  if (["monitoring", "alerting", "rollback", "ownership", "deployment"].includes(check)) return "medium";
  if (profile === "sensitive" && dataLossOrExposure) return "medium";
  return "low";
}

function reasonFor(check, state, evidence) {
  if (!evidence) return `The selected operating profile expects ${check} evidence, but none is registered.`;
  if (state === "stale") return `${check} evidence expired at ${evidence.validUntil}; it is retained as context but is no longer current.`;
  if (state === "missing") return `${check} is explicitly recorded as missing: ${evidence.note}`;
  if (evidence.state === "declared") return `${check} is declared but not independently verified: ${evidence.note}`;
  return `${check} is explicitly recorded as unknown: ${evidence.note}`;
}

function profileFindings(project, service, context, assessment) {
  const effectiveProfile = context.fields.profile.value;
  const effectiveOwner = context.fields.owner.value;
  if (!effectiveProfile) {
    const severity = service.mode === "always-on" || service.mode === "managed" ? "medium" : "low";
    const findings = [
      finding(project, service, {
        check: "readiness-profile",
        state: "unknown",
        reason: "No App Passport operating profile is registered, so expected readiness evidence cannot be evaluated.",
        severity,
      }),
    ];
    if (!effectiveOwner && !assessment.checks.some((item) => item.check === "ownership")) {
      findings.push(finding(project, service, {
        check: "ownership",
        state: "unknown",
        reason: "No project or service owner context and no ownership evidence are registered for this service.",
        severity,
      }));
    }
    return findings;
  }

  return assessment.checks.flatMap((item) => {
    const { check, evidence: evidenceItem, state: effective, expected } = item;
    if (!["declared", "missing", "stale", "unknown"].includes(effective)) return [];
    if (!expected && !["missing", "stale", "unknown"].includes(effective)) return [];
    const state = effective === "declared" ? "unknown" : effective;
    const reason = check === "ownership" && !evidenceItem && effectiveOwner
      ? `Owner context is ${context.fields.owner.provenance === "project" ? "inherited from the project" : "registered on the service"}, but no service-specific ownership evidence is registered.`
      : reasonFor(check, state, evidenceItem);
    return [finding(project, service, {
      check,
      state,
      evidence: evidenceItem,
      reason,
      severity: severityFor(effectiveProfile, check, state),
    })];
  });
}

function operationalFindings(project, service, existingFindings, assessment) {
  const findings = [];
  const existingByCheck = new Map(existingFindings.map((item) => [item.check, item]));
  const currentMonitoring = assessment.checks.some((item) => item.check === "monitoring" && item.state === "verified");

  if (service.mode === "always-on" && !service.probe && !currentMonitoring) {
    const existing = existingByCheck.get("monitoring");
    const monitoringFinding = finding(project, service, {
      check: "monitoring",
      state: existing?.state ?? "unknown",
      evidence: existing?.evidence ?? null,
      reason: "Always-on service has neither a reviewed health probe nor current verified monitoring evidence.",
      severity: "medium",
    });
    if (existing) Object.assign(existing, monitoringFinding);
    else findings.push(monitoringFinding);
  }

  const hasLogsEntryPoint = Boolean(service.commands?.logs || service.links?.some((link) => link.type === "logs"));
  const hasRecoveryCommand = Boolean(service.commands?.restart || service.commands?.start);
  const hasRecoveryEvidence = assessment.checks.some((item) => ["restore", "rollback"].includes(item.check)
    && ["verified", "declared"].includes(item.state));
  if (!hasLogsEntryPoint && !hasRecoveryCommand && !hasRecoveryEvidence) {
    findings.push(finding(project, service, {
      check: "recovery-guidance",
      state: "unknown",
      reason: "No reviewed logs entry point, recovery command, rollback evidence or restore evidence is registered.",
      severity: service.mode === "always-on" || service.mode === "managed" ? "medium" : "low",
    }));
  }

  return findings;
}

const STEWARDSHIP_ROLE_LABELS = Object.freeze({
  accountableOwner: "accountable owner",
  operator: "operator",
  billingOwner: "billing owner",
  credentialOwner: "credential owner",
});

function stewardshipEnabled(project, service) {
  return Boolean(
    project.stewards?.length
    || project.stewardshipDefaults
    || project.credentials?.length
    || service.stewardship,
  );
}

function stewardshipEvidence(role) {
  return role.steward ? {
    type: "reviewed-stewardship",
    stewardId: role.steward.id,
    name: role.steward.name,
    kind: role.steward.kind,
    source: role.steward.source,
    observedAt: role.steward.observedAt ?? null,
    validUntil: role.steward.validUntil ?? null,
    provenance: role.provenance,
  } : null;
}

function credentialEvidence(credential) {
  return {
    type: "credential-metadata",
    credentialId: credential.id,
    provider: credential.provider,
    purpose: credential.purpose,
    secretRef: { kind: credential.secretRef.kind, configured: true },
    consumers: credential.consumers,
    source: credential.source,
    lastVerifiedAt: credential.lastVerifiedAt ?? null,
    rotationDueAt: credential.rotationDueAt ?? null,
    ownerState: credential.ownerState ?? null,
    payerState: credential.payerState ?? null,
    verificationState: credential.verificationState ?? null,
  };
}

function credentialLifecycleFindings(project, service, credentials) {
  const findings = [];
  for (const credential of credentials) {
    if (credential.ownerState !== "reviewed") {
      findings.push(finding(project, service, {
        check: "credential-owner",
        state: credential.ownerState === "stale" ? "stale" : "unknown",
        evidence: credentialEvidence(credential),
        reason: credential.ownerState === "stale"
          ? `Credential reference ${credential.id} points to an owner assignment that expired at ${credential.ownerSteward.validUntil}.`
          : `Credential reference ${credential.id} has no current reviewed owner assignment.`,
        uncertainty: "The historical owner label is context, not proof of current provider access or responsibility.",
        severity: "medium",
      }));
    }
    if (credential.payerState !== "reviewed") {
      findings.push(finding(project, service, {
        check: "credential-payer",
        state: credential.payerState === "stale" ? "stale" : "unknown",
        evidence: credentialEvidence(credential),
        reason: credential.payerState === "stale"
          ? `Credential reference ${credential.id} points to a payer assignment that expired at ${credential.payerSteward.validUntil}.`
          : `Credential reference ${credential.id} has no current reviewed payer.`,
        uncertainty: "Credential ownership, provider access and responsibility for the bill are separate facts.",
        severity: "low",
      }));
    }
    if (credential.verificationState === "rotation-due") {
      findings.push(finding(project, service, {
        check: "credential-rotation",
        state: "stale",
        evidence: credentialEvidence(credential),
        reason: `Credential reference ${credential.id} reached its reviewed rotation due date at ${credential.rotationDueAt}.`,
        uncertainty: "DevHub does not know the secret value or whether the provider has already rotated it.",
        severity: "medium",
      }));
    }
  }
  return findings;
}

function stewardshipFindings(project, service, now) {
  if (!stewardshipEnabled(project, service)) return [];
  const context = resolveServiceStewardshipContext(project, service, { now });
  const findings = [];

  for (const roleName of STEWARDSHIP_ROLES) {
    const role = context.roles[roleName];
    if (role.state === "reviewed") continue;
    findings.push(finding(project, service, {
      check: `stewardship-${roleName}`,
      state: role.state === "stale" ? "stale" : "unknown",
      evidence: stewardshipEvidence(role),
      reason: role.state === "stale"
        ? `The reviewed ${STEWARDSHIP_ROLE_LABELS[roleName]} assignment expired at ${role.steward.validUntil}; it remains context, not current evidence.`
        : `No reviewed ${STEWARDSHIP_ROLE_LABELS[roleName]} is assigned to this service.`,
      severity: ["accountableOwner", "operator"].includes(roleName) ? "medium" : "low",
    }));
  }

  if (context.summary.singlePersonRisk) {
    const reviewedRoles = Object.fromEntries(STEWARDSHIP_ROLES.flatMap((roleName) => {
      const role = context.roles[roleName];
      return role.state === "reviewed" ? [[roleName, stewardshipEvidence(role)]] : [];
    }));
    findings.push(finding(project, service, {
      check: "stewardship-single-owner",
      state: "unknown",
      evidence: { type: "reviewed-stewardship-concentration", roles: reviewedRoles },
      reason: "Multiple important roles resolve to one reviewed person and no reviewed team assignment provides a shared operating boundary.",
      uncertainty: "This is a continuity question, not proof that the current owner is inappropriate or lacks provider access.",
      severity: service.mode === "always-on" || service.mode === "managed" ? "medium" : "low",
    }));
  }

  findings.push(...credentialLifecycleFindings(project, service, context.credentials));
  return findings;
}

function accessFreshnessFindings(project, now) {
  return resolveAccessFacts(project, { now }).flatMap((fact) => fact.freshnessState !== "stale" ? [] : [finding(project, null, {
    check: "access-freshness",
    state: "stale",
    evidence: {
      type: "reviewed-access",
      accessId: fact.id,
      kind: fact.kind,
      subject: fact.subject,
      recordedAccess: fact.recordedAccess,
      effectiveAccess: fact.access,
      source: fact.source,
      observedAt: fact.observedAt ?? null,
      validUntil: fact.validUntil ?? null,
      freshnessState: fact.freshnessState,
    },
    reason: `The reviewed ${fact.kind} access fact for ${fact.subject} expired at ${fact.validUntil}; effective access is unknown.`,
    uncertainty: "Expired access evidence neither proves access remains nor proves it was revoked.",
    severity: "low",
  })]);
}

function orphanedCredentialFindings(project, now) {
  return resolveCredentialInventory(project, { now }).flatMap((credential) => credential.consumers.length ? [] : [
    finding(project, null, {
      check: "credential-orphan",
      state: "unknown",
      evidence: credentialEvidence(credential),
      reason: `Credential reference ${credential.id} has no reviewed service consumers.`,
      uncertainty: "No registered consumer does not prove the provider credential is unused; review is required before any external action.",
      severity: "low",
    }),
    ...credentialLifecycleFindings(project, null, [credential]),
  ]);
}

function normalizedUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

function reviewedServiceUrls(service) {
  return new Set([
    service.endpoint?.canonical,
    service.endpoint?.fallback,
    service.url,
    ...(service.links ?? []).filter((link) => link.type === "primary").map((link) => link.url),
  ].map(normalizedUrl).filter(Boolean));
}

function evidenceTimestamp(value) {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? timestamp : null;
}

function evidenceIsCurrent(item, now) {
  const validUntil = evidenceTimestamp(item.validUntil);
  return validUntil === null || validUntil >= now.getTime();
}

function reviewedResolution(service, check, observation, now) {
  const observedAt = evidenceTimestamp(observation.observedAt ?? observation.freshness?.observedAt);
  return (service.readiness?.evidence ?? []).find((item) => {
    if (item.check !== check || !evidenceIsCurrent(item, now)) return false;
    if (item.state === "not-applicable") return item.note.trim().length > 0;
    if (item.state !== "verified") return false;
    const reviewedAt = evidenceTimestamp(item.observedAt);
    return observedAt !== null && reviewedAt !== null && reviewedAt >= observedAt;
  }) ?? null;
}

function providerEvidenceItem(observation, check) {
  return [...(observation.evidence ?? [])]
    .filter((item) => item.check === check)
    .sort((left, right) => (evidenceTimestamp(right.observedAt) ?? Number.NEGATIVE_INFINITY)
      - (evidenceTimestamp(left.observedAt) ?? Number.NEGATIVE_INFINITY)
      || left.id.localeCompare(right.id))[0] ?? null;
}

function providerEvidenceRef(observation, { check = "deployment", observed = null, url = null } = {}) {
  const item = providerEvidenceItem(observation, check);
  return {
    type: "normalized-provider-observation",
    adapter: observation.identity.adapterId,
    provider: observation.identity.provider,
    reviewedIdentity: observation.identity.reviewedIdentity,
    evidenceId: item?.id ?? null,
    check,
    state: item?.state ?? (observation.execution.state === "succeeded" ? "verified" : "unknown"),
    freshness: observation.freshness.state,
    observedAt: item?.observedAt ?? observation.freshness.observedAt,
    validUntil: item?.validUntil ?? observation.freshness.validUntil,
    url: url ?? item?.url ?? null,
    observed,
  };
}

function observationIdentity(observation) {
  const { projectId, serviceId, adapterId, provider, reviewedIdentity } = observation.identity;
  return `${projectId}\u0000${serviceId}\u0000${adapterId}\u0000${provider}\u0000${stableJson(reviewedIdentity)}`;
}

function observationOrder(left, right) {
  const identityOrder = observationIdentity(left).localeCompare(observationIdentity(right));
  if (identityOrder !== 0) return identityOrder;
  const evaluatedOrder = (evidenceTimestamp(left.freshness.evaluatedAt) ?? Number.NEGATIVE_INFINITY)
    - (evidenceTimestamp(right.freshness.evaluatedAt) ?? Number.NEGATIVE_INFINITY);
  if (evaluatedOrder !== 0) return evaluatedOrder;
  const timeOrder = (evidenceTimestamp(left.freshness.observedAt) ?? Number.NEGATIVE_INFINITY)
    - (evidenceTimestamp(right.freshness.observedAt) ?? Number.NEGATIVE_INFINITY);
  if (timeOrder !== 0) return timeOrder;
  return stableJson(left).localeCompare(stableJson(right));
}

function newestProviderObservations(observations) {
  const selected = new Map();
  for (const observation of [...observations].sort(observationOrder)) {
    selected.set(observationIdentity(observation), observation);
  }
  return [...selected.values()].sort(observationOrder);
}

function providerFinding(project, service, observation, details) {
  return finding(project, service, {
    severity: "medium",
    uncertainty: "This is a normalized read-only observation. Confirm ownership and intent before changing catalog or provider state.",
    ...details,
  });
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function reviewedDeploymentIdentity(observation) {
  const reviewed = observation.identity.reviewedIdentity;
  if (!reviewed || typeof reviewed !== "object" || Array.isArray(reviewed)) return null;
  for (const key of ["deploymentIdentity", "resourceId"]) {
    const value = reviewed[key];
    if (typeof value === "string" || typeof value === "number") return String(value);
  }
  return null;
}

function reviewedComparableValue(observation, field) {
  const reviewed = observation.identity.reviewedIdentity;
  if (!reviewed || typeof reviewed !== "object" || Array.isArray(reviewed)) return null;
  const value = reviewed[field];
  return typeof value === "string" && value.trim() ? value : null;
}

function providerDriftFindings(project, service, observation, now, effectiveProfile) {
  const findings = [];
  const deploymentResolution = reviewedResolution(service, "deployment", observation, now);
  const deployment = observation.deployment ?? {};
  const reviewedIdentity = reviewedDeploymentIdentity(observation);
  const reviewedServiceUrl = normalizedUrl(reviewedComparableValue(observation, "serviceUrl"));
  const reviewedCatalogHost = reviewedComparableValue(observation, "catalogHost");
  const freshnessState = observation.freshness.state;

  if (observation.execution.state !== "succeeded" || freshnessState !== "fresh") {
    const state = freshnessState === "stale" ? "stale" : "unknown";
    findings.push(providerFinding(project, service, observation, {
      check: "provider-evidence",
      state,
      evidence: providerEvidenceRef(observation),
      reason: `The exact ${observation.identity.provider}/${observation.identity.adapterId} binding is ${state}: ${observation.execution.reason}.`,
      severity: "low",
    }));
  }

  if (observation.execution.state === "succeeded" && freshnessState === "fresh"
      && !deploymentResolution && reviewedIdentity && deployment.identity && deployment.identity !== reviewedIdentity) {
    findings.push(providerFinding(project, service, observation, {
      check: "deployment-identity",
      state: "drift",
      evidence: providerEvidenceRef(observation, {
        observed: { expected: reviewedIdentity, actual: deployment.identity },
      }),
      reason: `Observed deployment identity ${deployment.identity} differs from reviewed identity ${reviewedIdentity}.`,
    }));
  }

  const observedUrl = normalizedUrl(deployment.url);
  const reviewedUrls = reviewedServiceUrls(service);
  if (reviewedServiceUrl) reviewedUrls.add(reviewedServiceUrl);
  if (observation.execution.state === "succeeded" && freshnessState === "fresh"
      && !deploymentResolution && reviewedServiceUrl && observedUrl && !reviewedUrls.has(observedUrl)) {
    findings.push(providerFinding(project, service, observation, {
      check: "deployment-url",
      state: "drift",
      evidence: providerEvidenceRef(observation, {
        observed: { expected: [...reviewedUrls].sort(), actual: deployment.url },
        url: deployment.url,
      }),
      reason: `Observed deployment URL ${deployment.url} is not one of the service URLs reviewed in the catalog.`,
    }));
  }

  if (observation.execution.state === "succeeded" && freshnessState === "fresh"
      && !deploymentResolution && reviewedCatalogHost && deployment.host && deployment.host !== service.host) {
    findings.push(providerFinding(project, service, observation, {
      check: "deployment-host",
      state: "drift",
      evidence: providerEvidenceRef(observation, {
        observed: { expected: service.host, actual: deployment.host },
      }),
      reason: `Observed deployment host ${deployment.host} differs from reviewed catalog host ${service.host}.`,
    }));
  }

  for (const check of ["backup", "restore"]) {
    const item = providerEvidenceItem(observation, check);
    const validUntil = evidenceTimestamp(item?.validUntil);
    if (!item || validUntil === null || validUntil >= now.getTime()) continue;
    if (reviewedResolution(service, check, { observedAt: item.observedAt }, now)) continue;
    findings.push(providerFinding(project, service, observation, {
      check,
      state: "stale",
      evidence: providerEvidenceRef(observation, { check }),
      reason: `Normalized ${check} evidence expired at ${item.validUntil}; the provider observation does not establish current recoverability.`,
      severity: ["customer-facing", "sensitive"].includes(effectiveProfile) ? "high" : "medium",
    }));
  }

  if (observation.execution.state === "succeeded" && freshnessState === "fresh"
      && ["paused", "discovery"].includes(project.lifecycle) && observation.recurringCost?.state === "present"
      && !reviewedResolution(service, "cost", { observedAt: observation.recurringCost.observedAt }, now)) {
    findings.push(providerFinding(project, service, observation, {
      check: "recurring-cost",
      state: "drift",
      evidence: providerEvidenceRef(observation, {
        check: "cost",
        observed: { projectLifecycle: project.lifecycle, recurringCost: "present" },
        url: observation.recurringCost.url,
      }),
      reason: `The project is ${project.lifecycle}, while the exact reviewed resource reports a recurring cost.`,
      uncertainty: "A recurring cost does not prove the resource is unused or the charge is wrong; owner review is required.",
    }));
  }

  return findings;
}

function compareFindings(left, right) {
  return SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]
    || left.project.localeCompare(right.project)
    || (left.service ?? "").localeCompare(right.service ?? "")
    || left.check.localeCompare(right.check)
    || STATE_ORDER[left.state] - STATE_ORDER[right.state];
}

export function reviewPortfolio(sourceCatalog, { now, providerEvidence = [] } = {}) {
  const reviewedAt = asDate(now);
  const normalizedProviderEvidence = providerEvidence.map(validateEvidenceAdapterResult);
  const findings = [];
  let serviceCount = 0;

  for (const { manifest: project } of sourceCatalog.projects) {
    for (const service of project.services ?? []) {
      serviceCount += 1;
      const context = resolveServiceReadinessContext(project, service);
      const assessment = evaluateReadiness(context.readiness, { now: reviewedAt });
      const readinessFindings = profileFindings(project, service, context, assessment);
      findings.push(
        ...readinessFindings,
        ...operationalFindings(project, service, readinessFindings, assessment),
        ...stewardshipFindings(project, service, reviewedAt),
      );
    }
    findings.push(...orphanedCredentialFindings(project, reviewedAt), ...accessFreshnessFindings(project, reviewedAt));
  }

  const projectsById = new Map(sourceCatalog.projects.map(({ manifest }) => [manifest.id, manifest]));
  let matchedProviderObservations = 0;
  for (const observation of newestProviderObservations(normalizedProviderEvidence)) {
    const project = projectsById.get(observation.identity.projectId);
    const service = project?.services?.find((candidate) => candidate.id === observation.identity.serviceId);
    if (!project || !service) continue;
    matchedProviderObservations += 1;
    const context = resolveServiceReadinessContext(project, service);
    findings.push(...providerDriftFindings(project, service, observation, reviewedAt, context.fields.profile.value));
  }
  findings.sort(compareFindings);

  return {
    version: 1,
    command: "review-portfolio",
    readOnly: true,
    reviewedAt: reviewedAt.toISOString(),
    summary: {
      projects: sourceCatalog.projects.length,
      services: serviceCount,
      findings: findings.length,
      providerEvidence: {
        received: normalizedProviderEvidence.length,
        matched: matchedProviderObservations,
      },
      severities: Object.fromEntries(["high", "medium", "low"].map((severity) => [
        severity,
        findings.filter((item) => item.severity === severity).length,
      ])),
      states: Object.fromEntries(["drift", "missing", "stale", "unknown"].map((state) => [
        state,
        findings.filter((item) => item.state === state).length,
      ])),
    },
    findings,
  };
}

export function formatPortfolioReview(review) {
  const lines = [
    `DevHub portfolio review: ${review.summary.findings} findings across ${review.summary.projects} projects and ${review.summary.services} services.`,
    `Severity: ${review.summary.severities.high} high, ${review.summary.severities.medium} medium, ${review.summary.severities.low} low.`,
  ];
  if (!review.findings.length) return [...lines, "No catalog-only readiness or recovery gaps found."].join("\n");
  for (const item of review.findings) {
    lines.push(`${item.severity.toUpperCase()} ${item.project}${item.service ? `/${item.service}` : ""} ${item.check} [${item.state}]: ${item.reason}`);
    lines.push(`  Next: ${item.recommendedNextAction}`);
  }
  return lines.join("\n");
}

export { PROFILE_EXPECTATIONS };
