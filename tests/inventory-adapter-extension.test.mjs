import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runInventoryAdapter } from "../lib/inventory-adapters.mjs";
import { inventoryAdapterRegistry } from "../lib/inventory-adapters/registry.mjs";
import { reconcileProviderInventory } from "../scripts/provider-inventory.mjs";

const TEAM_ID = "fixture-team-omega";
const ADAPTER_ID = "example-cloud-fixture-v1";
const NOW = "2026-08-13T12:00:00.000Z";
const FIXTURE_DIR = new URL("./fixtures/inventory-adapters/", import.meta.url);

const rawTeamSnapshot = JSON.parse(await readFile(
  new URL("example-cloud-team.json", FIXTURE_DIR),
  "utf8",
));
const unsafeCandidate = JSON.parse(await readFile(
  new URL("example-cloud-unsafe-candidate.json", FIXTURE_DIR),
  "utf8",
));

const binding = {
  adapterId: ADAPTER_ID,
  provider: "example-cloud",
  scope: { kind: "team", id: TEAM_ID },
  credentialEnv: null,
  freshForSeconds: 3600,
  maxResources: 10,
  maxPages: 2,
  deadlineMs: 1000,
};

function exactTeamScope(scope) {
  return scope?.kind === "team"
    && scope.id === TEAM_ID
    && Object.keys(scope).length === 2;
}

function statusFromPhase(phase) {
  if (phase === "ready") return "running";
  if (phase === "paused") return "stopped";
  if (phase === "building") return "deploying";
  if (phase === "broken") return "failed";
  return "unknown";
}

function repositoryFromCodeLink(codeLink) {
  if (codeLink?.host !== "gitlab" || !Array.isArray(codeLink.pathSegments) || codeLink.pathSegments.length !== 2) {
    return undefined;
  }
  const [owner, name] = codeLink.pathSegments;
  if (![owner, name].every((segment) => typeof segment === "string" && /^[a-z0-9-]+$/.test(segment))) {
    return undefined;
  }
  return { provider: "gitlab", owner, name };
}

function createExampleCloudFixtureAdapter(rawSnapshot = rawTeamSnapshot) {
  return Object.freeze({
    id: ADAPTER_ID,
    provider: "example-cloud",
    validateScope: exactTeamScope,
    async collect(request) {
      if (request.provider !== "example-cloud" || !exactTeamScope(request.scope)) {
        return { status: "unavailable", reason: "binding-not-applicable" };
      }
      const snapshot = rawSnapshot?.snapshot;
      const team = snapshot?.tenantGroup;
      if (team?.opaqueTeamRef !== request.scope.id || !Array.isArray(team.applications)) {
        return { status: "unavailable", reason: "provider-scope-mismatch" };
      }
      if (snapshot.pagingEnvelope?.moreSegments !== false) {
        return { status: "unavailable", reason: "provider-page-limit-exceeded" };
      }

      const candidates = team.applications.map((application) => {
        const target = application.targets?.[0];
        const repository = repositoryFromCodeLink(application.codeLink);
        return {
          provider: "example-cloud",
          resourceType: "project",
          resourceId: application.opaqueAppRef,
          parentResourceId: team.opaqueTeamRef,
          name: application.display.label,
          ...(target ? {
            environment: target.lane,
            status: statusFromPhase(target.phase),
            urls: target.publicEntrypoints.map((url) => ({ kind: "service", url })),
          } : { urls: [] }),
          ...(repository ? { repository } : {}),
          observedAt: snapshot.captured,
        };
      });

      return {
        status: "success",
        observedAt: snapshot.captured,
        pagesRead: snapshot.pagingEnvelope.segmentsVisited,
        candidates,
      };
    },
  });
}

function sourceCatalog() {
  return {
    hosts: [{ id: "example-cloud", name: "Example Cloud", kind: "cloud", location: "cloud" }],
    hostIds: new Set(["example-cloud"]),
    projects: [{
      file: "client-console.yaml",
      source: "/fictional/catalog/client-console.yaml",
      manifest: {
        version: 1,
        id: "client-console",
        title: "Client Console",
        registration: "overlay",
        description: "Reviewed fictional project.",
        lifecycle: "active",
        kind: "product",
        services: [{
          id: "web",
          name: "Web",
          kind: "website",
          environment: "production",
          host: "example-cloud",
          runtime: "managed",
          mode: "managed",
          visibility: "public",
          url: "https://console.example.test/",
        }],
      },
    }],
  };
}

test("a structurally different team-scoped fixture uses the same generic inventory contract", async () => {
  const adapter = createExampleCloudFixtureAdapter();
  const normalized = await runInventoryAdapter({ binding, adapter, now: NOW });

  assert.equal(inventoryAdapterRegistry.has(ADAPTER_ID), false, "fixture adapter must never enter the production registry");
  assert.equal(normalized.execution.state, "succeeded");
  assert.equal(normalized.source.scope.kind, "team");
  assert.equal(normalized.candidates.length, 2);

  const remoteOnly = normalized.candidates.find((candidate) => candidate.resourceId === "remote-timer");
  assert.equal(remoteOnly.repository, undefined);
  assert.deepEqual(remoteOnly.urls, []);

  const serialized = JSON.stringify(normalized);
  assert.equal(serialized.includes("must-never-leave-the-raw-fixture"), false);
  assert.equal(serialized.includes("must-never-be-provider-truth"), false);
  assert.equal(serialized.includes("catalogClaim"), false);
  assert.equal(serialized.includes("pagingEnvelope"), false);
});

test("the second fixture flows through reconciliation without provider or schema branches", async () => {
  const normalized = await runInventoryAdapter({
    binding,
    adapter: createExampleCloudFixtureAdapter(),
    now: NOW,
  });
  const review = reconcileProviderInventory(sourceCatalog(), normalized, [], {
    projectDirectory: "/fictional/catalog/projects",
  });

  const possible = review.items.find((item) => item.identity.resourceId === "remote-client-console");
  assert.equal(possible.status, "possible-match");
  assert.equal(possible.catalogMatch, null);
  assert.equal(possible.ambiguous, true, "name and domain evidence may identify different catalog levels but never auto-match");
  assert.ok(possible.possibleMatches.some(({ projectId, serviceId }) => (
    projectId === "client-console" && serviceId === "web"
  )));

  const remoteOnly = review.items.find((item) => item.identity.resourceId === "remote-timer");
  assert.equal(remoteOnly.status, "unregistered");
  assert.equal(remoteOnly.candidate.repository, undefined);
  assert.equal(remoteOnly.proposal.writes, false);
  assert.equal(remoteOnly.proposal.manifest.registration, "overlay");
  assert.equal(remoteOnly.proposal.manifest.repository, undefined);
});

test("a fixture provider cannot add raw fields or make catalog decisions", async () => {
  for (const forbiddenField of ["rawSnapshot", "catalogProjectId"]) {
    const candidate = structuredClone(unsafeCandidate);
    for (const field of ["rawSnapshot", "catalogProjectId"]) {
      if (field !== forbiddenField) delete candidate[field];
    }
    const adapter = Object.freeze({
      id: ADAPTER_ID,
      provider: "example-cloud",
      validateScope: exactTeamScope,
      async collect() {
        return { status: "success", observedAt: NOW, pagesRead: 1, candidates: [candidate] };
      },
    });
    const normalized = await runInventoryAdapter({ binding, adapter, now: NOW });
    assert.equal(normalized.execution.state, "failed");
    assert.equal(normalized.execution.reason, "invalid-contract");
    assert.equal(normalized.freshness.state, "unknown");
    assert.deepEqual(normalized.candidates, []);
  }
});
