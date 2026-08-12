import readinessPolicy from "../config/readiness-policy.json" with { type: "json" };

export const READINESS_CHECKS = readinessPolicy.checks;
export const PROFILE_EXPECTATIONS = readinessPolicy.profiles;

export const RECOVERY_CHECKS = ["backup", "restore", "rollback", "deployment", "ownership"];

const GAP_ORDER = [
  "security-review",
  "privacy",
  "backup",
  "restore",
  "monitoring",
  "alerting",
  "rollback",
  "ownership",
  "deployment",
  "cost",
];
const GAP_ORDER_INDEX = new Map(GAP_ORDER.map((check, index) => [check, index]));
const EMPTY_COUNTS = {
  verified: 0,
  declared: 0,
  missing: 0,
  stale: 0,
  "not-applicable": 0,
  unknown: 0,
};

function asNow(value) {
  const now = value === undefined ? new Date() : new Date(value);
  if (Number.isNaN(now.getTime())) throw new TypeError("readiness evaluation requires a valid now value");
  return now;
}

function evidenceTime(evidence) {
  if (!evidence.observedAt) return null;
  const timestamp = Date.parse(evidence.observedAt);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function selectCurrentEvidence(evidence) {
  let selected = null;
  for (const [index, candidate] of evidence.entries()) {
    const timestamp = evidenceTime(candidate);
    if (
      selected === null
      || (timestamp !== null && selected.timestamp === null)
      || (timestamp !== null && selected.timestamp !== null && timestamp > selected.timestamp)
      || (timestamp === selected.timestamp && index > selected.index)
    ) {
      selected = { evidence: candidate, index, timestamp };
    }
  }
  return selected?.evidence ?? null;
}

function effectiveState(evidence, now) {
  if (!evidence) return "unknown";
  if (evidence.validUntil) {
    const validUntil = Date.parse(evidence.validUntil);
    if (!Number.isNaN(validUntil) && validUntil < now.getTime()) return "stale";
  }
  return evidence.state;
}

function nextAction(check, state) {
  switch (state) {
    case "verified":
    case "not-applicable":
      return null;
    case "declared":
      return `Verify the declared ${check} evidence and record its provenance.`;
    case "missing":
      return `Address the known ${check} gap and record reviewed evidence.`;
    case "stale":
      return `Refresh the expired ${check} evidence.`;
    default:
      return `Inspect ${check} and record evidence or an explicit not-applicable reason.`;
  }
}

function provenanceOf(evidence) {
  if (!evidence) return null;
  const { source, observedAt, validUntil, url } = evidence;
  return { source, observedAt, validUntil, url };
}

export function evaluateReadiness(readiness, options = {}) {
  const now = asNow(options.now);
  const profile = readiness?.profile ?? null;
  const expected = new Set(profile ? PROFILE_EXPECTATIONS[profile] : []);
  const evidenceByCheck = new Map();

  for (const evidence of readiness?.evidence ?? []) {
    const group = evidenceByCheck.get(evidence.check) ?? [];
    group.push(evidence);
    evidenceByCheck.set(evidence.check, group);
  }

  const checks = READINESS_CHECKS.flatMap((check) => {
    const selected = selectCurrentEvidence(evidenceByCheck.get(check) ?? []);
    if (!expected.has(check) && !selected) return [];
    const state = effectiveState(selected, now);
    const action = expected.has(check) ? nextAction(check, state) : null;
    return [{
      check,
      expected: expected.has(check),
      state,
      evidence: selected,
      provenance: provenanceOf(selected),
      actionable: action !== null,
      action,
    }];
  });

  const counts = { ...EMPTY_COUNTS };
  for (const item of checks) counts[item.state] += 1;
  const gaps = checks
    .filter((item) => item.actionable && item.action !== null)
    .sort((left, right) => (
      (GAP_ORDER_INDEX.get(left.check) ?? Number.MAX_SAFE_INTEGER)
      - (GAP_ORDER_INDEX.get(right.check) ?? Number.MAX_SAFE_INTEGER)
    ));

  return { profile, evaluatedAt: now.toISOString(), checks, gaps, counts };
}

export function groupRecoveryReadiness(assessment) {
  const recoveryChecks = new Set(RECOVERY_CHECKS);
  return {
    checks: assessment.checks.filter((item) => recoveryChecks.has(item.check)),
    gaps: assessment.gaps.filter((item) => recoveryChecks.has(item.check)),
  };
}
