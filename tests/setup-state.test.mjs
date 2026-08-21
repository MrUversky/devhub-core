import assert from "node:assert/strict";
import test from "node:test";

import {
  SetupStateError,
  compareSetupRefresh,
  createSetupRefreshPlan,
  createUnavailableAcceptance,
  evaluateSetupState,
  proposeConnectionDisconnect,
  validateSetupSessionArtifact,
} from "../lib/setup-state.mjs";

const NOW = "2026-08-13T12:00:00.000Z";
const FRESH_UNTIL = "2026-08-13T13:00:00.000Z";

function profile(changes = {}) {
  return {
    version: 1,
    id: "github-example",
    connectorId: "github",
    authorization: { method: "cli-session" },
    scope: { kind: "user", login: "example-org" },
    owner: "Example operator",
    state: "authorization-required",
    lastObservedAt: null,
    freshForSeconds: 3600,
    ...changes,
  };
}

function railwayProfile(changes = {}) {
  return profile({
    id: "railway-example",
    connectorId: "railway",
    authorization: { method: "secret-reference", credentialRef: { kind: "environment", locator: "RAILWAY_API_TOKEN" } },
    scope: { kind: "workspace", id: "11111111-1111-4111-8111-111111111111" },
    ...changes,
  });
}

function observation(changes = {}) {
  const value = {
    kind: "repository-candidate",
    provider: "github",
    providerId: "101",
    owner: "example-org",
    name: "example-app",
    fullName: "example-org/example-app",
    url: "https://github.com/example-org/example-app",
    visibility: "private",
    archived: false,
    disabled: false,
    access: "write",
    ownership: "unknown",
    ...changes,
  };
  return { ...value, identity: changes.identity ?? { provider: value.provider, owner: value.owner, name: value.name } };
}

function result(reviewedProfile, changes = {}) {
  return {
    profileId: reviewedProfile.id,
    connectorId: reviewedProfile.connectorId,
    state: "connected",
    observedAt: NOW,
    freshUntil: FRESH_UNTIL,
    reviewedConnection: {
      scope: structuredClone(reviewedProfile.scope),
      owner: reviewedProfile.owner,
      authorization: structuredClone(reviewedProfile.authorization),
      priorState: reviewedProfile.state,
      priorObservedAt: reviewedProfile.lastObservedAt,
    },
    evidence: { source: "on-demand-setup-connector", observations: [observation()] },
    message: "One reviewed observation.",
    ...changes,
  };
}

function session(reviewedProfiles, resultChanges = [], changes = {}) {
  const profiles = Array.isArray(reviewedProfiles) ? reviewedProfiles : [reviewedProfiles];
  return {
    version: 1,
    command: "setup-session",
    sessionId: changes.sessionId ?? "setup-session-one",
    startedAt: NOW,
    completedAt: NOW,
    status: changes.status ?? "complete",
    readOnly: true,
    persistent: false,
    safety: { catalogWrites: false, providerMutations: false, credentialValuesReturned: false, browserExecution: false, residentProcess: false },
    results: profiles.map((item, index) => result(item, resultChanges[index] ?? {})),
  };
}

test("catalog presence and a forged complete label never establish setup completion", () => {
  const notStarted = evaluateSetupState({ version: 1, profiles: [] }, null, {
    now: NOW,
    catalog: { projects: [{ id: "existing-project" }] },
  });
  assert.equal(notStarted.status, "not-started");
  assert.equal(notStarted.setupComplete, false);
  assert.equal(notStarted.safety.catalogPresenceUsed, false);

  const reviewed = profile();
  const forged = session(reviewed, [], { status: "complete" });
  forged.results = [];
  const state = evaluateSetupState(reviewed, forged, { now: NOW });
  assert.equal(state.status, "review-required");
  assert.equal(state.setupComplete, false);
});

test("one fresh connected observation creates verified completion and connection metadata", () => {
  const reviewed = profile();
  const state = evaluateSetupState(reviewed, session(reviewed), { now: NOW });
  assert.equal(state.status, "complete");
  assert.equal(state.setupComplete, true);
  assert.equal(state.connections[0].connectorId, "github");
  assert.deepEqual(state.connections[0].reviewedScope, reviewed.scope);
  assert.equal(state.connections[0].owner, "Example operator");
  assert.deepEqual(state.connections[0].authorization, reviewed.authorization);
  assert.equal(state.connections[0].lastSync, NOW);
  assert.equal(state.connections[0].freshness, "fresh");
  assert.deepEqual(state.connections[0].resultSummary, { observations: 1, kinds: { "repository-candidate": 1 } });
  assert.deepEqual(state.nextActions, ["refresh-my-devhub", "connect-another-source"]);
});

test("unavailable and missing connector results need an exact reviewed acceptance", () => {
  const reviewed = profile();
  const unavailableSession = session(reviewed, [{
    state: "unavailable",
    observedAt: null,
    freshUntil: null,
    evidence: { source: "reviewed-connection-profile", observations: [] },
    message: "No on-demand setup connector is available in this session.",
  }]);
  assert.equal(evaluateSetupState(reviewed, unavailableSession, { now: NOW }).setupComplete, false);

  const acceptance = createUnavailableAcceptance(reviewed, unavailableSession, {
    reviewedAt: "2026-08-13T12:05:00.000Z",
    reviewedBy: "Example operator",
    reason: "This account is intentionally documented while access is restored.",
  });
  const accepted = evaluateSetupState(reviewed, unavailableSession, {
    now: "2026-08-13T12:06:00.000Z",
    availabilityReview: { version: 1, decisions: [acceptance] },
  });
  assert.equal(accepted.setupComplete, true);
  assert.equal(accepted.connections[0].acceptedUnavailable.disposition, "accepted-unavailable");

  assert.throws(() => evaluateSetupState(reviewed, unavailableSession, {
    now: NOW,
    availabilityReview: { version: 1, decisions: [{ ...acceptance, sessionId: "forged-session" }] },
  }), (error) => error instanceof SetupStateError && error.code === "invalid-availability-review");
  assert.throws(() => evaluateSetupState(profile({ owner: "Changed owner" }), unavailableSession, {
    now: NOW,
    availabilityReview: { version: 1, decisions: [acceptance] },
  }), /changed the reviewed scope, owner or authorization reference/i);
});

test("stale connected evidence and unresolved Discovery Inbox questions keep setup in review", () => {
  const reviewed = profile();
  const staleState = evaluateSetupState(reviewed, session(reviewed), { now: "2026-08-13T13:00:00.000Z" });
  assert.equal(staleState.setupComplete, false);
  assert.equal(staleState.connections[0].state, "stale");
  assert.equal(staleState.connections[0].freshness, "stale");

  const withInbox = evaluateSetupState(reviewed, session(reviewed), {
    now: NOW,
    discoveryInbox: {
      version: 1,
      command: "discovery-inbox",
      summary: { unansweredRequiredQuestions: 1, unansweredRequiredCandidateQuestions: 1, proposals: 0 },
      items: [{ state: "possible-match", reviewRequired: true }, { state: "reviewed-external", reviewRequired: false }],
      questionGroups: [{ required: true }],
    },
  });
  assert.equal(withInbox.discovery.state, "review-required");
  assert.equal(withInbox.discovery.reviewRequired, 1);
  assert.equal(withInbox.setupComplete, false);
});

test("refresh plan preserves exact reviewed scopes and credential-reference metadata", () => {
  const reviewed = railwayProfile();
  const plan = createSetupRefreshPlan(reviewed);
  assert.equal(plan.readOnly, true);
  assert.deepEqual(plan.connections[0].scope, reviewed.scope);
  assert.deepEqual(plan.connections[0].authorization, reviewed.authorization);
  assert.equal(plan.safety.scopesBroadened, false);
  assert.equal(plan.safety.credentialReferencesChanged, false);
});

test("refresh reports only new, changed, stale and unclear identities without inferring deletion", () => {
  const reviewed = profile();
  const previous = session(reviewed, [{ evidence: { source: "on-demand-setup-connector", observations: [
    observation(),
    observation({ providerId: "102", name: "removed-from-response", fullName: "example-org/removed-from-response", url: "https://github.com/example-org/removed-from-response" }),
  ] } }], { sessionId: "previous-session" });
  const current = session(reviewed, [{ evidence: { source: "on-demand-setup-connector", observations: [
    observation({ access: "admin" }),
    observation({ providerId: "103", name: "new-app", fullName: "example-org/new-app", url: "https://github.com/example-org/new-app" }),
  ] } }], { sessionId: "current-session" });
  const refresh = compareSetupRefresh(reviewed, previous, current, { now: NOW });
  assert.deepEqual(refresh.summary, { new: 1, changed: 1, stale: 0, unclear: 1, unchanged: 0 });
  assert.deepEqual([...new Set(refresh.items.map((item) => item.kind))].sort(), ["changed", "new", "unclear"]);
  assert.match(refresh.items.find((item) => item.kind === "unclear").reason, /does not prove deletion/i);
  assert.equal(refresh.safety.deletionsInferred, false);
});

test("unavailable refresh stays unclear and changed scope or credential reference fails closed", () => {
  const reviewed = railwayProfile();
  const previous = session(reviewed, [{ evidence: { source: "on-demand-setup-connector", observations: [] } }], { sessionId: "previous-session" });
  const unavailable = session(reviewed, [{
    state: "unavailable",
    observedAt: null,
    freshUntil: null,
    evidence: { source: "reviewed-connection-profile", observations: [] },
  }], { sessionId: "current-session" });
  const refresh = compareSetupRefresh(reviewed, previous, unavailable, { now: NOW });
  assert.deepEqual(refresh.summary, { new: 0, changed: 0, stale: 0, unclear: 1, unchanged: 0 });

  const changedScope = structuredClone(unavailable);
  changedScope.results[0].reviewedConnection.scope = { kind: "workspace", id: "22222222-2222-4222-8222-222222222222" };
  assert.throws(() => compareSetupRefresh(reviewed, previous, changedScope, { now: NOW }), /changed the reviewed scope/i);
  const changedReference = structuredClone(unavailable);
  changedReference.results[0].reviewedConnection.authorization.credentialRef.locator = "OTHER_TOKEN";
  assert.throws(() => compareSetupRefresh(reviewed, previous, changedReference, { now: NOW }), /authorization reference/i);
});

test("secret-bearing refresh evidence fails closed", () => {
  const reviewed = profile();
  const leaked = session(reviewed, [{
    evidence: { source: "on-demand-setup-connector", observations: [{ kind: "repository-candidate", provider: "github", providerId: "101", note: "Bearer abcdefghijklmnop" }] },
  }]);
  assert.throws(() => evaluateSetupState(reviewed, leaked, { now: NOW }), (error) => error instanceof SetupStateError && error.code === "unsafe-setup-state");
});

test("canonical artifact validation rejects extras, forged sources, arbitrary freshness and future observations", () => {
  const reviewed = profile();
  const valid = session(reviewed);
  const normalized = validateSetupSessionArtifact(valid, reviewed, { now: NOW });
  assert.equal(normalized.completedAt, NOW);
  assert.equal(Object.isFrozen(normalized), true);

  const extra = structuredClone(valid);
  extra.results[0].evidence.extra = true;
  assert.throws(() => validateSetupSessionArtifact(extra, reviewed, { now: NOW }), /not supported/i);

  const forgedSource = structuredClone(valid);
  forgedSource.results[0].evidence.source = "browser-input";
  assert.throws(() => validateSetupSessionArtifact(forgedSource, reviewed, { now: NOW }), /not trusted/i);

  const arbitraryFreshness = structuredClone(valid);
  arbitraryFreshness.results[0].freshUntil = "2026-08-13T14:00:00.000Z";
  assert.throws(() => validateSetupSessionArtifact(arbitraryFreshness, reviewed, { now: NOW }), /reviewed freshness lifetime/i);

  const futureObservation = structuredClone(valid);
  futureObservation.results[0].observedAt = "2026-08-13T12:00:01.000Z";
  futureObservation.results[0].freshUntil = "2026-08-13T13:00:01.000Z";
  assert.throws(() => validateSetupSessionArtifact(futureObservation, reviewed, { now: "2026-08-13T12:00:01.000Z" }), /session.completedAt/i);
});

test("canonical artifact validation bounds the entire input document", () => {
  const reviewed = profile();
  const oversized = session(reviewed);
  oversized.results[0].message = "x".repeat(1024 * 1024);
  assert.throws(() => validateSetupSessionArtifact(oversized, reviewed, { now: NOW }), /input limit/i);
});

test("normalized provider inventory must match the profile connector and exact scope", () => {
  const reviewed = railwayProfile();
  const inventory = {
    kind: "normalized-provider-inventory",
    formatVersion: 1,
    source: { adapterId: "railway-inventory-v1", provider: "railway", scope: structuredClone(reviewed.scope) },
    execution: { state: "succeeded", reason: "adapter-observation", pagesRead: 1 },
    freshness: { state: "fresh", observedAt: NOW, validUntil: FRESH_UNTIL, evaluatedAt: NOW },
    candidates: [],
  };
  const artifact = session(reviewed, [{ evidence: { source: "on-demand-setup-connector", observations: [inventory] } }]);
  assert.equal(validateSetupSessionArtifact(artifact, reviewed, { now: NOW }).results[0].observations[0].source.provider, "railway");

  const forged = structuredClone(artifact);
  forged.results[0].evidence.observations[0].source.scope.id = "22222222-2222-4222-8222-222222222222";
  assert.throws(() => validateSetupSessionArtifact(forged, reviewed, { now: NOW }), /exact scope/i);
});

test("unavailable acceptance provenance is temporally bound to session completion and evaluation", () => {
  const reviewed = profile();
  const unavailableSession = session(reviewed, [{ state: "unavailable", observedAt: null, freshUntil: null, evidence: { source: "reviewed-connection-profile", observations: [] } }]);
  assert.throws(() => createUnavailableAcceptance(reviewed, unavailableSession, {
    reviewedAt: "2026-08-13T11:59:59.000Z",
    reviewedBy: "Example operator",
    reason: "Reviewed too early.",
  }), /future|ordered|completion/i);

  const decision = createUnavailableAcceptance(reviewed, unavailableSession, {
    reviewedAt: "2026-08-13T12:01:00.000Z",
    reviewedBy: "Example operator",
    reason: "Temporarily accepted while access is restored.",
  });
  assert.throws(() => evaluateSetupState(reviewed, unavailableSession, {
    now: "2026-08-13T12:00:30.000Z",
    availabilityReview: { version: 1, decisions: [decision] },
  }), /evaluation time/i);
});

test("disconnect is a reviewed profile-only proposal and cannot delete catalog or provider resources", () => {
  const proposal = proposeConnectionDisconnect(profile(), {
    action: "remove",
    requestedAt: NOW,
    requestedBy: "Example operator",
    reason: "This provider account is no longer part of the reviewed setup.",
  });
  assert.equal(proposal.apply, false);
  assert.deepEqual(proposal.profileChange.action, "remove");
  assert.deepEqual(proposal.preserved, { catalogRecords: true, providerResources: true, evidenceHistory: true });
  assert.deepEqual(proposal.safety, { profileWrites: false, catalogWrites: false, providerMutations: false, resourceDeletions: false });
});
