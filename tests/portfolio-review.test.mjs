import assert from "node:assert/strict";
import test from "node:test";
import { PROFILE_EXPECTATIONS, reviewPortfolio } from "../scripts/portfolio-review.mjs";
import readinessPolicy from "../config/readiness-policy.json" with { type: "json" };

function service(overrides = {}) {
  return {
    id: "web",
    name: "Web",
    kind: "web",
    environment: "production",
    host: "example-host",
    runtime: "node",
    mode: "managed",
    visibility: "public",
    ...overrides,
  };
}

function catalog(services) {
  return {
    projects: [{
      manifest: {
        id: "example-project",
        title: "Example project",
        services,
      },
    }],
  };
}

test("review derives missing, stale and unknown states without a score", () => {
  const now = new Date("2026-08-13T12:00:00.000Z");
  const review = reviewPortfolio(catalog([service({
    readiness: {
      profile: "customer-facing",
      evidence: [
        {
          id: "monitoring-check",
          check: "monitoring",
          state: "verified",
          source: "integration",
          note: "Reviewed availability check.",
          validUntil: "2026-08-01T00:00:00.000Z",
        },
        {
          id: "backup-gap",
          check: "backup",
          state: "missing",
          source: "operator",
          note: "No backup configured.",
        },
        {
          id: "ownership-declaration",
          check: "ownership",
          state: "declared",
          source: "operator",
          note: "The founder currently operates this service.",
        },
        {
          id: "privacy-exemption",
          check: "privacy",
          state: "not-applicable",
          source: "operator",
          note: "The fictional demo stores no user data.",
        },
      ],
    },
  })]), { now });

  assert.equal(review.reviewedAt, now.toISOString());
  assert.equal("score" in review, false);
  assert.equal(review.findings.find((item) => item.check === "monitoring").state, "stale");
  assert.equal(review.findings.find((item) => item.check === "backup").state, "missing");
  assert.equal(review.findings.find((item) => item.check === "ownership").state, "unknown");
  assert.equal(review.findings.some((item) => item.check === "privacy"), false);
  assert.ok(review.findings.some((item) => item.check === "deployment" && item.evidence === null));
  assert.ok(review.findings.every((item) => [
    "project", "service", "check", "state", "evidence", "reason", "recommendedNextAction", "severity",
  ].every((field) => Object.hasOwn(item, field))));
});

test("CLI review uses the canonical profile policy", () => {
  assert.strictEqual(PROFILE_EXPECTATIONS, readinessPolicy.profiles);
});

test("a current verified or explicitly not-applicable conclusion satisfies an expected check", () => {
  const evidence = PROFILE_EXPECTATIONS.personal.map((check, index) => ({
    id: `${check}-evidence`,
    check,
    state: index === 0 ? "not-applicable" : "verified",
    source: "operator",
    note: "Reviewed fixture evidence.",
    validUntil: "2027-01-01T00:00:00.000Z",
  }));
  const review = reviewPortfolio(catalog([service({
    mode: "on-demand",
    commands: { start: "npm run dev", logs: "npm run logs" },
    readiness: { profile: "personal", evidence },
  })]), { now: "2026-08-13T00:00:00.000Z" });

  assert.deepEqual(review.findings, []);
});

test("always-on services need a probe or current monitoring and reviewed recovery guidance", () => {
  const review = reviewPortfolio(catalog([service({
    mode: "always-on",
    readiness: {
      profile: "internal",
      evidence: [{
        id: "monitoring-unknown",
        check: "monitoring",
        state: "unknown",
        source: "catalog",
        note: "No monitoring evidence registered.",
      }],
    },
  })]), { now: "2026-08-13T00:00:00.000Z" });

  const monitoring = review.findings.filter((item) => item.check === "monitoring");
  assert.equal(monitoring.length, 1);
  assert.match(monitoring[0].reason, /neither a reviewed health probe nor current verified monitoring/);
  assert.ok(review.findings.some((item) => item.check === "recovery-guidance" && item.severity === "medium"));
});

test("expired recovery evidence does not hide a recovery guidance gap", () => {
  const review = reviewPortfolio(catalog([service({
    mode: "managed",
    readiness: {
      profile: "personal",
      evidence: [{
        id: "restore-old",
        check: "restore",
        state: "verified",
        source: "operator",
        note: "An old restore exercise.",
        validUntil: "2026-08-01T00:00:00.000Z",
      }],
    },
  })]), { now: "2026-08-13T00:00:00.000Z" });

  assert.ok(review.findings.some((item) => item.check === "restore" && item.state === "stale"));
  assert.ok(review.findings.some((item) => item.check === "recovery-guidance"));
});

test("services without a passport remain honest unknowns", () => {
  const review = reviewPortfolio(catalog([service({ mode: "on-demand", commands: { start: "npm run dev" } })]), {
    now: "2026-08-13T00:00:00.000Z",
  });
  assert.ok(review.findings.some((item) => item.check === "readiness-profile" && item.state === "unknown"));
  assert.ok(review.findings.some((item) => item.check === "ownership" && item.state === "unknown"));
  assert.equal(review.summary.states.unknown, review.findings.length);
});

test("results are deterministic for injected time and input", () => {
  const input = catalog([
    service({ id: "zeta", mode: "always-on" }),
    service({ id: "alpha", mode: "on-demand", commands: { start: "npm start" } }),
  ]);
  const first = reviewPortfolio(input, { now: "2026-08-13T00:00:00.000Z" });
  const second = reviewPortfolio(input, { now: new Date("2026-08-13T00:00:00.000Z") });
  assert.deepEqual(first, second);
  assert.deepEqual(first.findings.map((item) => item.service), ["zeta", "zeta", "zeta", "zeta", "alpha", "alpha"]);
  assert.throws(() => reviewPortfolio(input, { now: "not-a-date" }), /valid now/);
});
