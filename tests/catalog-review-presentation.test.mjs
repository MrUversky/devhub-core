import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import currentCatalog from "../app/generated/catalog.json" with { type: "json" };
import { deriveCatalogReviewPresentation } from "../lib/catalog-review-presentation.mjs";

const NOW = "2026-08-14T00:00:00.000Z";

function assertCanonicalScope(scope) {
  assert.equal(scope.matchingServiceCount, scope.serviceKeys.length);
  assert.deepEqual(scope.serviceKeys, [...scope.serviceKeys].sort());
  assert.equal(new Set(scope.serviceKeys).size, scope.serviceKeys.length);
  assert.ok(scope.matchingProjectCount <= scope.matchingServiceCount);
  assert.ok(scope.matchingServiceCount <= scope.totalServiceCount);
}

test("active catalog counts preserve services, groups and individual items as separate units", () => {
  const presentation = deriveCatalogReviewPresentation(currentCatalog.projects, { now: NOW });
  const serviceCount = currentCatalog.projects.reduce((sum, project) => sum + project.services.length, 0);
  assert.deepEqual(presentation.universe, { projectCount: currentCatalog.projects.length, serviceCount });
  for (const scope of Object.values(presentation.scopes)) assertCanonicalScope(scope);
  for (const scope of Object.values(presentation.scopes)) assert.equal(scope.totalServiceCount, serviceCount);
  assert.equal(presentation.scopes.passport.questionGroupCount, 0);
  assert.equal(presentation.scopes.passport.questionItemCount, 0);
  assert.equal(presentation.scopes["evidence-gap"].questionGroupCount, presentation.scopes["evidence-gap"].matchingServiceCount);
  assert.ok(presentation.scopes["evidence-gap"].questionItemCount >= presentation.scopes["evidence-gap"].questionGroupCount);
  assert.equal(presentation.scopes.stewardship.questionGroupCount, presentation.scopes.stewardship.matchingServiceCount);
  assert.ok(presentation.scopes.stewardship.questionItemCount >= presentation.scopes.stewardship.questionGroupCount);
});

test("derivation is order-independent, immutable and counts each stewardship issue once", () => {
  const projects = [{
    id: "example-project",
    stewards: [{ id: "one-person", name: "One person", kind: "person", source: "operator", validUntil: "2027-01-01T00:00:00Z" }],
    stewardshipDefaults: { accountableOwner: "one-person", operator: "one-person" },
    access: [{ id: "provider", kind: "provider", subject: "Example", access: "yes", source: "operator", note: "Historical.", validUntil: "2026-01-01T00:00:00Z" }],
    credentials: [{ id: "provider-access", provider: "Example", purpose: "Read projects", secretRef: { kind: "environment", configured: true }, consumers: ["worker"], owner: "missing-owner", source: "operator" }],
    services: [{ id: "worker" }],
  }, { id: "empty-project", services: [] }];
  const before = structuredClone(projects);
  const first = deriveCatalogReviewPresentation(projects, { now: NOW });
  const reversed = deriveCatalogReviewPresentation([...projects].reverse(), { now: NOW });

  assert.deepEqual(first, reversed);
  assert.deepEqual(projects, before);
  assert.deepEqual(first.universe, { projectCount: 2, serviceCount: 1 });
  assert.deepEqual(first.scopes.stewardship, {
    matchingServiceCount: 1,
    totalServiceCount: 1,
    matchingProjectCount: 1,
    serviceKeys: ["example-project/worker"],
    questionGroupCount: 1,
    questionItemCount: 6,
  });
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.scopes.stewardship.serviceKeys), true);
});

test("hostile or ambiguous catalog shapes fail before producing navigation keys", () => {
  assert.throws(() => deriveCatalogReviewPresentation(null, { now: NOW }), /projects array/i);
  assert.throws(() => deriveCatalogReviewPresentation([{ id: "not/safe", services: [] }], { now: NOW }), /stable kebab-case/i);
  assert.throws(() => deriveCatalogReviewPresentation([{ id: "duplicate", services: [] }, { id: "duplicate", services: [] }], { now: NOW }), /duplicate.*project/i);
  assert.throws(() => deriveCatalogReviewPresentation([{ id: "project", services: [{ id: "service" }, { id: "service" }] }], { now: NOW }), /duplicate.*service/i);
  assert.throws(() => deriveCatalogReviewPresentation([{ id: "project", services: [] }], { now: "not-a-date" }), /valid now/i);
  assert.throws(() => deriveCatalogReviewPresentation([], { now: NOW, extra: true }), /not supported/i);
});

test("browser presentation module imports only pure review dependencies", async () => {
  const source = await readFile(new URL("../lib/catalog-review-presentation.mjs", import.meta.url), "utf8");
  const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
  assert.deepEqual(imports, ["./readiness.mjs", "./stewardship.mjs"]);
  assert.doesNotMatch(source, /node:|generated\/catalog|setup-session|provider|credentialRef|locator/i);
});
