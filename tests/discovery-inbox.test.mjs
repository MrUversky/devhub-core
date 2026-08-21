import assert from "node:assert/strict";
import test from "node:test";

import { validateProjectDocument } from "../scripts/catalog-validation.mjs";
import { buildDiscoveryInbox, parseDiscoveryReviewDocument } from "../lib/discovery-inbox.mjs";
import { createOpenAIProjectInventoryAdapter } from "../lib/inventory-adapters/providers/openai.mjs";
import { createOpenAISetupConnector } from "../lib/setup-connectors/openai.mjs";
import { vercelSetupConnector, vercelTaskObservationBridge } from "../lib/setup-connectors/vercel.mjs";
import { runSetupSession } from "../lib/setup-session.mjs";
import { parseTaskObservationDocument } from "../lib/task-observations.mjs";

const observedAt = "2026-08-13T12:00:00.000Z";
const freshUntil = "2026-08-13T13:00:00.000Z";
const workspaceId = "11111111-1111-4111-8111-111111111111";

function catalog() {
  return {
    hosts: [
      { id: "railway", name: "Railway", kind: "cloud", location: "cloud" },
      { id: "macbook-pro", name: "MacBook Pro", kind: "mac", location: "local" },
    ],
    hostIds: new Set(["railway", "macbook-pro"]),
    projects: [{ manifest: {
      version: 1,
      id: "pocket-ops",
      title: "Pocket Ops",
      registration: "overlay",
      description: "Reviewed product.",
      lifecycle: "active",
      kind: "product",
      repository: "acme/pocket-ops",
      services: [{ id: "web", name: "Web", kind: "website", environment: "production", host: "railway", runtime: "managed", mode: "managed", visibility: "public", url: "https://pocket.example.test" }],
    } }],
  };
}

function session(results) {
  return {
    version: 1,
    command: "setup-session",
    sessionId: "fixture-session",
    startedAt: observedAt,
    completedAt: observedAt,
    status: results.some((item) => item.state !== "connected") ? "review-required" : "complete",
    readOnly: true,
    persistent: false,
    safety: { catalogWrites: false, providerMutations: false, credentialValuesReturned: false, browserExecution: false, residentProcess: false },
    results,
  };
}

function profilesFor(input) {
  return {
    version: 1,
    profiles: input.results.map((result) => ({
      version: 1,
      id: result.profileId,
      connectorId: result.connectorId,
      authorization: structuredClone(result.reviewedConnection.authorization),
      scope: structuredClone(result.reviewedConnection.scope),
      owner: result.reviewedConnection.owner,
      state: result.reviewedConnection.priorState,
      lastObservedAt: result.reviewedConnection.priorObservedAt,
      freshForSeconds: 3600,
    })),
  };
}

function inbox(sourceCatalog, input, review = null, options = {}) {
  return buildDiscoveryInbox(sourceCatalog, input, profilesFor(input), review, { now: observedAt, ...options });
}

function setupResult(connectorId, observations, overrides = {}) {
  return {
    profileId: `${connectorId}-fixture`,
    connectorId,
    state: "connected",
    observedAt,
    freshUntil,
    reviewedConnection: { scope: connectorId === "railway" ? { kind: "workspace", id: workspaceId } : { kind: "user", login: "acme" }, owner: "Example operator", authorization: connectorId === "railway" ? { method: "secret-reference", credentialRef: { kind: "environment", locator: "RAILWAY_TOKEN" } } : { method: "cli-session" }, priorState: "unknown", priorObservedAt: null },
    evidence: { source: "on-demand-setup-connector", observations },
    message: "Bounded observation.",
    ...overrides,
  };
}

function railwayCandidate(overrides = {}) {
  return {
    provider: "railway",
    resourceType: "project",
    resourceId: "22222222-2222-4222-8222-222222222222",
    parentResourceId: workspaceId,
    name: "Remote Billing",
    urls: [],
    observedAt,
    validUntil: freshUntil,
    freshness: "fresh",
    metadata: { workspaceId, projectId: "22222222-2222-4222-8222-222222222222" },
    ...overrides,
  };
}

function railwayObservation(candidates, overrides = {}) {
  return {
    kind: "normalized-provider-inventory",
    formatVersion: 1,
    source: { adapterId: "railway-inventory-v1", provider: "railway", scope: { kind: "workspace", id: workspaceId } },
    execution: { state: "succeeded", reason: "adapter-observation", pagesRead: 1 },
    freshness: { state: "fresh", observedAt, validUntil: freshUntil, evaluatedAt: observedAt },
    candidates,
    ...overrides,
  };
}

function githubRepository(overrides = {}) {
  return {
    kind: "repository-candidate",
    provider: "github",
    providerId: "101",
    owner: "acme",
    name: "new-tool",
    fullName: "acme/new-tool",
    url: "https://github.com/acme/new-tool",
    visibility: "private",
    archived: false,
    disabled: false,
    access: "write",
    ownership: "unknown",
    identity: { provider: "github", owner: "acme", name: "new-tool" },
    ...overrides,
  };
}

test("fresh candidates are deterministic and unreviewed possible/new items never emit YAML", () => {
  const input = session([
    setupResult("railway", [railwayObservation([railwayCandidate({ repository: { provider: "github", owner: "acme", name: "pocket-ops" } })])]),
    setupResult("github", [githubRepository()]),
  ]);
  const first = inbox(catalog(), input, null, { projectDirectory: "/review/catalog/projects" });
  const second = inbox(catalog(), structuredClone(input), null, { projectDirectory: "/review/catalog/projects" });
  assert.deepEqual(first, second);
  assert.equal(first.items.some((item) => item.state === "possible-match"), true);
  assert.equal(first.items.some((item) => item.state === "new"), true);
  assert.equal(first.proposals.length, 0);
  assert.equal(first.catalogWrites, false);
  assert.equal(first.dashboardMutation, false);
  assert.ok(first.questions.every((question) => ["product-identity", "environment", "owner", "payer", "operating-intent"].includes(question.type)));
  assert.ok(first.questions.every((question) => question.evidence.source && question.evidence.freshness && question.evidence.uncertainty));
});

test("task-scoped plugin inventory is deterministic review-only evidence and never exact catalog truth", () => {
  const taskObservationDocument = parseTaskObservationDocument({
    version: 1,
    selectedConnectorIds: ["vercel"],
    observations: [{
      connectorId: "vercel",
      bridgeId: vercelTaskObservationBridge.id,
      observedAt,
      scope: { kind: "team", label: "Fictional Studio" },
      resources: [
        { kind: "project", label: "Pocket Ops" },
        { kind: "project", label: "Remote Billing" },
      ],
    }],
  }, {
    selectedConnectorIds: ["vercel"],
    connectors: [vercelSetupConnector],
    now: observedAt,
  });
  const first = buildDiscoveryInbox(catalog(), null, null, null, { now: observedAt, taskObservationDocument });
  const second = buildDiscoveryInbox(catalog(), null, null, null, { now: observedAt, taskObservationDocument: structuredClone(taskObservationDocument) });

  assert.equal(first.generatedFrom, "validated-task-observations");
  assert.deepEqual(first, second);
  assert.equal(first.artifactId, second.artifactId);
  assert.deepEqual(first.items.map((item) => item.state).sort(), ["new", "possible-match"]);
  assert.ok(first.items.every((item) => item.state !== "exact-match" && item.exactMatch === null));
  assert.ok(first.items.every((item) => item.provenance.source === "task-scoped-plugin-observation"));
  assert.ok(first.items.every((item) => item.provenance.trust === "untrusted-transient-review-only"));
  assert.ok(first.items.every((item) => item.reviewRequired === true));
  assert.equal(first.proposals.length, 0);
  assert.equal(first.catalogWrites, false);
  assert.equal(first.dashboardMutation, false);
  assert.ok(first.items.every((item) => item.provenance.scope.label === "Fictional Studio"));
  assert.doesNotMatch(JSON.stringify(first), /team_[A-Za-z0-9]+|credential|locator|authorization|https?:\/\//i);

  const possible = first.items.find((item) => item.state === "possible-match");
  const reviewed = buildDiscoveryInbox(catalog(), null, null, {
    version: 1,
    artifactId: first.artifactId,
    decisions: [{
      candidateId: possible.candidateId,
      reviewedAt: observedAt,
      reviewedBy: "Fictional reviewer",
      disposition: "catalog",
      projectId: "pocket-ops",
    }],
  }, { now: observedAt, taskObservationDocument });
  const reviewedPossible = reviewed.items.find((item) => item.candidateId === possible.candidateId);
  assert.equal(reviewedPossible.state, "possible-match", "task-only evidence remains capped below exact even after a human relationship review");
  assert.equal(reviewedPossible.exactMatch, null);
  assert.equal(reviewedPossible.reviewRequired, false);
  assert.deepEqual(reviewedPossible.possibleMatches, [{ projectId: "pocket-ops", serviceId: null, signal: "reviewed-task-observation" }]);
  assert.equal(reviewed.proposals.length, 0);

  const forged = structuredClone(taskObservationDocument);
  forged.observations[0].normalizedInventory.candidates[0].resourceId = "provider-raw-resource-id";
  assert.throws(
    () => buildDiscoveryInbox(catalog(), null, null, null, { now: observedAt, taskObservationDocument: forged }),
    (error) => error.code === "invalid-discovery-input",
  );
  const metadataLeak = structuredClone(taskObservationDocument);
  metadataLeak.observations[0].normalizedInventory.candidates[0].metadata = { projectId: "provider-raw-resource-id" };
  assert.throws(
    () => buildDiscoveryInbox(catalog(), null, null, null, { now: observedAt, taskObservationDocument: metadataLeak }),
    (error) => error.code === "invalid-discovery-input",
  );
});

test("a full OpenAI setup session flows into Discovery Inbox through its canonical inventory contract", async () => {
  const openAIProfile = {
    version: 1,
    id: "openai-fictional-project",
    connectorId: "openai",
    authorization: {
      method: "secret-reference",
      credentialRef: { kind: "keychain", locator: "generic-password:devhub:openai-admin" },
    },
    scope: {
      kind: "project",
      id: "proj_fictional_pocket_ops",
      parent: { kind: "workspace", id: "org_fictional_studio" },
    },
    owner: "Example operator",
    state: "authorization-required",
    lastObservedAt: null,
    freshForSeconds: 3600,
  };
  const calls = [];
  const adapter = createOpenAIProjectInventoryAdapter({ fetch: async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.pathname.endsWith("/api_keys")) return Response.json({
      object: "list",
      data: [{
        object: "organization.project.api_key",
        redacted_value: "sk-fiction...ional",
        name: "Pocket Ops production runtime",
        created_at: 1785542400,
        last_used_at: 1786320000,
        id: "key_fictional_pocket_ops",
        owner: { type: "service_account", service_account: { id: "svc_fictional_runtime" } },
      }],
      last_id: "key_fictional_pocket_ops",
      has_more: false,
    });
    return Response.json({
      object: "organization.project",
      id: openAIProfile.scope.id,
      name: "Pocket Ops",
      created_at: 1785542400,
      archived_at: null,
      status: "active",
      private_note: "provider-raw-field-must-be-discarded",
    });
  } });
  const setupSession = await runSetupSession(openAIProfile, {
    now: observedAt,
    sessionId: "openai-discovery-regression",
    resolveCredential: async () => "fictional-runtime-credential-never-returned",
    connectors: [createOpenAISetupConnector({ adapter })],
  });

  const result = buildDiscoveryInbox(
    catalog(),
    setupSession,
    { version: 1, profiles: [openAIProfile] },
    null,
    { now: observedAt },
  );
  assert.equal(result.items.length, 2);
  const projectItem = result.items.find((item) => item.identity.resourceType === "project");
  const keyItem = result.items.find((item) => item.identity.resourceType === "api-key");
  assert.equal(projectItem.identity.provider, "openai");
  assert.equal(projectItem.identity.resourceId, openAIProfile.scope.id);
  assert.equal(projectItem.state, "possible-match");
  assert.equal(projectItem.exactMatch, null, "a matching product name is supporting evidence, not an automatic match");
  assert.equal(projectItem.reviewRequired, true);
  assert.equal(keyItem.state, "possible-match");
  assert.deepEqual(keyItem.possibleMatches.map((match) => match.projectId), ["pocket-ops"]);
  const keyQuestionGroup = result.questionGroups.find((group) => group.candidates.some((candidate) => candidate.candidateId === keyItem.candidateId));
  assert.equal(keyQuestionGroup.choices.some((choice) => choice.id === "new"), false, "a key can map to a product but cannot create one");
  assert.equal(result.catalogWrites, false);
  assert.equal(result.dashboardMutation, false);
  assert.equal(result.proposals.length, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.pathname, `/v1/organization/projects/${openAIProfile.scope.id}`);
  assert.equal(calls[1].url.pathname, `/v1/organization/projects/${openAIProfile.scope.id}/api_keys`);
  assert.equal(calls[0].init.headers["openai-organization"], openAIProfile.scope.parent.id);
  assert.doesNotMatch(JSON.stringify(setupSession), /fictional-runtime-credential/);
  assert.doesNotMatch(JSON.stringify(setupSession), /provider-raw-field|private_note/);
  assert.doesNotMatch(JSON.stringify(result), /fictional-runtime-credential|generic-password|openai-admin|provider-raw-field|private_note/);

  const observation = setupSession.results[0].evidence.observations[0];
  for (const mutate of [
    (candidate) => { candidate.resourceId = "proj_fictional_other"; },
    (candidate) => { candidate.parentResourceId = "org_fictional_other"; },
    (candidate) => { candidate.metadata.projectId = "proj_fictional_other"; },
    (candidate) => { candidate.metadata.workspaceId = "org_fictional_other"; },
    (candidate) => { candidate.runtime = "managed"; },
    (candidate) => { candidate.repository = { provider: "github", owner: "acme", name: "pocket-ops" }; },
  ]) {
    const forged = structuredClone(setupSession);
    mutate(forged.results[0].evidence.observations[0].candidates[0]);
    assert.throws(
      () => buildDiscoveryInbox(catalog(), forged, { version: 1, profiles: [openAIProfile] }, null, { now: observedAt }),
      /exact reviewed OpenAI organization\/project identity/,
    );
  }
  for (const mutate of [
    (candidate) => { candidate.parentResourceId = "proj_fictional_other"; },
    (candidate) => { candidate.metadata.ownerType = "organization"; },
    (candidate) => { candidate.metadata.redactedValue = "sk-fiction...ional"; },
  ]) {
    const forged = structuredClone(setupSession);
    mutate(forged.results[0].evidence.observations[0].candidates[1]);
    assert.throws(
      () => buildDiscoveryInbox(catalog(), forged, { version: 1, profiles: [openAIProfile] }, null, { now: observedAt }),
      /bounded redacted OpenAI project metadata|valid normalized provider inventory result|unsafe-adapter-result|not allowlisted/,
    );
  }
  assert.equal(observation.source.scope.id, openAIProfile.scope.id);
});

test("repository triage is grouped into one bounded user prompt while preserving per-candidate decisions", () => {
  const repositories = Array.from({ length: 26 }, (_, index) => {
    const suffix = String(index + 1).padStart(2, "0");
    return githubRepository({
      providerId: String(1_000 + index),
      name: `tool-${suffix}`,
      fullName: `acme/tool-${suffix}`,
      url: `https://github.com/acme/tool-${suffix}`,
      identity: { provider: "github", owner: "acme", name: `tool-${suffix}` },
    });
  });
  const input = session([setupResult("github", repositories)]);
  const result = inbox(catalog(), input);
  assert.equal(result.items.length, 26);
  assert.equal(result.questions.length, 104, "machine decisions retain four candidate questions per repository");
  assert.equal(result.questionGroups.length, 1);
  assert.equal(result.questionGroups[0].type, "operating-intent");
  assert.equal(result.questionGroups[0].answerMode, "per-candidate");
  assert.equal(result.questionGroups[0].candidateCount, 26);
  assert.equal(result.questionGroups[0].candidateIds.length, 26);
  assert.ok(result.questionGroups[0].candidateIds.every((candidateId) => candidateId.startsWith("candidate-")));
  assert.equal(result.questionGroups[0].evidence.freshness[0], "fresh");
  assert.equal(result.summary.questions, 1);
  assert.equal(result.summary.candidateQuestions, 104);
  assert.equal(result.summary.unansweredRequiredQuestions, 1);
  assert.equal(result.summary.unansweredRequiredCandidateQuestions, 26);
  assert.ok(result.questions.filter((question) => question.type === "product-identity").every((question) => question.required === false && question.actionable === false));
  assert.ok(result.questions.filter((question) => question.type === "operating-intent").every((question) => question.required === true && question.actionable === true));
});

test("exact GitHub repository and local service identities enrich without ambiguous name matching", () => {
  const github = githubRepository({ name: "pocket-ops", fullName: "acme/pocket-ops", url: "https://github.com/acme/pocket-ops", identity: { provider: "github", owner: "acme", name: "pocket-ops" } });
  const local = { kind: "service-runtime", projectId: "pocket-ops", projectTitle: "Pocket Ops", serviceId: "web", serviceName: "Web", runtime: "managed", mode: "managed", source: "systemd", identifier: "pocket-web.service", state: "running" };
  const input = session([
    setupResult("github", [github]),
    setupResult("local-host", [local], { profileId: "this-computer", reviewedConnection: { scope: { hostId: "macbook-pro" }, owner: "Example operator", authorization: { method: "local-session" }, priorState: "unknown", priorObservedAt: null } }),
  ]);
  const result = inbox(catalog(), input);
  assert.equal(result.items.find((item) => item.identity.provider === "github").state, "exact-match");
  assert.equal(result.items.find((item) => item.identity.provider === "local-host").state, "unknown", "a service reviewed on a different host must not be false-matched");
});

test("a local runtime display name cannot cross-link a GitHub repository without canonical repository evidence", () => {
  const localCatalog = catalog();
  localCatalog.projects[0].manifest.services[0].host = "macbook-pro";
  const github = githubRepository();
  const local = {
    kind: "service-runtime",
    projectId: "pocket-ops",
    projectTitle: "New Tool",
    serviceId: "web",
    serviceName: "Web",
    runtime: "managed",
    mode: "managed",
    source: "systemd",
    identifier: "pocket-web.service",
    state: "running",
  };
  const input = session([
    setupResult("github", [github]),
    setupResult("local-host", [local], {
      profileId: "this-computer",
      reviewedConnection: {
        scope: { hostId: "macbook-pro" },
        owner: "Example operator",
        authorization: { method: "local-session" },
        priorState: "unknown",
        priorObservedAt: null,
      },
    }),
  ]);

  const result = inbox(localCatalog, input);
  const githubItem = result.items.find((item) => item.identity.provider === "github");
  const localItem = result.items.find((item) => item.identity.provider === "local-host");
  assert.equal(localItem.state, "exact-match", "the reviewed project/service/host identity is exact independently of its display text");
  assert.equal(githubItem.state, "new", "artifact-local display text is not repository identity evidence");
  assert.deepEqual(githubItem.possibleMatches, []);
  assert.equal(githubItem.exactMatch, null);
});

test("artifact-bound local Git origin evidence suggests a GitHub candidate for review but never exact-matches it", () => {
  const localCatalog = catalog();
  localCatalog.projects[0].manifest.workspaces = [{ host: "macbook-pro", path: "/reviewed/example" }];
  const github = githubRepository();
  const localRepository = {
    kind: "project-repository",
    projectId: "pocket-ops",
    hostId: "macbook-pro",
    source: "git-origin",
    repository: { provider: "github", owner: "acme", name: "new-tool" },
  };
  const input = session([
    setupResult("github", [github]),
    setupResult("local-host", [localRepository], {
      profileId: "this-computer",
      reviewedConnection: {
        scope: { hostId: "macbook-pro" },
        owner: "Example operator",
        authorization: { method: "local-session" },
        priorState: "unknown",
        priorObservedAt: null,
      },
    }),
  ]);

  const result = inbox(localCatalog, input);
  assert.equal(result.items.length, 1, "repository evidence supports the GitHub candidate instead of inventing a local resource");
  assert.equal(result.items[0].state, "possible-match");
  assert.equal(result.items[0].exactMatch, null);
  assert.deepEqual(result.items[0].possibleMatches, [{
    projectId: "pocket-ops",
    serviceId: null,
    signal: "artifact-reviewed-workspace-repository",
    hostId: "macbook-pro",
  }]);
  assert.equal(result.items[0].reviewRequired, true);
  assert.equal(result.catalogWrites, false);
  assert.equal(result.dashboardMutation, false);
  assert.equal(result.proposals.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /reviewed\/example|git@github\.com/);
});

test("duplicate reviewed local project targets stay ambiguous and forged host or raw remote evidence fails closed", () => {
  const duplicated = catalog();
  duplicated.projects[0].manifest.workspaces = [{ host: "macbook-pro", path: "/reviewed/one" }];
  duplicated.projects.push({ manifest: {
    ...structuredClone(duplicated.projects[0].manifest),
    id: "pocket-ops-copy",
    title: "Pocket copy",
    workspaces: [{ host: "macbook-pro", path: "/reviewed/two" }],
  } });
  const localEvidence = (projectId) => ({
    kind: "project-repository",
    projectId,
    hostId: "macbook-pro",
    source: "git-origin",
    repository: { provider: "github", owner: "acme", name: "new-tool" },
  });
  const localSetup = (observations) => setupResult("local-host", observations, {
    profileId: "this-computer",
    reviewedConnection: {
      scope: { hostId: "macbook-pro" },
      owner: "Example operator",
      authorization: { method: "local-session" },
      priorState: "unknown",
      priorObservedAt: null,
    },
  });
  const input = session([
    setupResult("github", [githubRepository()]),
    localSetup([localEvidence("pocket-ops"), localEvidence("pocket-ops-copy")]),
  ]);
  const result = inbox(duplicated, input);
  assert.equal(result.items[0].state, "possible-match");
  assert.equal(result.items[0].exactMatch, null);
  assert.equal(result.items[0].possibleMatches.length, 2);
  assert.equal(result.items[0].provenance.uncertainty, "ambiguous");

  const wrongHost = session([setupResult("github", [githubRepository()]), localSetup([{ ...localEvidence("pocket-ops"), hostId: "other-host" }])]);
  assert.throws(() => inbox(duplicated, wrongHost), (error) => error.code === "connection-profile-drift");
  const rawRemote = session([setupResult("github", [githubRepository()]), localSetup([{ ...localEvidence("pocket-ops"), remoteUrl: "https://embedded:credential@github.com/acme/new-tool.git" }])]);
  assert.throws(() => inbox(duplicated, rawRemote), (error) => new Set(["unsafe-setup-state", "invalid-setup-session"]).has(error.code));
});

test("conflicting exact catalog and local repository targets surface deterministic ambiguity while same-project corroboration stays exact", () => {
  const conflictingCatalog = catalog();
  conflictingCatalog.projects[0].manifest.workspaces = [{ host: "macbook-pro", path: "/reviewed/catalog-target" }];
  conflictingCatalog.projects.push({ manifest: {
    ...structuredClone(conflictingCatalog.projects[0].manifest),
    id: "local-target",
    title: "Local target",
    repository: "acme/different-repository",
    workspaces: [{ host: "macbook-pro", path: "/reviewed/local-target" }],
  } });
  const github = githubRepository({
    name: "pocket-ops",
    fullName: "acme/pocket-ops",
    url: "https://github.com/acme/pocket-ops",
    identity: { provider: "github", owner: "acme", name: "pocket-ops" },
  });
  const localSetup = (projectId) => setupResult("local-host", [{
    kind: "project-repository",
    projectId,
    hostId: "macbook-pro",
    source: "git-origin",
    repository: { provider: "github", owner: "acme", name: "pocket-ops" },
  }], {
    profileId: "this-computer",
    reviewedConnection: {
      scope: { hostId: "macbook-pro" },
      owner: "Example operator",
      authorization: { method: "local-session" },
      priorState: "unknown",
      priorObservedAt: null,
    },
  });

  const conflictingInput = session([setupResult("github", [github]), localSetup("local-target")]);
  const first = inbox(conflictingCatalog, conflictingInput);
  const second = inbox(conflictingCatalog, structuredClone(conflictingInput));
  assert.equal(first.items[0].state, "possible-match");
  assert.equal(first.items[0].exactMatch, null);
  assert.equal(first.items[0].provenance.uncertainty, "ambiguous");
  assert.deepEqual(first.items[0].possibleMatches.map((match) => match.projectId), ["local-target", "pocket-ops"]);
  assert.equal(first.artifactId, second.artifactId);
  assert.deepEqual(first, second);
  const catalogOnly = inbox(conflictingCatalog, session([setupResult("github", [github])]));
  assert.equal(catalogOnly.items[0].state, "exact-match");
  assert.notEqual(first.artifactId, catalogOnly.artifactId, "the artifact binding must include the conflicting local evidence");
  assert.doesNotMatch(JSON.stringify(first), /reviewed\/catalog-target|reviewed\/local-target|git@github\.com/);

  const corroborated = inbox(conflictingCatalog, session([setupResult("github", [github]), localSetup("pocket-ops")]));
  assert.equal(corroborated.items[0].state, "exact-match");
  assert.equal(corroborated.items[0].exactMatch.projectId, "pocket-ops");
});

test("an exact local service identity remains exact when runtime status is unknown", () => {
  const localCatalog = catalog();
  localCatalog.projects[0].manifest.services[0].host = "macbook-pro";
  const local = { kind: "service-runtime-unknown", projectId: "pocket-ops", projectTitle: "Pocket Ops", serviceId: "web", serviceName: "Web", runtime: "managed", mode: "managed", reason: "unsupported-runtime", message: "No bounded runtime status adapter." };
  const input = session([setupResult("local-host", [local], { profileId: "this-computer", reviewedConnection: { scope: { hostId: "macbook-pro" }, owner: "Example operator", authorization: { method: "local-session" }, priorState: "unknown", priorObservedAt: null } })]);
  const result = inbox(localCatalog, input);
  assert.equal(result.items[0].state, "exact-match");
  assert.equal(result.items[0].provenance.uncertainty, "unsupported-runtime");
});

test("an exact local service with an unknown runtime state keeps a bounded uncertainty reason", () => {
  const local = { kind: "service-runtime", projectId: "pocket-ops", projectTitle: "Pocket Ops", serviceId: "web", serviceName: "Web", runtime: "managed", mode: "managed", source: "npm", identifier: "start", state: "unknown" };
  const input = session([
    setupResult("local-host", [local], { profileId: "this-computer", reviewedConnection: { scope: { hostId: "railway" }, owner: "Example operator", authorization: { method: "local-session" }, priorState: "unknown", priorObservedAt: null } }),
  ]);
  const result = inbox(catalog(), input);
  assert.equal(result.items[0].state, "exact-match");
  assert.equal(result.items[0].provenance.uncertainty, "runtime-state-unknown");
});

test("reviewed Railway decisions map to exact-match and GitHub duplicate repository evidence stays ambiguous", () => {
  const railwayInput = session([setupResult("railway", [railwayObservation([railwayCandidate()])])]);
  const initial = inbox(catalog(), railwayInput);
  const reviewed = inbox(catalog(), railwayInput, {
    version: 1,
    artifactId: initial.artifactId,
    decisions: [{ candidateId: initial.items[0].candidateId, reviewedAt: observedAt, reviewedBy: "Example reviewer", disposition: "catalog", projectId: "pocket-ops", reason: "Reviewed provider project identity belongs to Pocket Ops.", answers: { productIdentity: "Pocket Ops" } }],
  });
  assert.equal(reviewed.items[0].state, "exact-match");
  assert.equal(reviewed.items[0].exactMatch.projectId, "pocket-ops");

  const duplicated = catalog();
  duplicated.projects.push({ manifest: { ...structuredClone(duplicated.projects[0].manifest), id: "pocket-ops-copy", title: "Pocket copy" } });
  const githubInput = session([setupResult("github", [githubRepository({ name: "pocket-ops", fullName: "acme/pocket-ops", url: "https://github.com/acme/pocket-ops", identity: { provider: "github", owner: "acme", name: "pocket-ops" } })])]);
  const ambiguous = inbox(duplicated, githubInput);
  assert.equal(ambiguous.items[0].state, "possible-match");
  assert.equal(ambiguous.items[0].exactMatch, null);
});

test("a bound explicit new decision unlocks only fresh schema-valid YAML and never writes", () => {
  const input = session([setupResult("railway", [railwayObservation([railwayCandidate()])])]);
  const preview = inbox(catalog(), input, null, { projectDirectory: "/review/catalog/projects" });
  const candidateId = preview.items[0].candidateId;
  const reviewed = inbox(catalog(), input, {
    version: 1,
    artifactId: preview.artifactId,
    decisions: [{ candidateId, reviewedAt: observedAt, reviewedBy: "Example reviewer", disposition: "new", answers: { productIdentity: "Remote Billing", owner: "Business team", payer: "Business account", operatingIntent: "discovery" } }],
  }, { projectDirectory: "/review/catalog/projects", now: observedAt });
  assert.equal(reviewed.proposals.length, 1);
  assert.equal(reviewed.proposals[0].writes, false);
  assert.equal(reviewed.proposals[0].transport, "stdout");
  assert.equal(reviewed.proposals[0].reviewDestination, "/review/catalog/projects/remote-billing.yaml");
  assert.doesNotThrow(() => validateProjectDocument(reviewed.proposals[0].manifest, { hostIds: catalog().hostIds, expectedId: "remote-billing" }));
  assert.equal(reviewed.proposals[0].manifest.registration, "overlay");
  assert.deepEqual(reviewed.proposals[0].manifest.services, []);
});

test("review time and required questions gate new proposals", () => {
  const input = session([setupResult("github", [githubRepository()])]);
  const preview = inbox(catalog(), input);
  const candidateId = preview.items[0].candidateId;
  assert.throws(() => inbox(catalog(), input, { version: 1, artifactId: preview.artifactId, decisions: [{ candidateId, reviewedAt: "2026-08-13T11:59:59.000Z", reviewedBy: "Example reviewer", disposition: "new", answers: { productIdentity: "New Tool", operatingIntent: "discovery" } }] }), (error) => error.code === "invalid-discovery-review-time");
  assert.throws(() => inbox(catalog(), input, { version: 1, artifactId: preview.artifactId, decisions: [{ candidateId, reviewedAt: observedAt, reviewedBy: "Example reviewer", disposition: "new", answers: { productIdentity: "New Tool" } }] }), (error) => error.code === "incomplete-discovery-review");
});

test("external and ignored states require an explicit artifact-bound reviewed reason", () => {
  const input = session([setupResult("github", [githubRepository()])]);
  const preview = inbox(catalog(), input);
  const candidateId = preview.items[0].candidateId;
  for (const [disposition, expected] of [["external", "reviewed-external"], ["ignore", "ignored"]]) {
    const reviewed = inbox(catalog(), input, { version: 1, artifactId: preview.artifactId, decisions: [{ candidateId, reviewedAt: observedAt, reviewedBy: "Example reviewer", disposition, reason: "Client-owned experiment intentionally not tracked here." }] });
    assert.equal(reviewed.items[0].state, expected);
    assert.equal(reviewed.items[0].reviewedDecision.artifactId, preview.artifactId);
    assert.equal(reviewed.items[0].proposal, null);
  }
  assert.throws(() => parseDiscoveryReviewDocument({ version: 1, artifactId: preview.artifactId, decisions: [{ candidateId, reviewedAt: observedAt, reviewedBy: "Example reviewer", disposition: "ignore" }] }), /reason/i);
  assert.throws(() => inbox(catalog(), input, { version: 1, artifactId: `sha256:${"0".repeat(64)}`, decisions: [] }), (error) => error.code === "stale-discovery-review");
});

test("stale, ambiguous and unknown evidence cannot be unlocked or treated as deletion", () => {
  const staleObservation = railwayObservation([railwayCandidate({ validUntil: observedAt, freshness: "stale" })], { freshness: { state: "stale", observedAt: "2026-08-13T11:00:00.000Z", validUntil: observedAt, evaluatedAt: freshUntil } });
  const input = session([setupResult("railway", [staleObservation], { state: "stale", observedAt: "2026-08-13T11:00:00.000Z", freshUntil: observedAt })]);
  const preview = inbox(catalog(), input, null, { now: freshUntil });
  assert.equal(preview.items[0].state, "unknown");
  assert.doesNotMatch(JSON.stringify(preview), /orphaned|safe to delete/i);
  assert.throws(() => inbox(catalog(), input, { version: 1, artifactId: preview.artifactId, decisions: [{ candidateId: preview.items[0].candidateId, reviewedAt: freshUntil, reviewedBy: "Example reviewer", disposition: "new", answers: { productIdentity: "Remote Billing", operatingIntent: "discovery" } }] }, { now: freshUntil }), (error) => error.code === "unsafe-discovery-review");
});

test("adversarial observations and decisions fail closed without secret or replay leakage", () => {
  for (const bad of [
    session([setupResult("github", [{ ...githubRepository(), apiToken: ["github", "pat", "12345678901234567890"].join("_") }])]),
    session([setupResult("github", [githubRepository({ url: "https://github.com/acme/new-tool?token=secret" })])]),
    session([setupResult("github", [{ kind: "provider-raw-payload", data: "opaque" }])]),
  ]) assert.throws(() => inbox(catalog(), bad));

  const input = session([setupResult("github", [githubRepository()])]);
  const preview = inbox(catalog(), input);
  assert.throws(() => inbox(catalog(), input, { version: 1, artifactId: preview.artifactId, decisions: [{ candidateId: "candidate-00000000000000000000", reviewedAt: observedAt, reviewedBy: "Example reviewer", disposition: "ignore", reason: "Not ours." }] }), (error) => error.code === "stale-discovery-review");
  assert.equal(JSON.stringify(preview).includes("fixture-session"), false, "the inbox must not embed the raw session identity");
});
