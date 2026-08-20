import assert from "node:assert/strict";
import test from "node:test";
import { catalogForPresentation } from "../lib/catalog-presentation.mjs";
import { resolveServiceStewardshipContext } from "../lib/stewardship.mjs";

function project(overrides = {}) {
  return {
    id: "example-app",
    stewards: [
      { id: "product-team", name: "Product team", kind: "team", source: "operator", observedAt: "2026-08-01T00:00:00Z", validUntil: "2027-01-01T00:00:00Z" },
      { id: "founder", name: "Example founder", kind: "person", source: "operator", observedAt: "2026-08-01T00:00:00Z", validUntil: "2027-01-01T00:00:00Z" },
    ],
    stewardshipDefaults: {
      accountableOwner: "founder",
      operator: "product-team",
      billingOwner: "founder",
      credentialOwner: "product-team",
    },
    access: [{ id: "repository", kind: "repository", subject: "example/app", access: "yes", source: "operator", note: "Reviewed access." }],
    credentials: [{
      id: "mail-api",
      provider: "Example Mail",
      purpose: "Send mail",
      secretRef: { kind: "secret-manager", locator: "op://Example/Mail/value" },
      consumers: ["api"],
      owner: "product-team",
      payer: "founder",
      source: "operator",
      lastVerifiedAt: "2026-08-01T00:00:00Z",
      rotationDueAt: "2027-01-01T00:00:00Z",
    }],
    services: [{ id: "api", stewardship: { operator: "founder" } }],
    ...overrides,
  };
}

test("project defaults resolve with explicit service overrides and provenance", () => {
  const fixture = project();
  const context = resolveServiceStewardshipContext(fixture, fixture.services[0], { now: "2026-08-13T00:00:00Z" });
  assert.equal(context.roles.accountableOwner.steward.name, "Example founder");
  assert.equal(context.roles.accountableOwner.provenance, "project");
  assert.equal(context.roles.operator.steward.name, "Example founder");
  assert.equal(context.roles.operator.provenance, "service");
  assert.equal(context.roles.credentialOwner.steward.kind, "team");
  assert.equal(context.credentials[0].payerSteward.name, "Example founder");
  assert.equal(context.access[0].kind, "repository");
  assert.equal(context.summary.shared, 1);
  assert.equal(context.summary.singlePersonRisk, false);
});

test("stale and single-person assignments stay questions rather than ownership or access proof", () => {
  const fixture = project({
    stewards: [{ id: "founder", name: "Example founder", kind: "person", source: "operator", validUntil: "2026-08-01T00:00:00Z" }],
    stewardshipDefaults: { accountableOwner: "founder", operator: "founder", billingOwner: "founder", credentialOwner: "founder" },
    access: [],
    credentials: [],
    services: [{ id: "api" }],
  });
  const stale = resolveServiceStewardshipContext(fixture, fixture.services[0], { now: "2026-08-13T00:00:00Z" });
  assert.equal(stale.summary.stale, 4);
  assert.equal(stale.summary.singlePersonRisk, false);

  fixture.stewards[0].validUntil = "2027-01-01T00:00:00Z";
  const concentrated = resolveServiceStewardshipContext(fixture, fixture.services[0], { now: "2026-08-13T00:00:00Z" });
  assert.equal(concentrated.summary.singlePersonRisk, true);
  assert.deepEqual(concentrated.access, []);
});

test("explicit unknown overrides, expired access and stale credential owners never resolve as current facts", () => {
  const fixture = project({
    stewards: [
      { id: "product-team", name: "Product team", kind: "team", source: "operator", validUntil: "2026-08-01T00:00:00Z" },
      { id: "founder", name: "Example founder", kind: "person", source: "operator", validUntil: "2026-08-01T00:00:00Z" },
    ],
    access: [{
      id: "provider",
      kind: "provider",
      subject: "Example Cloud",
      access: "yes",
      source: "operator",
      note: "Historical access.",
      validUntil: "2026-08-01T00:00:00Z",
    }],
    credentials: [{
      id: "mail-api",
      provider: "Example Mail",
      purpose: "Send mail",
      secretRef: { kind: "environment", locator: "EXAMPLE_MAIL_API_KEY" },
      consumers: ["api"],
      owner: "product-team",
      payer: "founder",
      source: "operator",
      rotationDueAt: "2026-08-01T00:00:00Z",
    }],
    services: [{ id: "api", stewardship: { billingOwner: null } }],
  });
  const context = resolveServiceStewardshipContext(fixture, fixture.services[0], { now: "2026-08-13T00:00:00Z" });
  assert.equal(context.roles.billingOwner.steward, null);
  assert.equal(context.roles.billingOwner.provenance, "explicit-unknown");
  assert.equal(context.roles.billingOwner.state, "missing");
  assert.equal(context.access[0].recordedAccess, "yes");
  assert.equal(context.access[0].access, "unknown");
  assert.equal(context.access[0].freshnessState, "stale");
  assert.equal(context.credentials[0].ownerState, "stale");
  assert.equal(context.credentials[0].payerState, "stale");
  assert.equal(context.credentials[0].verificationState, "rotation-due");
  assert.equal(context.summary.credentialsWithUnknownPayer, 1);
  assert.equal(context.summary.credentialsWithStaleOwner, 1);
  assert.equal(context.summary.staleAccess, 1);
});

test("presentation catalogs redact external credential locators while preserving configured state", () => {
  const source = { version: 1, hosts: [], projects: [project()] };
  const presented = catalogForPresentation(source);
  assert.equal(presented.projects[0].credentials[0].secretRef.kind, "secret-manager");
  assert.equal(presented.projects[0].credentials[0].secretRef.configured, true);
  assert.equal("locator" in presented.projects[0].credentials[0].secretRef, false);
  assert.equal(source.projects[0].credentials[0].secretRef.locator, "op://Example/Mail/value");
});
