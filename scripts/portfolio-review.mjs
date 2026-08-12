import { evaluateReadiness, PROFILE_EXPECTATIONS } from "../lib/readiness.mjs";

const STATE_ORDER = Object.freeze({ missing: 0, stale: 1, unknown: 2 });
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
});

function asDate(now) {
  const value = now instanceof Date ? new Date(now) : new Date(now ?? Date.now());
  if (!Number.isFinite(value.getTime())) throw new TypeError("Portfolio review needs a valid now value.");
  return value;
}

function serviceIdentity(project, service) {
  return { project: project.id, service: service.id };
}

function finding(project, service, { check, state, evidence = null, reason, severity }) {
  return {
    ...serviceIdentity(project, service),
    check,
    state,
    evidence,
    reason,
    recommendedNextAction: NEXT_ACTIONS[check],
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

function profileFindings(project, service, now) {
  if (!service.readiness) {
    const severity = service.mode === "always-on" || service.mode === "managed" ? "medium" : "low";
    return [
      finding(project, service, {
        check: "readiness-profile",
        state: "unknown",
        reason: "No App Passport operating profile is registered, so expected readiness evidence cannot be evaluated.",
        severity,
      }),
      finding(project, service, {
        check: "ownership",
        state: "unknown",
        reason: "No App Passport ownership evidence is registered for this service.",
        severity,
      }),
    ];
  }

  const { profile } = service.readiness;
  const assessment = evaluateReadiness(service.readiness, { now });
  return assessment.checks.flatMap((item) => {
    const { check, evidence: evidenceItem, state: effective, expected } = item;
    if (!["declared", "missing", "stale", "unknown"].includes(effective)) return [];
    if (!expected && !["missing", "stale", "unknown"].includes(effective)) return [];
    const state = effective === "declared" ? "unknown" : effective;
    return [finding(project, service, {
      check,
      state,
      evidence: evidenceItem,
      reason: reasonFor(check, state, evidenceItem),
      severity: severityFor(profile, check, state),
    })];
  });
}

function operationalFindings(project, service, existingFindings, now) {
  const findings = [];
  const existingByCheck = new Map(existingFindings.map((item) => [item.check, item]));
  const assessment = evaluateReadiness(service.readiness, { now });
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

function compareFindings(left, right) {
  return SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]
    || left.project.localeCompare(right.project)
    || left.service.localeCompare(right.service)
    || left.check.localeCompare(right.check)
    || STATE_ORDER[left.state] - STATE_ORDER[right.state];
}

export function reviewPortfolio(sourceCatalog, { now } = {}) {
  const reviewedAt = asDate(now);
  const findings = [];
  let serviceCount = 0;

  for (const { manifest: project } of sourceCatalog.projects) {
    for (const service of project.services ?? []) {
      serviceCount += 1;
      const readinessFindings = profileFindings(project, service, reviewedAt);
      findings.push(...readinessFindings, ...operationalFindings(project, service, readinessFindings, reviewedAt));
    }
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
      severities: Object.fromEntries(["high", "medium", "low"].map((severity) => [
        severity,
        findings.filter((item) => item.severity === severity).length,
      ])),
      states: Object.fromEntries(["missing", "stale", "unknown"].map((state) => [
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
    lines.push(`${item.severity.toUpperCase()} ${item.project}/${item.service} ${item.check} [${item.state}]: ${item.reason}`);
    lines.push(`  Next: ${item.recommendedNextAction}`);
  }
  return lines.join("\n");
}

export { PROFILE_EXPECTATIONS };
