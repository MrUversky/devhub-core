import assert from "node:assert/strict";
import test from "node:test";

import {
  PROFILE_EXPECTATIONS,
  evaluateReadiness,
  groupRecoveryReadiness,
} from "../lib/readiness.mjs";

const NOW = "2026-08-13T12:00:00.000Z";

function evidence(check, state, overrides = {}) {
  return {
    id: `${check}-${state}`,
    check,
    state,
    source: "operator",
    note: `${check} is ${state}`,
    observedAt: "2026-08-01T12:00:00.000Z",
    ...overrides,
  };
}

test("profile policies expose expected checks without producing a score", () => {
  assert.deepEqual(PROFILE_EXPECTATIONS.personal, [
    "backup", "restore", "rollback", "ownership", "cost", "deployment",
  ]);
  assert.ok(PROFILE_EXPECTATIONS.internal.includes("monitoring"));
  assert.ok(!PROFILE_EXPECTATIONS.internal.includes("privacy"));
  assert.ok(PROFILE_EXPECTATIONS["customer-facing"].includes("security-review"));
  assert.deepEqual(PROFILE_EXPECTATIONS.sensitive, PROFILE_EXPECTATIONS["customer-facing"]);

  const assessment = evaluateReadiness({ profile: "personal", evidence: [] }, { now: NOW });
  assert.equal("score" in assessment, false);
  assert.equal(assessment.checks.length, PROFILE_EXPECTATIONS.personal.length);
  assert.ok(assessment.checks.every((item) => item.state === "unknown"));
  assert.ok(assessment.checks.every((item) => item.evidence === null && item.provenance === null));
});

test("absence is unknown while explicit missing and not-applicable remain distinct", () => {
  const assessment = evaluateReadiness({
    profile: "internal",
    evidence: [
      evidence("monitoring", "missing"),
      evidence("backup", "not-applicable", { note: "The service is stateless." }),
    ],
  }, { now: NOW });

  assert.equal(assessment.checks.find((item) => item.check === "monitoring").state, "missing");
  assert.equal(assessment.checks.find((item) => item.check === "backup").state, "not-applicable");
  assert.equal(assessment.checks.find((item) => item.check === "restore").state, "unknown");
  assert.equal(assessment.gaps.some((item) => item.check === "backup"), false);
  assert.match(
    assessment.gaps.find((item) => item.check === "restore").action,
    /record evidence or an explicit not-applicable reason/,
  );
});

test("expired evidence becomes stale with its evidence and provenance intact", () => {
  const expired = evidence("restore", "verified", {
    id: "restore-exercise",
    source: "integration",
    validUntil: "2026-08-12T12:00:00.000Z",
    url: "https://evidence.example.test/restore-exercise",
  });
  const assessment = evaluateReadiness({
    profile: "personal",
    evidence: [expired],
  }, { now: NOW });
  const restore = assessment.checks.find((item) => item.check === "restore");

  assert.equal(restore.state, "stale");
  assert.equal(restore.evidence, expired);
  assert.deepEqual(restore.provenance, {
    source: "integration",
    observedAt: "2026-08-01T12:00:00.000Z",
    validUntil: "2026-08-12T12:00:00.000Z",
    url: "https://evidence.example.test/restore-exercise",
  });
  assert.match(restore.action, /Refresh the expired restore evidence/);
});

test("the newest observation wins and extra reviewed evidence remains visible", () => {
  const current = evidence("monitoring", "verified", {
    id: "monitoring-current",
    observedAt: "2026-08-10T12:00:00.000Z",
  });
  const assessment = evaluateReadiness({
    profile: "personal",
    evidence: [
      current,
      evidence("monitoring", "missing", {
        id: "monitoring-old",
        observedAt: "2026-07-01T12:00:00.000Z",
      }),
    ],
  }, { now: NOW });
  const monitoring = assessment.checks.find((item) => item.check === "monitoring");

  assert.equal(monitoring.expected, false);
  assert.equal(monitoring.state, "verified");
  assert.equal(monitoring.evidence, current);
  assert.equal(monitoring.actionable, false);
});

test("gaps are actionable and ordered by harm rather than by a magic score", () => {
  const assessment = evaluateReadiness({
    profile: "customer-facing",
    evidence: [
      evidence("privacy", "declared"),
      evidence("security-review", "missing"),
      evidence("backup", "verified"),
      evidence("cost", "unknown"),
    ],
  }, { now: NOW });

  assert.deepEqual(
    assessment.gaps.slice(0, 4).map((item) => item.check),
    ["security-review", "privacy", "restore", "monitoring"],
  );
  assert.equal(assessment.gaps.at(-1).check, "cost");
  assert.equal(assessment.counts.verified, 1);
  assert.equal(assessment.counts.declared, 1);
  assert.equal(assessment.counts.missing, 1);
  assert.equal(assessment.counts.unknown, 7);
});

test("recovery grouping keeps only backup, restore, rollback, deployment and ownership", () => {
  const assessment = evaluateReadiness({
    profile: "sensitive",
    evidence: [
      evidence("backup", "verified"),
      evidence("privacy", "missing"),
      evidence("deployment", "declared"),
    ],
  }, { now: NOW });
  const recovery = groupRecoveryReadiness(assessment);

  assert.deepEqual(recovery.checks.map((item) => item.check), [
    "backup", "restore", "rollback", "ownership", "deployment",
  ]);
  assert.deepEqual(recovery.gaps.map((item) => item.check), [
    "restore", "rollback", "ownership", "deployment",
  ]);
  assert.equal(recovery.checks.some((item) => item.check === "privacy"), false);
});

test("evaluation rejects an invalid injected clock", () => {
  assert.throws(
    () => evaluateReadiness({ profile: "personal", evidence: [] }, { now: "not-a-date" }),
    /valid now value/,
  );
});
