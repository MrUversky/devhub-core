import assert from "node:assert/strict";
import test from "node:test";
import { PROFILE_EXPECTATIONS, reviewPortfolio } from "../scripts/portfolio-review.mjs";
import { validateEvidenceAdapterResult } from "../lib/evidence-adapters.mjs";
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

function catalog(services, overrides = {}) {
  return {
    projects: [{
      manifest: {
        id: "example-project",
        title: "Example project",
        lifecycle: "active",
        services,
        ...overrides,
      },
    }],
  };
}

function providerObservation(overrides = {}) {
  const base = {
    formatVersion: 1,
    identity: {
      projectId: "example-project",
      serviceId: "web",
      adapterId: "example-deployment-v1",
      provider: "example-cloud",
      reviewedIdentity: {
        resourceId: "reviewed-resource",
        serviceUrl: "https://app.example.test",
        catalogHost: "example-host",
      },
    },
    execution: { state: "succeeded", reason: "adapter-observation", cache: "none" },
    freshness: {
      state: "fresh",
      observedAt: "2026-08-13T10:00:00.000Z",
      validUntil: "2026-09-13T10:00:00.000Z",
      evaluatedAt: "2026-08-13T12:00:00.000Z",
    },
    evidence: [{
      id: "example-deployment",
      check: "deployment",
      state: "verified",
      source: "integration",
      note: "Exact reviewed deployment binding observed.",
      observedAt: "2026-08-13T10:00:00.000Z",
      validUntil: "2026-09-13T10:00:00.000Z",
      url: "https://console.example.test/resources/reviewed-resource",
    }],
    deployment: {
      identity: "reviewed-resource",
      revision: "abc123",
      url: "https://app.example.test",
      host: "example-host",
    },
  };
  return validateEvidenceAdapterResult({ ...base, ...overrides });
}

function providerOnly(review) {
  return review.findings.filter((item) => item.evidence?.type === "normalized-provider-observation");
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

test("project readiness defaults provide context but never inherit service evidence", () => {
  const review = reviewPortfolio(catalog([service({
    mode: "on-demand",
    commands: { start: "npm run dev", logs: "npm run logs" },
  })], {
    readinessDefaults: {
      profile: "personal",
      owner: "Product owner",
      dataClassification: "internal",
      costModel: "fixed",
    },
  }), { now: "2026-08-13T00:00:00.000Z" });

  assert.equal(review.findings.some((item) => item.check === "readiness-profile"), false);
  assert.equal(review.findings.filter((item) => item.check === "ownership").length, 1);
  const ownership = review.findings.find((item) => item.check === "ownership");
  assert.equal(ownership.state, "unknown");
  assert.equal(ownership.evidence, null);
  assert.match(ownership.reason, /inherited from the project.*no service-specific ownership evidence/);
  assert.deepEqual(
    review.findings.map((item) => item.check).sort(),
    ["backup", "cost", "deployment", "ownership", "restore", "rollback"],
  );
  assert.ok(review.findings.every((item) => item.evidence === null));
});

test("guardian asks evidence-backed stewardship questions without inferring access or deletion", () => {
  const review = reviewPortfolio(catalog([service({
    mode: "managed",
    commands: { logs: "npm run logs" },
  })], {
    stewards: [{
      id: "founder",
      name: "Example founder",
      kind: "person",
      source: "operator",
      observedAt: "2026-08-01T00:00:00Z",
      validUntil: "2027-01-01T00:00:00Z",
    }],
    stewardshipDefaults: {
      accountableOwner: "founder",
      operator: "founder",
      billingOwner: "founder",
      credentialOwner: "founder",
    },
    access: [{
      id: "repository-access",
      kind: "repository",
      subject: "example/project",
      access: "yes",
      source: "operator",
      note: "Repository access only.",
    }],
    credentials: [{
      id: "ai-api",
      provider: "Example AI",
      purpose: "Inference",
      secretRef: { kind: "environment", locator: "EXAMPLE_AI_API_KEY" },
      consumers: ["web"],
      owner: "founder",
      source: "operator",
      lastVerifiedAt: "2026-07-01T00:00:00Z",
      rotationDueAt: "2026-08-01T00:00:00Z",
    }],
  }), { now: "2026-08-13T00:00:00Z" });

  const concentration = review.findings.find((item) => item.check === "stewardship-single-owner");
  assert.equal(concentration.state, "unknown");
  assert.match(concentration.uncertainty, /not proof.*provider access/i);
  const payer = review.findings.find((item) => item.check === "credential-payer");
  assert.equal(payer.evidence.secretRef.locator, undefined);
  assert.deepEqual(payer.evidence.secretRef, { kind: "environment", configured: true });
  assert.match(payer.reason, /no current reviewed payer/);
  assert.ok(review.findings.some((item) => item.check === "credential-rotation" && item.state === "stale"));
  assert.ok(review.findings.filter((item) => item.check.startsWith("credential-") || item.check.startsWith("stewardship-"))
    .every((item) => !/delete|revoke/i.test(item.recommendedNextAction)));
});

test("guardian reports orphaned credential references at project scope and never recommends deletion", () => {
  const review = reviewPortfolio(catalog([service()], {
    stewards: [{ id: "team", name: "Example team", kind: "team", source: "operator" }],
    credentials: [{
      id: "old-api",
      provider: "Example Provider",
      purpose: "Previously reviewed integration",
      secretRef: { kind: "secret-manager", locator: "op://Example/Old/value" },
      consumers: [],
      owner: "team",
      payer: "team",
      source: "operator",
    }],
  }), { now: "2026-08-13T00:00:00Z" });
  const orphan = review.findings.find((item) => item.check === "credential-orphan");
  assert.equal(orphan.service, null);
  assert.match(orphan.reason, /no reviewed service consumers/);
  assert.match(orphan.uncertainty, /does not prove.*unused/i);
  assert.doesNotMatch(orphan.recommendedNextAction, /delete|revoke/i);
  assert.equal(orphan.evidence.secretRef.locator, undefined);
});

test("guardian treats expired access and credential stewardship as stale historical context", () => {
  const review = reviewPortfolio(catalog([service({ mode: "managed", commands: { logs: "npm run logs" } })], {
    stewards: [{ id: "founder", name: "Founder", kind: "person", source: "operator", validUntil: "2026-08-01T00:00:00Z" }],
    stewardshipDefaults: { accountableOwner: "founder", operator: "founder", billingOwner: "founder", credentialOwner: "founder" },
    access: [{ id: "provider", kind: "provider", subject: "Example Cloud", access: "yes", source: "operator", note: "Historical access.", validUntil: "2026-08-01T00:00:00Z" }],
    credentials: [{
      id: "ai-api",
      provider: "Example AI",
      purpose: "Inference",
      secretRef: { kind: "environment", locator: "EXAMPLE_AI_API_KEY" },
      consumers: ["web"],
      owner: "founder",
      payer: "founder",
      source: "operator",
      rotationDueAt: "2026-08-01T00:00:00Z",
    }],
  }), { now: "2026-08-13T00:00:00Z" });
  const access = review.findings.find((item) => item.check === "access-freshness");
  assert.equal(access.state, "stale");
  assert.equal(access.evidence.recordedAccess, "yes");
  assert.equal(access.evidence.effectiveAccess, "unknown");
  assert.ok(review.findings.some((item) => item.check === "credential-owner" && item.state === "stale"));
  assert.ok(review.findings.some((item) => item.check === "credential-payer" && item.state === "stale"));
  assert.ok(review.findings.some((item) => item.check === "credential-rotation" && item.state === "stale"));
  assert.equal(JSON.stringify(review).includes("EXAMPLE_AI_API_KEY"), false);
});

test("service context overrides project defaults without inheriting deployment, dependencies or evidence", () => {
  const serviceEvidence = [{
    id: "privacy-review",
    check: "privacy",
    state: "not-applicable",
    source: "operator",
    note: "No personal data is stored by this fixture.",
  }];
  const review = reviewPortfolio(catalog([service({
    mode: "on-demand",
    commands: { start: "npm run dev", logs: "npm run logs" },
    readiness: {
      profile: "customer-facing",
      owner: "Service owner",
      dataClassification: "personal",
      costModel: "metered",
      evidence: serviceEvidence,
    },
  })], {
    readinessDefaults: {
      profile: "personal",
      owner: "Project owner",
      dataClassification: "internal",
      costModel: "fixed",
    },
  }), { now: "2026-08-13T00:00:00.000Z" });

  assert.equal(review.findings.some((item) => item.check === "readiness-profile"), false);
  assert.equal(review.findings.some((item) => item.check === "privacy"), false);
  assert.ok(review.findings.some((item) => item.check === "security-review"));
  assert.ok(review.findings.some((item) => item.check === "alerting"));
  assert.equal(review.findings.find((item) => item.check === "ownership").state, "unknown");
  assert.equal(review.findings.find((item) => item.check === "deployment").evidence, null);
});

test("inherited sensitive profile preserves high severity for stale provider recovery evidence", () => {
  const observation = providerObservation({
    evidence: [{
      id: "restore-old",
      check: "restore",
      state: "verified",
      source: "integration",
      note: "Restore observation expired.",
      observedAt: "2026-07-01T00:00:00.000Z",
      validUntil: "2026-08-01T00:00:00.000Z",
    }],
  });
  const review = reviewPortfolio(catalog([service()], {
    readinessDefaults: { profile: "sensitive", owner: "Security owner" },
  }), {
    now: "2026-08-13T12:00:00.000Z",
    providerEvidence: [observation],
  });
  const restore = providerOnly(review).find((item) => item.check === "restore");
  assert.equal(restore.state, "stale");
  assert.equal(restore.severity, "high");
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

test("provider drift names changed deployment identity, URL and host with linked uncertainty", () => {
  const observation = providerObservation({
    deployment: {
      identity: "moved-resource",
      revision: "def456",
      url: "https://moved.example.test",
      host: "moved-host",
    },
  });
  const review = reviewPortfolio(catalog([service({ url: "https://app.example.test" })]), {
    now: "2026-08-13T12:00:00.000Z",
    providerEvidence: [observation],
  });
  const findings = providerOnly(review);

  assert.deepEqual(findings.map((item) => item.check), ["deployment-host", "deployment-identity", "deployment-url"]);
  assert.ok(findings.every((item) => item.state === "drift" && item.evidence.evidenceId === "example-deployment"));
  assert.ok(findings.every((item) => item.evidence.reviewedIdentity.resourceId === "reviewed-resource"));
  assert.ok(findings.every((item) => item.uncertainty && item.recommendedNextAction.split(".").filter(Boolean).length === 1));
  assert.equal(review.summary.providerEvidence.received, 1);
  assert.equal(review.summary.providerEvidence.matched, 1);
  assert.equal(review.summary.states.drift, 3);
});

test("matching deployment observation produces no drift and newer result wins deterministically", () => {
  const older = providerObservation({
    freshness: {
      state: "fresh",
      observedAt: "2026-08-12T10:00:00.000Z",
      validUntil: "2026-09-12T10:00:00.000Z",
      evaluatedAt: "2026-08-13T12:00:00.000Z",
    },
    evidence: [{
      id: "example-deployment",
      check: "deployment",
      state: "verified",
      source: "integration",
      note: "Older observation.",
      observedAt: "2026-08-12T10:00:00.000Z",
      validUntil: "2026-09-12T10:00:00.000Z",
    }],
    deployment: { identity: "moved-resource", url: "https://old.example.test", host: "old-host" },
  });
  const newest = providerObservation();
  const input = catalog([service({ url: "https://app.example.test" })]);
  const forward = reviewPortfolio(input, { now: "2026-08-13T12:00:00.000Z", providerEvidence: [older, newest] });
  const reverse = reviewPortfolio(input, { now: "2026-08-13T12:00:00.000Z", providerEvidence: [newest, older] });

  assert.deepEqual(forward, reverse);
  assert.deepEqual(providerOnly(forward), []);
  assert.deepEqual(forward.summary.providerEvidence, { received: 2, matched: 1 });
});

test("a reviewed catalog host or URL update resolves corresponding provider drift", () => {
  const observation = providerObservation({
    deployment: {
      identity: "reviewed-resource",
      url: "https://moved.example.test",
      host: "moved-host",
    },
  });
  const review = reviewPortfolio(catalog([service({
    url: "https://moved.example.test",
    host: "moved-host",
  })]), {
    now: "2026-08-13T12:00:00.000Z",
    providerEvidence: [observation],
  });

  assert.deepEqual(providerOnly(review), []);
});

test("expired normalized backup and restore evidence remains visible but reviewed resolution suppresses false positives", () => {
  const observation = providerObservation({
    freshness: {
      state: "stale",
      observedAt: "2026-07-01T00:00:00.000Z",
      validUntil: "2026-08-01T00:00:00.000Z",
      evaluatedAt: "2026-08-13T12:00:00.000Z",
    },
    evidence: ["backup", "restore"].map((check, index) => ({
      id: `${check}-exercise`,
      check,
      state: index === 0 ? "verified" : "declared",
      source: "integration",
      note: `Old ${check} evidence.`,
      observedAt: "2026-07-01T00:00:00.000Z",
      validUntil: "2026-08-01T00:00:00.000Z",
      url: `https://console.example.test/${check}`,
    })),
  });
  const unresolved = reviewPortfolio(catalog([service()]), {
    now: "2026-08-13T12:00:00.000Z",
    providerEvidence: [observation],
  });
  assert.deepEqual(providerOnly(unresolved).map((item) => item.check), ["backup", "restore", "provider-evidence"]);
  assert.ok(providerOnly(unresolved).every((item) => item.state === "stale"));

  const resolvedService = service({
    readiness: {
      profile: "personal",
      evidence: [
        {
          id: "backup-newer",
          check: "backup",
          state: "verified",
          source: "operator",
          note: "A newer backup review supersedes the provider observation.",
          observedAt: "2026-08-10T00:00:00.000Z",
          validUntil: "2026-09-10T00:00:00.000Z",
        },
        {
          id: "restore-not-applicable",
          check: "restore",
          state: "not-applicable",
          source: "operator",
          note: "This reviewed stateless service has no restore boundary.",
        },
      ],
    },
  });
  const resolved = reviewPortfolio(catalog([resolvedService]), {
    now: "2026-08-13T12:00:00.000Z",
    providerEvidence: [observation],
  });
  assert.deepEqual(providerOnly(resolved).map((item) => item.check), ["provider-evidence"]);
});

test("paused or discovery resources with recurring cost create an owner review, never a deletion action", () => {
  const observation = providerObservation({
    evidence: [{
      id: "provider-cost",
      check: "cost",
      state: "verified",
      source: "integration",
      note: "The exact bound resource has recurring cost.",
      observedAt: "2026-08-13T10:00:00.000Z",
      validUntil: "2026-09-13T10:00:00.000Z",
      url: "https://billing.example.test/resources/reviewed-resource",
    }],
    recurringCost: {
      state: "present",
      observedAt: "2026-08-13T10:00:00.000Z",
      url: "https://billing.example.test/resources/reviewed-resource",
    },
  });
  const review = reviewPortfolio(catalog([service()], { lifecycle: "paused" }), {
    now: "2026-08-13T12:00:00.000Z",
    providerEvidence: [observation],
  });
  const recurring = providerOnly(review).find((item) => item.check === "recurring-cost");

  assert.equal(recurring.state, "drift");
  assert.match(recurring.uncertainty, /does not prove the resource is unused/);
  assert.match(recurring.recommendedNextAction, /^Open an owner review /);
  assert.doesNotMatch(`${recurring.reason} ${recurring.recommendedNextAction}`, /delete|remove|stop/i);
});

test("current reviewed cost evidence suppresses recurring-cost review and unmatched bindings do not enumerate", () => {
  const observation = providerObservation({
    evidence: [{
      id: "provider-cost",
      check: "cost",
      state: "verified",
      source: "integration",
      note: "Current recurring cost.",
      observedAt: "2026-08-13T10:00:00.000Z",
      validUntil: "2026-09-13T10:00:00.000Z",
    }],
    recurringCost: { state: "present", observedAt: "2026-08-13T10:00:00.000Z" },
  });
  const owned = service({
    readiness: {
      profile: "personal",
      evidence: [{
        id: "cost-approved",
        check: "cost",
        state: "verified",
        source: "operator",
        note: "The owner approved this paused resource cost.",
        observedAt: "2026-08-13T11:00:00.000Z",
        validUntil: "2026-09-13T11:00:00.000Z",
      }],
    },
  });
  const resolved = reviewPortfolio(catalog([owned], { lifecycle: "paused" }), {
    now: "2026-08-13T12:00:00.000Z",
    providerEvidence: [observation],
  });
  assert.equal(providerOnly(resolved).some((item) => item.check === "recurring-cost"), false);

  const unmatched = structuredClone(observation);
  unmatched.identity.serviceId = "not-in-catalog";
  const ignored = reviewPortfolio(catalog([service()], { lifecycle: "paused" }), {
    now: "2026-08-13T12:00:00.000Z",
    providerEvidence: [validateEvidenceAdapterResult(unmatched)],
  });
  assert.deepEqual(providerOnly(ignored), []);
  assert.deepEqual(ignored.summary.providerEvidence, { received: 1, matched: 0 });
});

test("provider failure stays unknown even when cached deployment fields remain visible", () => {
  const failed = providerObservation({
    execution: { state: "failed", reason: "provider-unavailable", cache: "fresh" },
  });
  const review = reviewPortfolio(catalog([service({ url: "https://app.example.test" })]), {
    now: "2026-08-13T12:00:00.000Z",
    providerEvidence: [failed],
  });

  assert.deepEqual(providerOnly(review).map((item) => [item.check, item.state]), [["provider-evidence", "unknown"]]);
});

test("review engine rejects arbitrary provider objects before evaluating them", () => {
  assert.throws(
    () => reviewPortfolio(catalog([service()]), {
      now: "2026-08-13T12:00:00.000Z",
      providerEvidence: [{ resources: [{ id: "unreviewed" }] }],
    }),
    /formatVersion|not supported/,
  );
});

test("provider-specific deployment fields do not drift across incomparable namespaces", () => {
  const githubLike = providerObservation({
    identity: {
      projectId: "example-project",
      serviceId: "web",
      adapterId: "github-actions-deployment-v1",
      provider: "github",
      reviewedIdentity: {
        owner: "example",
        repository: "app",
        workflowId: "100",
        runId: "200",
        deploymentId: "300",
        statusId: "400",
        environment: "production",
      },
    },
    deployment: {
      identity: "example/app#deployment-300/status-400",
      revision: "abc123",
      url: "https://github.com/example/app/actions/runs/200",
      host: "production",
    },
  });
  const review = reviewPortfolio(catalog([service({
    url: "https://app.example.test",
    host: "example-host",
  })]), {
    now: "2026-08-13T12:00:00.000Z",
    providerEvidence: [githubLike],
  });

  assert.deepEqual(providerOnly(review), []);
});
