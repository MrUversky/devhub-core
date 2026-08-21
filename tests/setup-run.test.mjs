import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { createConnectionSnapshot } from "../lib/connection-snapshot.mjs";
import { railwaySetupConnector, railwayTaskObservationBridge } from "../lib/setup-connectors/railway.mjs";
import { vercelSetupConnector, vercelTaskObservationBridge } from "../lib/setup-connectors/vercel.mjs";
import { createSetupRunPresentationPreflight } from "../lib/setup-run-presentation.mjs";
import { createSetupRunPreflight, formatSetupReview, runSetupReview } from "../lib/setup-run.mjs";
import { runSetupRun as runSetupRunCommand } from "../scripts/setup-run.mjs";

const NOW = "2026-08-13T16:00:00.000Z";
const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "scripts/devhub.mjs");

function profile(changes = {}) {
  return {
    version: 1,
    id: "github-reviewed",
    connectorId: "github",
    authorization: { method: "cli-session" },
    scope: { kind: "user", login: "fictional-builder" },
    owner: "Fictional builder",
    state: "connected",
    lastObservedAt: "2026-08-13T15:30:00.000Z",
    freshForSeconds: 3600,
    ...changes,
  };
}

test("presentation preflight derives readiness only from a redacted connection snapshot", () => {
  const connections = createConnectionSnapshot({ version: 1, profiles: [profile()] });
  const result = createSetupRunPresentationPreflight({
    selectedConnectorIds: ["vercel", "github", "openai"],
    connections,
    now: NOW,
    planning: { connectors: [{ id: "openai", detection: { state: "detected" } }] },
  });

  assert.deepEqual(result.selected.map((source) => [source.connectorId, source.status]), [
    ["github", "ready"],
    ["vercel", "needs-scope"],
    ["openai", "needs-scope"],
  ]);
  assert.equal(result.selected[2].detection.state, "detected");
  assert.equal(result.selected[2].status, "needs-scope", "detection must never promote readiness");
  assert.deepEqual(result.summary, { selected: 3, ready: 1, needsScope: 2, reconnect: 0, retry: 0, reviewedBindingRequired: 0, needsAttention: 2 });
  assert.doesNotMatch(JSON.stringify(result), /fictional-builder|Fictional builder|"authorization"|"credentialRef"|"scope"/);
});

test("presentation preflight keeps stale, authorization and unknown states actionable", () => {
  const document = {
    version: 1,
    profiles: [
      profile({ lastObservedAt: "2026-08-13T13:00:00.000Z" }),
      profile({ id: "railway-reviewed", connectorId: "railway", authorization: { method: "secret-reference", credentialRef: { kind: "environment", locator: "FICTIONAL_RAILWAY_TOKEN" } }, scope: { kind: "workspace", id: "fictional-workspace" }, state: "authorization-required", lastObservedAt: null }),
      profile({ id: "openai-reviewed", connectorId: "openai", authorization: { method: "secret-reference", credentialRef: { kind: "environment", locator: "FICTIONAL_OPENAI_KEY" } }, scope: { organizationId: "org_fictional", projectId: "proj_fictional" }, state: "unknown", lastObservedAt: null }),
    ],
  };
  const result = createSetupRunPreflight({ selectedConnectorIds: ["github", "railway", "openai"], profileDocument: document, now: NOW });
  assert.deepEqual(result.presentation.selected.map((source) => [source.connectorId, source.status]), [
    ["github", "reconnect"],
    ["railway", "reconnect"],
    ["openai", "retry"],
  ]);
  assert.deepEqual(result.runnableProfiles.map((item) => item.connectorId), ["github", "railway", "openai"]);
  assert.doesNotMatch(JSON.stringify(result.presentation), /fictional-workspace|org_fictional|proj_fictional|FICTIONAL_/);
});

test("public empty snapshot exposes support without private connection readiness", () => {
  const result = createSetupRunPresentationPreflight({
    selectedConnectorIds: ["github", "vercel"],
    connections: createConnectionSnapshot(),
    now: NOW,
  });
  assert.deepEqual(result.selected.map((source) => [source.connectorId, source.status, source.connection.profileCount]), [
    ["github", "needs-scope", 0],
    ["vercel", "needs-scope", 0],
  ]);
  assert.equal(result.summary.ready, 0);
  assert.equal(result.summary.needsAttention, 2);
});

test("preflight rejects duplicate, planned and unknown sources", () => {
  const connections = createConnectionSnapshot();
  assert.throws(() => createSetupRunPresentationPreflight({ selectedConnectorIds: [], connections, now: NOW }), /at least one/);
  assert.throws(() => createSetupRunPresentationPreflight({ selectedConnectorIds: ["github", "github"], connections, now: NOW }), /unique/);
  assert.throws(() => createSetupRunPresentationPreflight({ selectedConnectorIds: ["cloudflare"], connections, now: NOW }), /available canonical/);
  assert.throws(() => createSetupRunPresentationPreflight({ selectedConnectorIds: ["fictional"], connections, now: NOW }), /available canonical/);
});

test("browser presentation module has no Node, provider-adapter or server orchestration imports", async () => {
  const source = await readFile(path.join(root, "lib/setup-run-presentation.mjs"), "utf8");
  const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
  assert.deepEqual(imports, ["./connection-status.mjs", "./connectors.mjs"]);
  assert.doesNotMatch(source, /node:|connector-contracts|adapter|setup-session|discovery-inbox|child_process|node:fs/);
});

function sourceCatalog() {
  return {
    hosts: [{ id: "fictional-mac", name: "Fictional Mac", kind: "mac", location: "local" }],
    hostIds: new Set(["fictional-mac"]),
    projects: [{ manifest: {
      version: 1,
      id: "existing-product",
      title: "Existing Product",
      registration: "overlay",
      description: "Fictional reviewed product.",
      lifecycle: "active",
      kind: "product",
      repository: "fictional-org/existing-product",
      services: [],
    } }],
  };
}

function githubObservation() {
  return {
    kind: "repository-candidate",
    provider: "github",
    providerId: "101",
    owner: "fictional-org",
    name: "new-tool",
    fullName: "fictional-org/new-tool",
    url: "https://github.com/fictional-org/new-tool",
    visibility: "private",
    archived: false,
    disabled: false,
    access: "write",
    ownership: "unknown",
    identity: { provider: "github", owner: "fictional-org", name: "new-tool" },
  };
}

function taskObservationInput(selectedConnectorIds = ["github", "vercel", "railway"]) {
  return {
    version: 1,
    selectedConnectorIds,
    observations: [
      {
        connectorId: "vercel",
        bridgeId: vercelTaskObservationBridge.id,
        observedAt: NOW,
        scope: { kind: "team", label: "Fictional Vercel Team" },
        resources: [{ kind: "project", label: "Existing Product" }],
      },
      {
        connectorId: "railway",
        bridgeId: railwayTaskObservationBridge.id,
        observedAt: NOW,
        scope: { kind: "workspace", label: "Fictional Railway Workspace" },
        resources: [{ kind: "project", label: "Remote Billing" }],
      },
    ],
  };
}

test("setup review returns an artifact-bound unified review without reviewed private scope metadata", async () => {
  const result = await runSetupReview({
    selectedConnectorIds: ["github", "vercel"],
    profileDocument: { version: 1, profiles: [profile({ scope: { kind: "organization", login: "fictional-org" } })] },
    planning: { privateDetail: "must-not-survive" },
    sourceCatalog: sourceCatalog(),
    now: NOW,
  }, {
    sessionId: "fictional-setup-run",
    connectors: [{ connectorId: "github", async collect() { return { state: "connected", observedAt: NOW, message: "One repository observed.", observations: [githubObservation()] }; } }],
  });

  assert.equal(result.command, "setup-run");
  assert.equal(result.readOnly, true);
  assert.equal(result.selectedOnly, false, "an unscoped injected planning result must not be relabeled selected-only");
  assert.equal(result.planning.selectedOnly, false);
  assert.match(result.review.artifactId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.review.summary.connectionQuestions, 1);
  assert.equal(result.review.summary.candidateQuestions, 1);
  assert.equal(result.review.presentation.sourcePreflight.checkedCount, 1);
  assert.deepEqual(result.review.presentation.sourcePreflight.ready.map((source) => source.connectorId), ["github"]);
  assert.deepEqual(result.review.presentation.sourcePreflight.needsAttention.map((source) => [source.connectorId, source.preflightStatus]), [["vercel", "needs-scope"]]);
  assert.deepEqual(result.review.presentation.knownExactMatches, { count: 0, hiddenFromHumanReview: true, byProvider: [] });
  assert.equal(result.review.presentation.artifactReview.candidateCount, 1);
  assert.equal(result.review.presentation.delivery.writes, false);
  assert.ok(result.review.questionGroups.some((group) => group.type === "scope" && group.provider === "vercel"));
  const candidateGroup = result.review.questionGroups.find((group) => group.candidateCount === 1);
  assert.equal(candidateGroup.candidateIds[0], result.review.findings[0].candidateId);
  assert.equal(candidateGroup.evidence.freshness[0], "fresh");
  assert.doesNotMatch(JSON.stringify(result), /fictional-builder|Fictional builder|"authorization"|FICTIONAL_/);
  assert.doesNotMatch(JSON.stringify(result), /must-not-survive/);
});

test("setup review presentation separates checked sources, hidden exact matches, attention and artifact groups", async () => {
  const projects = Array.from({ length: 10 }, (_, index) => ({ manifest: {
    version: 1,
    id: `known-product-${index}`,
    title: `Known Product ${index}`,
    registration: "overlay",
    description: "Reviewed setup presentation fixture.",
    lifecycle: "active",
    kind: "product",
    repository: `fictional-org/known-product-${index}`,
    services: [],
  } }));
  const catalog = {
    hosts: [{ id: "fictional-mac", name: "Fictional Mac", kind: "mac", location: "local" }],
    hostIds: new Set(["fictional-mac"]),
    projects,
  };
  const observations = Array.from({ length: 38 }, (_, index) => {
    const name = index < 10 ? `known-product-${index}` : `candidate-${index - 10}`;
    return {
      ...githubObservation(),
      providerId: String(1000 + index),
      name,
      fullName: `fictional-org/${name}`,
      url: `https://github.com/fictional-org/${name}`,
      identity: { provider: "github", owner: "fictional-org", name },
    };
  });
  const profiles = [
    profile({ scope: { kind: "organization", login: "fictional-org" } }),
    profile({ id: "local-reviewed", connectorId: "local-host", authorization: { method: "local-session" }, scope: { hostId: "fictional-mac" } }),
    profile({ id: "openai-reviewed", connectorId: "openai", authorization: { method: "secret-reference", credentialRef: { kind: "environment", locator: "FICTIONAL_OPENAI_KEY" } }, scope: { organizationId: "org_fictional", projectId: "proj_fictional" } }),
  ];
  const input = {
    selectedConnectorIds: ["github", "local-host", "vercel", "railway", "openai"],
    profileDocument: { version: 1, profiles },
    sourceCatalog: catalog,
    now: NOW,
  };
  const options = {
    sessionId: "fictional-setup-presentation",
    resolveCredential() { return "ephemeral-test-value"; },
    connectors: [
      { connectorId: "github", async collect() { return { state: "connected", observedAt: NOW, observations }; } },
      { connectorId: "local-host", async collect() { return { state: "connected", observedAt: NOW, observations: [] }; } },
      { connectorId: "openai", async collect() { return { state: "connected", observedAt: NOW, observations: [] }; } },
    ],
  };
  const result = await runSetupReview(input, options);
  const presentation = result.review.presentation;

  assert.deepEqual({
    selected: presentation.sourcePreflight.selected,
    profileReady: presentation.sourcePreflight.profileReadyCount,
    checked: presentation.sourcePreflight.checkedCount,
    ready: presentation.sourcePreflight.readyCount,
    notChecked: presentation.sourcePreflight.notCheckedCount,
    attention: presentation.sourcePreflight.needsAttentionCount,
  }, { selected: 5, profileReady: 3, checked: 3, ready: 3, notChecked: 0, attention: 2 });
  assert.deepEqual(presentation.sourcePreflight.ready.map((source) => [source.connectorId, source.checked, source.checkState]), [
    ["github", true, "connected"],
    ["local-host", true, "connected"],
    ["openai", true, "connected"],
  ]);
  assert.deepEqual(presentation.sourcePreflight.needsAttention.map((source) => [source.connectorId, source.preflightStatus, source.nextAction.id]), [
    ["vercel", "needs-scope", "open-guided-connection"],
    ["railway", "needs-scope", "open-guided-connection"],
  ]);
  assert.deepEqual(presentation.knownExactMatches, {
    count: 10,
    hiddenFromHumanReview: true,
    byProvider: [{ provider: "github", count: 10 }],
  });
  assert.equal(presentation.artifactReview.artifactId, result.review.artifactId);
  assert.equal(presentation.artifactReview.candidateCount, 28);
  assert.equal(presentation.artifactReview.groupCount, 1);
  assert.deepEqual(presentation.artifactReview.groupIds, result.review.questionGroups.filter((group) => group.phase === "triage").map((group) => group.id));
  assert.deepEqual(presentation.delivery, { transport: "stdout", writes: false });

  const human = formatSetupReview(result);
  assert.match(human, /^3 of 5 sources are ready\.\nNext: connect 2 sources\./);
  assert.match(human, /Connect Vercel[\s\S]*What you need:[\s\S]*Why:[\s\S]*Actions:/);
  assert.match(human, /Use a saved connection:[\s\S]*Help me connect:[\s\S]*Not now:/);
  assert.match(human, /Use a saved connection: Check a reusable Vercel connection already configured for DevHub\./i);
  assert.doesNotMatch(human, /Vercel account already available to this task/i);
  assert.doesNotMatch(human, /Railway|QUESTION|setup-run-|artifact|candidate-0|known-product-0|org_fictional|proj_fictional|FICTIONAL_OPENAI_KEY|ephemeral-test-value|sha256|locator|credentialRef/i);
  assert.doesNotMatch(JSON.stringify(result), /local-reviewed|openai-reviewed|org_fictional|proj_fictional|FICTIONAL_OPENAI_KEY|ephemeral-test-value/);

  const repeated = await runSetupReview(input, options);
  assert.equal(JSON.stringify(repeated.review.presentation), JSON.stringify(presentation));
});

test("setup review redacts hostile connector messages while human output shows only the first safe blocker", async () => {
  const privateProfile = profile({
    id: "private-profile-id",
    owner: "Private profile owner",
    authorization: { method: "secret-reference", credentialRef: { kind: "environment", locator: "PRIVATE_GITHUB_TOKEN" } },
    scope: { kind: "organization", login: "private-scope-example" },
  });
  const leaked = [
    privateProfile.id,
    privateProfile.owner,
    privateProfile.scope.login,
    privateProfile.authorization.credentialRef.locator,
    ["s", "k-", "123456789012345678901234"].join(""),
  ].join(" · ");
  const result = await runSetupReview({
    selectedConnectorIds: ["github", "vercel"],
    profileDocument: { version: 1, profiles: [privateProfile] },
    sourceCatalog: sourceCatalog(),
    now: NOW,
  }, {
    connectors: [{ connectorId: "github", async collect() { return { state: "unknown", observedAt: NOW, message: leaked, observations: [] }; } }],
    resolveCredential: () => "ordinary-ephemeral-value",
  });
  const serialized = JSON.stringify(result);
  assert.equal(result.safety.privateScopeReturned, false);
  assert.doesNotMatch(serialized, /private-profile-id|Private profile owner|private-scope-example|PRIVATE_GITHUB_TOKEN|ordinary-ephemeral-value|sk-/i);
  assert.equal(result.session.results[0].state, "unknown");
  assert.equal(result.session.results[0].message, "The bounded connector check did not return a usable observation.");

  const human = formatSetupReview(result);
  assert.match(human, /^0 of 2 sources are ready\.\nNext: connect 2 sources\./);
  assert.match(human, /Connect GitHub[\s\S]*What you need:[\s\S]*Why:[\s\S]*Retry bounded check/);
  assert.doesNotMatch(human, /Vercel|QUESTION|setup-run-|private-profile-id|Private profile owner|private-scope-example|PRIVATE_GITHUB_TOKEN|ordinary-ephemeral-value|sha256|locator|credentialRef|sk-/i);
  for (const group of result.review.questionGroups) {
    assert.ok(serialized.includes(JSON.stringify(group.id)), "structured JSON must preserve every question ID");
    assert.doesNotMatch(human, new RegExp(group.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("a stale reviewed exact profile is rechecked and a successful result clears reconnect attention", async () => {
  let calls = 0;
  const result = await runSetupReview({
    selectedConnectorIds: ["github"],
    profileDocument: { version: 1, profiles: [profile({ lastObservedAt: "2026-08-13T13:00:00.000Z", scope: { kind: "organization", login: "fictional-org" } })] },
    sourceCatalog: sourceCatalog(),
    now: NOW,
  }, {
    connectors: [{ connectorId: "github", async collect() { calls += 1; return { state: "connected", observedAt: NOW, observations: [] }; } }],
  });
  assert.equal(result.preflight.selected[0].status, "reconnect");
  assert.equal(calls, 1);
  assert.equal(result.session.results[0].state, "connected");
  assert.equal(result.review.summary.connectionQuestions, 0);
  assert.equal(formatSetupReview(result), "1 of 1 sources are ready.\n0 known resources matched. 0 possible matches need review. 0 new items found.");
});

test("an authorization-required reviewed exact profile can recover through its ephemeral resolver", async () => {
  let resolved = 0;
  let collectedCredential = null;
  const railwayProfile = profile({
    id: "railway-reviewed",
    connectorId: "railway",
    authorization: { method: "secret-reference", credentialRef: { kind: "environment", locator: "FICTIONAL_RAILWAY_TOKEN" } },
    scope: { kind: "workspace", id: "11111111-1111-4111-8111-111111111111" },
    state: "authorization-required",
    lastObservedAt: null,
  });
  const result = await runSetupReview({ selectedConnectorIds: ["railway"], profileDocument: { version: 1, profiles: [railwayProfile] }, sourceCatalog: sourceCatalog(), now: NOW }, {
    resolveCredential() { resolved += 1; return "fictional-ephemeral-value"; },
    connectors: [{ connectorId: "railway", async collect({ credential }) { collectedCredential = credential; return { state: "connected", observedAt: NOW, observations: [] }; } }],
  });
  assert.equal(result.preflight.selected[0].status, "reconnect");
  assert.equal(resolved, 1);
  assert.equal(collectedCredential, "fictional-ephemeral-value");
  assert.equal(result.review.summary.connectionQuestions, 0);
  assert.doesNotMatch(JSON.stringify(result), /FICTIONAL_RAILWAY_TOKEN|fictional-ephemeral-value|railway-reviewed/);
});

test("missing reviewed scope performs zero provider IO and remains one preflight question", async () => {
  let calls = 0;
  const result = await runSetupReview({ selectedConnectorIds: ["github"], profileDocument: null, now: NOW }, {
    connectors: [{ connectorId: "github", async collect() { calls += 1; throw new Error("must not run"); } }],
  });
  assert.equal(calls, 0);
  assert.equal(result.session, null);
  assert.equal(result.review.summary.connectionQuestions, 1);
  assert.equal(result.review.questionGroups[0].state, "needs-scope");
});

test("one setup-run combines saved sources and multiple task-only observations without rerunning providers", async () => {
  let githubCalls = 0;
  let taskProviderCalls = 0;
  let credentialCalls = 0;
  const connectors = [
    {
      connectorId: "github",
      async collect() {
        githubCalls += 1;
        return { state: "connected", observedAt: NOW, observations: [githubObservation()] };
      },
    },
    { ...vercelSetupConnector, async collect() { taskProviderCalls += 1; throw new Error("task observation must prevent Vercel provider I/O"); } },
    { ...railwaySetupConnector, async collect() { taskProviderCalls += 1; throw new Error("task observation must prevent Railway provider I/O"); } },
  ];
  const result = await runSetupReview({
    selectedConnectorIds: ["github", "vercel", "railway"],
    profileDocument: { version: 1, profiles: [profile()] },
    taskObservationDocument: taskObservationInput(),
    sourceCatalog: sourceCatalog(),
    now: NOW,
  }, {
    connectors,
    resolveCredential() { credentialCalls += 1; throw new Error("task observation must not resolve credentials"); },
  });

  assert.equal(githubCalls, 1, "the reviewed saved source runs exactly once in the same bounded setup-run");
  assert.equal(taskProviderCalls, 0, "task-only sources consume existing observations without provider calls");
  assert.equal(credentialCalls, 0);
  assert.deepEqual(result.session.results.map((entry) => entry.connectorId), ["github"]);
  assert.equal(result.review.summary.connectionQuestions, 0);
  assert.match(result.review.artifactId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.taskObservations.checkedThisTask.length, 2);
  assert.deepEqual(result.taskObservations.eligible.map((entry) => entry.connectorId), ["vercel", "railway"], "a source with a saved connection is not task-observation eligible");
  assert.ok(result.taskObservations.checkedThisTask.every((entry) => entry.state === "checked-this-task" && entry.savedForRefresh === false));
  assert.deepEqual({
    selected: result.review.presentation.sourcePreflight.selected,
    profileReady: result.review.presentation.sourcePreflight.profileReadyCount,
    checkedThisTask: result.review.presentation.sourcePreflight.checkedThisTaskCount,
    savedForRefresh: result.review.presentation.sourcePreflight.savedForRefreshCount,
    taskOnly: result.review.presentation.sourcePreflight.taskOnlyCount,
    needsAttention: result.review.presentation.sourcePreflight.needsAttentionCount,
  }, { selected: 3, profileReady: 1, checkedThisTask: 3, savedForRefresh: 1, taskOnly: 2, needsAttention: 0 });
  assert.deepEqual(result.preflight.selected.map((source) => [source.connectorId, source.status]), [
    ["github", "ready"],
    ["vercel", "needs-scope"],
    ["railway", "needs-scope"],
  ], "task-only checks must not mutate saved connection readiness");
  assert.equal(result.connectionProfileProposals, null);
  assert.equal(result.safety.providerMutations, false);
  assert.equal(result.safety.catalogWrites, false);
  assert.equal(result.safety.taskObservationWrites, false);
  assert.equal(result.safety.taskObservationProfilesCreated, false);
  assert.equal(result.safety.taskObservationExactMatchesAllowed, false);
  assert.ok(result.review.findings.filter((entry) => ["vercel", "railway"].includes(entry.identity.provider)).every((entry) => entry.state !== "exact-match" && entry.exactMatch === null));
  const human = formatSetupReview(result);
  assert.match(human, /^3 of 3 sources checked for this task; 1 saved for refresh, 2 task-only\./);
  assert.match(human, /Vercel · Fictional Vercel Team · 1 resource checked for this task \(not saved\)\./);
  assert.match(human, /Railway · Fictional Railway Workspace · 1 resource checked for this task \(not saved\)\./);
  assert.doesNotMatch(human, /task-resource-|task-scope-|plugin-projects-v1|credential|locator|authorization|\{\s*"/i);
});

test("invalid task observations fail before saved, task-provider or credential I/O", async () => {
  let providerCalls = 0;
  let credentialCalls = 0;
  const connectors = [
    { connectorId: "github", async collect() { providerCalls += 1; throw new Error("must not run"); } },
    { ...vercelSetupConnector, async collect() { providerCalls += 1; throw new Error("must not run"); } },
    { ...railwaySetupConnector, async collect() { providerCalls += 1; throw new Error("must not run"); } },
  ];
  const base = taskObservationInput();
  const invalidDocuments = [
    { ...base, selectedConnectorIds: ["github", "vercel"] },
    { ...base, observations: [base.observations[0], base.observations[0]] },
    { ...base, observations: base.observations.toReversed() },
    { ...base, observations: [{ ...base.observations[0], observedAt: "2026-08-13T14:00:00.000Z" }, base.observations[1]] },
    { ...base, observations: [{ ...base.observations[0], scope: { ...base.observations[0].scope, id: "raw-provider-scope" } }, base.observations[1]] },
  ];
  for (const taskObservationDocument of invalidDocuments) {
    await assert.rejects(runSetupReview({
      selectedConnectorIds: ["github", "vercel", "railway"],
      profileDocument: { version: 1, profiles: [profile()] },
      taskObservationDocument,
      sourceCatalog: sourceCatalog(),
      now: NOW,
    }, {
      connectors,
      resolveCredential() { credentialCalls += 1; throw new Error("must not run"); },
    }), (error) => error.code.startsWith("task-observation-"));
  }
  await assert.rejects(runSetupReview({
    selectedConnectorIds: ["github", "vercel", "railway"],
    profileDocument: { version: 1, profiles: [profile()] },
    connectionReviewDocument: {},
    taskObservationDocument: base,
    sourceCatalog: sourceCatalog(),
    now: NOW,
  }, { connectors }), (error) => error.code === "setup-run-continuation-conflict");
  assert.equal(providerCalls, 0);
  assert.equal(credentialCalls, 0);
});

test("connection questions expose deterministic review IDs and exact typed answer schemas", async () => {
  const input = {
    selectedConnectorIds: ["github", "local-host", "vercel", "railway", "openai"],
    profileDocument: null,
    now: NOW,
  };
  const first = await runSetupReview(input);
  const second = await runSetupReview(input);
  assert.match(first.review.connectionReviewId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(second.review.connectionReviewId, first.review.connectionReviewId);
  assert.deepEqual(first.review.questionGroups.map((question) => [
    question.id,
    question.answerMode,
    question.answerSchema.required,
    question.answerSchema.additionalProperties,
  ]), [
    ["setup-run-github-needs-scope", "typed-object", ["scope", "owner"], false],
    ["setup-run-local-host-needs-scope", "typed-object", ["scope", "owner"], false],
    ["setup-run-vercel-needs-scope", "typed-object", ["scope", "credentialRef", "owner"], false],
    ["setup-run-railway-needs-scope", "typed-object", ["scope", "credentialRef", "owner"], false],
    ["setup-run-openai-needs-scope", "typed-object", ["scope", "credentialRef", "owner"], false],
  ]);
  assert.ok(first.review.questionGroups.every((question) => question.guidedConnection.actions.length >= 2));
  assert.doesNotMatch(JSON.stringify(first.review.presentation), /answerSchema|credentialRef|locator|generic-password|op:\/\//i);
  const human = formatSetupReview(first);
  assert.match(human, /^0 of 5 sources are ready\.\nNext: connect 5 sources\./);
  assert.match(human, /Connect GitHub[\s\S]*Use current sign-in:[\s\S]*Help me sign in:[\s\S]*Not now:/);
  assert.doesNotMatch(human, /Connect this computer|Connect Vercel|Connect Railway|Connect OpenAI|typed object|answer fields|credentialRef|locator|QUESTION|setup-run-|sha256|provider\/|needs-scope/i);
  for (const question of first.review.questionGroups) {
    assert.ok(JSON.stringify(first).includes(JSON.stringify(question.id)), "JSON must keep all five blocker questions");
    assert.doesNotMatch(human, new RegExp(question.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(JSON.stringify(first.review.presentation), /VERCEL_ACCESS_REF|RAILWAY_ACCESS_REF|team_fictional|11111111/);
});

test("human formatter renders each of the five guided blockers as one clean first-only card", async () => {
  for (const connectorId of ["github", "local-host", "vercel", "railway", "openai"]) {
    const result = await runSetupReview({ selectedConnectorIds: [connectorId], profileDocument: null, now: NOW });
    const question = result.review.questionGroups[0];
    const human = formatSetupReview(result);
    assert.match(human, /^0 of 1 sources are ready\.\nNext: connect 1 source\./);
    assert.match(human, new RegExp(question.guidedConnection.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(human, /What you need:[\s\S]*Why:[\s\S]*Actions:/);
    for (const action of question.guidedConnection.actions) {
      assert.match(human, new RegExp(action.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(human, new RegExp(action.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    if (["vercel", "railway", "openai"].includes(connectorId)) {
      assert.match(human, /Use a saved connection: Check a reusable [A-Za-z]+ connection already configured for DevHub\./i);
      assert.doesNotMatch(human, /account already available to this task/i);
    }
    assert.equal(question.guidedConnection.actions.length, 3);
    assert.ok(JSON.stringify(result).includes(JSON.stringify(question.id)), "structured JSON retains the internal blocker");
    assert.doesNotMatch(human, /QUESTION|setup-run-|needs-scope|typed-object|answerSchema|credentialRef|locator|sha256|generic-password|op:\/\/|PRIVATE_/i);
  }
});

test("generic continuation creates one stdout-only proposal for each runnable connector acquisition", async () => {
  const cases = [
    ["github", { scope: { kind: "organization", login: "fictional-org" }, owner: "Fictional operator" }, "cli-session"],
    ["local-host", { scope: { hostId: "fictional-mac" }, owner: "Fictional operator" }, "local-session"],
    ["vercel", { scope: { kind: "team", id: "team_fictionalstudio" }, credentialRef: { kind: "environment", locator: "VERCEL_ACCESS_REF" }, owner: "Fictional operator" }, "secret-reference"],
    ["railway", { scope: { kind: "workspace", id: "11111111-1111-4111-8111-111111111111" }, credentialRef: { kind: "environment", locator: "RAILWAY_ACCESS_REF" }, owner: "Fictional operator" }, "secret-reference"],
    ["openai", { scope: { kind: "project", id: "proj_fictional", parent: { kind: "workspace", id: "org-fictional" } }, credentialRef: { kind: "environment", locator: "OPENAI_ACCESS_REF" }, owner: "Fictional operator" }, "secret-reference"],
  ];
  for (const [connectorId, answer, authorizationMethod] of cases) {
    const initial = await runSetupReview({ selectedConnectorIds: [connectorId], profileDocument: null, now: NOW });
    let providerCalls = 0;
    let credentialCalls = 0;
    const result = await runSetupReview({
      selectedConnectorIds: [connectorId],
      connectionReviewDocument: {
        version: 1,
        reviewId: initial.review.connectionReviewId,
        answers: [{ questionId: `setup-run-${connectorId}-needs-scope`, connectorId, answer }],
      },
      sourceCatalog: sourceCatalog(),
      now: NOW,
    }, {
      connectors: [{ connectorId, collect() { providerCalls += 1; return { state: "connected", observedAt: NOW, observations: [] }; } }],
      resolveCredential() { credentialCalls += 1; return "ephemeral-provider-value"; },
    });
    assert.equal(providerCalls, 1, `${connectorId} should run only after its reviewed answer`);
    assert.equal(credentialCalls, authorizationMethod === "secret-reference" ? 1 : 0);
    assert.deepEqual(result.connectionProfileProposals.operations.map((operation) => [operation.operation, operation.profile.connectorId, operation.profile.authorization.method]), [["add", connectorId, authorizationMethod]]);
    assert.deepEqual(result.connectionProfileProposals.delivery, { transport: "stdout", writes: false });
  }
});

test("reviewed continuation advances one canonical typed blocker at a time and runs only that provider", async () => {
  const selectedConnectorIds = ["vercel", "railway"];
  const initial = await runSetupReview({ selectedConnectorIds, profileDocument: null, now: NOW });
  const vercelReview = {
    version: 1,
    reviewId: initial.review.connectionReviewId,
    answers: [{
      questionId: "setup-run-vercel-needs-scope",
      connectorId: "vercel",
      answer: {
        scope: { kind: "team", id: "team_fictionalstudio" },
        credentialRef: { kind: "environment", locator: "VERCEL_ACCESS_REF" },
        owner: "Fictional deployment operator",
      },
    }],
  };
  const calls = [];
  const resolved = [];
  const connectors = ["vercel", "railway"].map((connectorId) => ({
    connectorId,
    validateProfile(reviewed) {
      calls.push(["validate", connectorId, reviewed.connectorId]);
    },
    async collect({ profile: reviewed, credential }) {
      calls.push(["collect", connectorId, reviewed.connectorId, credential]);
      return { state: "connected", observedAt: NOW, observations: [] };
    },
  }));
  const vercelResult = await runSetupReview({
    selectedConnectorIds,
    profileDocument: null,
    connectionReviewDocument: vercelReview,
    sourceCatalog: sourceCatalog(),
    now: NOW,
  }, {
    connectors,
    resolveCredential(reference, context) {
      resolved.push([reference.kind, reference.locator, context.profile.connectorId]);
      return `ephemeral-${context.profile.connectorId}-credential`;
    },
  });

  assert.deepEqual(vercelResult.session.results.map((entry) => entry.connectorId), ["vercel"]);
  assert.deepEqual(calls.filter(([kind]) => kind === "collect").map(([, connectorId]) => connectorId), ["vercel"]);
  assert.deepEqual(resolved.map(([, , connectorId]) => connectorId), ["vercel"]);
  assert.match(vercelResult.review.artifactId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(vercelResult.connectionProfileProposals.delivery.transport, "stdout");
  assert.equal(vercelResult.connectionProfileProposals.delivery.writes, false);
  assert.deepEqual(vercelResult.connectionProfileProposals.operations.map((entry) => [entry.operation, entry.profile.connectorId]), [["add", "vercel"]]);

  const reviewedVercelProfile = vercelResult.connectionProfileProposals.operations[0].profile;
  const afterVercelReview = await runSetupReview({
    selectedConnectorIds,
    profileDocument: { version: 1, profiles: [reviewedVercelProfile] },
    sourceCatalog: sourceCatalog(),
    now: NOW,
  }, {
    connectors,
    resolveCredential: () => "ephemeral-vercel-credential",
  });
  assert.notEqual(afterVercelReview.review.connectionReviewId, initial.review.connectionReviewId);
  calls.length = 0;
  resolved.length = 0;
  const railwayReview = {
    version: 1,
    reviewId: afterVercelReview.review.connectionReviewId,
    answers: [{
      questionId: "setup-run-railway-needs-scope",
      connectorId: "railway",
      answer: {
        scope: { kind: "workspace", id: "11111111-1111-4111-8111-111111111111" },
        credentialRef: { kind: "environment", locator: "RAILWAY_ACCESS_REF" },
        owner: "Fictional deployment operator",
      },
    }],
  };
  const railwayResult = await runSetupReview({
    selectedConnectorIds,
    profileDocument: { version: 1, profiles: [reviewedVercelProfile] },
    connectionReviewDocument: railwayReview,
    sourceCatalog: sourceCatalog(),
    now: NOW,
  }, {
    connectors,
    resolveCredential(reference, context) {
      resolved.push([reference.kind, reference.locator, context.profile.connectorId]);
      return `ephemeral-${context.profile.connectorId}-credential`;
    },
  });
  assert.deepEqual(railwayResult.session.results.map((entry) => entry.connectorId), ["railway"]);
  assert.deepEqual(calls.filter(([kind]) => kind === "collect").map(([, connectorId]) => connectorId), ["railway"]);
  assert.deepEqual(resolved.map(([, , connectorId]) => connectorId), ["railway"]);
  assert.deepEqual(railwayResult.connectionProfileProposals.operations.map((entry) => [entry.operation, entry.profile.connectorId]), [["add", "railway"]]);
  assert.equal(railwayResult.safety.providerMutations, false);
  assert.equal(railwayResult.safety.catalogWrites, false);
  assert.equal(railwayResult.safety.privateScopeReturnedOnlyAsReviewedProposal, true);
  assert.doesNotMatch(JSON.stringify(railwayResult.review.presentation), /team_fictionalstudio|11111111|VERCEL_ACCESS_REF|RAILWAY_ACCESS_REF|Fictional deployment operator/);
  assert.doesNotMatch(JSON.stringify([vercelResult, railwayResult]), /ephemeral-(?:vercel|railway)-credential/);
});

test("connection continuation fails closed before credential or provider I/O on drift, replay, scope mismatch and extra answers", async () => {
  const initial = await runSetupReview({ selectedConnectorIds: ["vercel", "railway"], profileDocument: null, now: NOW });
  const answer = {
    questionId: "setup-run-vercel-needs-scope",
    connectorId: "vercel",
    answer: {
      scope: { kind: "team", id: "team_fictionalstudio" },
      credentialRef: { kind: "environment", locator: "VERCEL_ACCESS_REF" },
      owner: "Fictional deployment operator",
    },
  };
  let credentialCalls = 0;
  let providerCalls = 0;
  const options = {
    connectors: [{ connectorId: "vercel", async collect() { providerCalls += 1; return { state: "connected", observedAt: NOW, observations: [] }; } }],
    resolveCredential() { credentialCalls += 1; return "ephemeral-value"; },
  };
  await assert.rejects(
    runSetupReview({ selectedConnectorIds: ["vercel", "railway"], connectionReviewDocument: { version: 1, reviewId: `sha256:${"0".repeat(64)}`, answers: [answer] }, sourceCatalog: sourceCatalog(), now: NOW }, options),
    (error) => error.code === "connection-review-drift",
  );
  await assert.rejects(
    runSetupReview({ selectedConnectorIds: ["vercel", "railway"], connectionReviewDocument: { version: 1, reviewId: initial.review.connectionReviewId, answers: [{ ...answer, answer: { ...answer.answer, scope: { kind: "team", id: "other-team" } } }] }, sourceCatalog: sourceCatalog(), now: NOW }, options),
    (error) => error.code === "connection-review-scope-invalid",
  );
  await assert.rejects(
    runSetupReview({ selectedConnectorIds: ["vercel", "railway"], connectionReviewDocument: { version: 1, reviewId: initial.review.connectionReviewId, answers: [{ questionId: "setup-run-github-needs-scope", connectorId: "github", answer: { scope: { kind: "organization", login: "fictional-org" }, owner: "Fictional operator" } }] }, sourceCatalog: sourceCatalog(), now: NOW }, options),
    (error) => error.code === "connection-review-question-invalid",
  );
  const railwayAnswer = {
    questionId: "setup-run-railway-needs-scope",
    connectorId: "railway",
    answer: {
      scope: { kind: "workspace", id: "11111111-1111-4111-8111-111111111111" },
      credentialRef: { kind: "environment", locator: "RAILWAY_ACCESS_REF" },
      owner: "Fictional deployment operator",
    },
  };
  await assert.rejects(
    runSetupReview({ selectedConnectorIds: ["vercel", "railway"], connectionReviewDocument: { version: 1, reviewId: initial.review.connectionReviewId, answers: [answer, railwayAnswer] }, sourceCatalog: sourceCatalog(), now: NOW }, options),
    (error) => error.code === "connection-review-invalid",
  );
  await assert.rejects(
    runSetupReview({ selectedConnectorIds: ["vercel", "railway"], connectionReviewDocument: { version: 1, reviewId: initial.review.connectionReviewId, answers: [railwayAnswer] }, sourceCatalog: sourceCatalog(), now: NOW }, options),
    (error) => error.code === "connection-review-question-invalid",
  );
  assert.equal(credentialCalls, 0, "invalid batches and later-blocker skips must not resolve credentials");
  assert.equal(providerCalls, 0, "invalid batches and later-blocker skips must not call providers");

  const accepted = await runSetupReview({ selectedConnectorIds: ["vercel", "railway"], connectionReviewDocument: { version: 1, reviewId: initial.review.connectionReviewId, answers: [answer] }, sourceCatalog: sourceCatalog(), now: NOW }, options);
  const persistedProposal = accepted.connectionProfileProposals.operations[0].profile;
  await assert.rejects(
    runSetupReview({ selectedConnectorIds: ["vercel", "railway"], profileDocument: { version: 1, profiles: [persistedProposal] }, connectionReviewDocument: { version: 1, reviewId: initial.review.connectionReviewId, answers: [answer] }, sourceCatalog: sourceCatalog(), now: NOW }, options),
    (error) => error.code === "connection-review-drift",
  );
  assert.equal(credentialCalls, 1, "only the one accepted continuation may resolve a credential");
  assert.equal(providerCalls, 1, "only the one accepted continuation may call a provider");
});

test("failed recheck emits one connector question even when one of multiple profiles succeeds", async () => {
  const profiles = [
    profile({ id: "github-one", lastObservedAt: "2026-08-13T13:00:00.000Z", scope: { kind: "organization", login: "fictional-one" } }),
    profile({ id: "github-two", lastObservedAt: "2026-08-13T13:00:00.000Z", scope: { kind: "organization", login: "fictional-two" } }),
  ];
  const result = await runSetupReview({ selectedConnectorIds: ["github"], profileDocument: { version: 1, profiles }, sourceCatalog: sourceCatalog(), now: NOW }, {
    connectors: [{ connectorId: "github", async collect({ profile: reviewed }) { return reviewed.scope.login === "fictional-one" ? { state: "connected", observedAt: NOW, observations: [] } : { state: "unknown", observedAt: NOW, message: "The bounded GitHub check could not verify this reviewed connection.", observations: [] }; } }],
  });
  assert.equal(result.session.results.length, 2);
  assert.equal(result.review.summary.connectionQuestions, 1);
  assert.equal(result.review.questionGroups.filter((group) => group.provider === "github").length, 1);
  assert.equal(result.review.questionGroups[0].id, "setup-run-github-recheck");
  assert.doesNotMatch(JSON.stringify(result), /github-one|github-two|fictional-one|fictional-two/);
});

test("overall deadline keeps successful sources and returns deterministic attention for the timed-out source", async () => {
  const localProfile = profile({
    id: "local-reviewed",
    connectorId: "local-host",
    authorization: { method: "local-session" },
    scope: { hostId: "fictional-mac" },
  });
  const githubConnector = { connectorId: "github", async collect() { return { state: "connected", observedAt: NOW, observations: [githubObservation()] }; } };
  const localConnector = { connectorId: "local-host", async collect() { return new Promise(() => {}); } };
  const result = await runSetupReview({
    selectedConnectorIds: ["github", "local-host"],
    profileDocument: { version: 1, profiles: [localProfile, profile({ scope: { kind: "organization", login: "fictional-org" } })] },
    sourceCatalog: sourceCatalog(),
    now: NOW,
  }, { deadlineMs: 100, connectors: [githubConnector, localConnector] });

  assert.equal(result.execution.timedOut, true);
  assert.equal(result.execution.reason, "overall-deadline-exceeded");
  assert.deepEqual(result.session.results.map((entry) => [entry.connectorId, entry.state]), [["github", "connected"], ["local-host", "unknown"]]);
  assert.equal(result.review.findings.some((entry) => entry.identity.provider === "github"), true);
  const localFinding = result.review.findings.find((entry) => entry.identity.provider === "local-host");
  assert.equal(localFinding.identity.resourceId, null, "reviewed profile ID must not be presented as a scope resource");
  assert.match(result.review.questionGroups.find((group) => group.provider === "local-host").prompt, /overall setup-run deadline/i);
  assert.doesNotMatch(JSON.stringify(result), /local-reviewed|fictional-mac|github-reviewed/);
});

test("overall deadline cancels a hostile local inspection handle and the child exits naturally", async () => {
  const setupRunUrl = pathToFileURL(path.join(root, "lib/setup-run.mjs")).href;
  const setupSessionUrl = pathToFileURL(path.join(root, "scripts/setup-session.mjs")).href;
  const source = `
    import { runSetupReview } from ${JSON.stringify(setupRunUrl)};
    import { createLocalHostSetupConnector } from ${JSON.stringify(setupSessionUrl)};
    const now = ${JSON.stringify(NOW)};
    const reviewed = {
      version: 1, id: "fictional-local", connectorId: "local-host",
      authorization: { method: "local-session" }, scope: { hostId: "fictional-mac" },
      owner: "Fictional builder", state: "connected",
      lastObservedAt: "2026-08-13T15:30:00.000Z", freshForSeconds: 3600,
    };
    const connector = createLocalHostSetupConnector({
      root: ${JSON.stringify(root)},
      inspect(_root, _hostId, options) {
        const activeHandle = setInterval(() => {}, 10_000);
        options.signal?.addEventListener("abort", () => clearInterval(activeHandle), { once: true });
        return new Promise(() => {});
      },
    });
    const result = await runSetupReview({
      selectedConnectorIds: ["local-host"], profileDocument: { version: 1, profiles: [reviewed] },
      sourceCatalog: { hosts: [{ id: "fictional-mac", name: "Fictional Mac", kind: "mac", location: "local" }], hostIds: new Set(["fictional-mac"]), projects: [] },
      now,
    }, { deadlineMs: 100, connectors: [connector] });
    console.log(JSON.stringify({ reason: result.execution.reason, timedOut: result.execution.timedOut }));
  `;
  const { stdout, stderr } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: root,
    timeout: 3_000,
  });
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), { reason: "overall-deadline-exceeded", timedOut: true });
});

test("command-wide deadline includes planning before any provider session starts", async () => {
  let providerCalls = 0;
  const startedAt = Date.now();
  const { result } = await runSetupRunCommand(root, ["--sources", "github", "--json"], {
    deadlineMs: 100,
    planning: {
      access() { return new Promise(() => {}); },
      lstat() { return new Promise(() => {}); },
    },
    connectors: [{ connectorId: "github", collect() { providerCalls += 1; throw new Error("must not run"); } }],
  });
  assert.equal(providerCalls, 0);
  assert.equal(result.execution.reason, "overall-deadline-exceeded");
  assert.equal(result.execution.timedOut, true);
  assert.ok(Date.now() - startedAt < 500, "planning must consume the same command-wide budget");
});

test("setup-run marker planning probes selected sources only and ignores a hostile unselected marker", async () => {
  const inspected = [];
  const { result } = await runSetupRunCommand(root, ["--sources", "github", "--json"], {
    deadlineMs: 1_000,
    environment: { DEVHUB_CONNECTION_PROFILES_FILE: path.join(os.tmpdir(), `devhub-missing-profiles-${process.pid}.json`) },
    planning: {
      cwd: "/fixture/project",
      homeDirectory: "/fixture/home",
      pathValue: "/fixture/bin",
      platform: "darwin",
      access: async (filename) => {
        inspected.push(filename);
        throw Object.assign(new Error("absent"), { code: "ENOENT" });
      },
      lstat: async (filename) => {
        inspected.push(filename);
        if (/\.vercel|railway|package\.json|compose\.yaml/.test(filename)) return new Promise(() => {});
        throw Object.assign(new Error("absent"), { code: "ENOENT" });
      },
    },
  });

  assert.equal(result.selectedOnly, true);
  assert.equal(result.planning.selectedOnly, true);
  assert.equal(result.execution.timedOut, false);
  assert.deepEqual(result.planning.sources.map((source) => source.connectorId), ["github"]);
  assert.deepEqual(inspected, ["/fixture/bin/gh", "/fixture/project/.git/config"]);
});

test("setup-run CLI accepts only an absolute reviewed answer document and continues through the original selection", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-connection-review-"));
  const missingProfiles = path.join(temporary, "missing-profiles.json");
  const reviewPath = path.join(temporary, "reviewed-answers.json");
  let providerCalls = 0;
  try {
    await assert.rejects(
      runSetupRunCommand(root, ["--sources", "vercel,railway", "--connection-review", "relative-review.json", "--json"]),
      (error) => error.code === "setup-run-arguments-invalid",
    );
    const initial = await runSetupRunCommand(root, ["--sources", "vercel,railway", "--json"], {
      environment: { DEVHUB_CONNECTION_PROFILES_FILE: missingProfiles },
      now: NOW,
    });
    await writeFile(reviewPath, `${JSON.stringify({
      version: 1,
      reviewId: initial.result.review.connectionReviewId,
      answers: [
        {
          questionId: "setup-run-vercel-needs-scope",
          connectorId: "vercel",
          answer: {
            scope: { kind: "team", id: "team_fictionalstudio" },
            credentialRef: { kind: "environment", locator: "VERCEL_ACCESS_REF" },
            owner: "Fictional deployment operator",
          },
        },
      ],
    }, null, 2)}\n`);
    const continued = await runSetupRunCommand(root, ["--sources", "vercel,railway", "--connection-review", reviewPath, "--json"], {
      environment: { DEVHUB_CONNECTION_PROFILES_FILE: missingProfiles },
      now: NOW,
      connectors: [
        { connectorId: "vercel", async collect() { providerCalls += 1; return { state: "connected", observedAt: NOW, observations: [] }; } },
        { connectorId: "railway", async collect() { throw new Error("unanswered source must not run"); } },
      ],
      resolveCredential: () => "ephemeral-cli-value",
    });
    assert.deepEqual(continued.parsed.selectedConnectorIds, ["vercel", "railway"]);
    assert.equal(continued.parsed.connectionReviewPath, reviewPath);
    assert.deepEqual(continued.result.session.results.map((entry) => entry.connectorId), ["vercel"]);
    assert.equal(providerCalls, 1);
    assert.equal(continued.result.connectionProfileProposals.operations.length, 1);
    assert.equal(continued.result.connectionProfileProposals.delivery.writes, false);
    assert.doesNotMatch(JSON.stringify(continued.result.review.presentation), /team_fictionalstudio|VERCEL_ACCESS_REF|Fictional deployment operator/);
    assert.doesNotMatch(JSON.stringify(continued.result), /ephemeral-cli-value/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("setup-run CLI consumes one absolute multi-source task observation in the canonical run", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-task-observation-"));
  const observationPath = path.join(temporary, "task-observation.json");
  const missingProfiles = path.join(temporary, "missing-profiles.json");
  let providerCalls = 0;
  try {
    await assert.rejects(
      runSetupRunCommand(root, ["--sources", "vercel,railway", "--task-observation", "relative-observation.json", "--json"]),
      (error) => error.code === "setup-run-arguments-invalid",
    );
    await assert.rejects(
      runSetupRunCommand(root, ["--sources", "vercel,railway", "--task-observation", observationPath, "--connection-review", path.join(temporary, "review.json"), "--json"]),
      (error) => error.code === "setup-run-arguments-invalid",
    );
    await writeFile(observationPath, `${JSON.stringify(taskObservationInput(["vercel", "railway"]), null, 2)}\n`);
    const completed = await runSetupRunCommand(root, ["--sources", "vercel,railway", "--task-observation", observationPath, "--json"], {
      environment: { DEVHUB_CONNECTION_PROFILES_FILE: missingProfiles },
      now: NOW,
      connectors: [
        { ...vercelSetupConnector, async collect() { providerCalls += 1; throw new Error("task-only Vercel must not run"); } },
        { ...railwaySetupConnector, async collect() { providerCalls += 1; throw new Error("task-only Railway must not run"); } },
      ],
      resolveCredential() { throw new Error("task-only sources must not resolve credentials"); },
    });

    assert.deepEqual(completed.parsed.selectedConnectorIds, ["vercel", "railway"]);
    assert.equal(completed.parsed.taskObservationPath, observationPath);
    assert.equal(completed.result.session, null);
    assert.equal(completed.result.review.summary.connectionQuestions, 0);
    assert.equal(completed.result.taskObservations.checkedThisTask.length, 2);
    assert.equal(completed.result.review.presentation.sourcePreflight.checkedThisTaskCount, 2);
    assert.equal(completed.result.review.presentation.sourcePreflight.savedForRefreshCount, 0);
    assert.equal(completed.result.review.presentation.sourcePreflight.taskOnlyCount, 2);
    assert.equal(completed.result.connectionProfileProposals, null);
    assert.equal(providerCalls, 0);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("setup-run waits for isolated planning child cleanup before returning its timeout review", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-setup-run-planning-child-"));
  const childPath = path.join(temporary, "hostile-probe.mjs");
  await writeFile(childPath, `
    process.on("SIGTERM", () => {});
    process.stdin.resume();
    setInterval(() => {}, 10_000);
  `);
  try {
    const startedAt = Date.now();
    const { result } = await runSetupRunCommand(root, ["--sources", "github", "--json"], {
      deadlineMs: 100,
      planning: { probeChildPath: childPath },
    });
    assert.equal(result.execution.reason, "overall-deadline-exceeded");
    assert.equal(result.execution.timedOut, true);
    assert.ok(Date.now() - startedAt < 1_000, "setup-run must await bounded child reap, not an abandoned probe");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("an explicit preload timeout wins its classification race while a genuine external abort stays aborted", async () => {
  const deadlineAt = Date.now() + 5_000;
  const timedOut = await runSetupReview({ selectedConnectorIds: ["github"], profileDocument: null, now: NOW }, {
    deadlineMs: 5_000,
    deadlineAt,
    deadlineExpired: true,
    signal: AbortSignal.abort(),
  });
  assert.equal(timedOut.execution.reason, "overall-deadline-exceeded");
  assert.equal(timedOut.execution.timedOut, true);

  const aborted = await runSetupReview({ selectedConnectorIds: ["github"], profileDocument: null, now: NOW }, {
    deadlineMs: 5_000,
    deadlineAt,
    deadlineExpired: false,
    signal: AbortSignal.abort(),
  });
  assert.equal(aborted.execution.reason, "aborted");
  assert.equal(aborted.execution.timedOut, false);
});

test("npm setup-run wrapper emits one bounded JSON result", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-setup-run-cli-"));
  const catalogDirectory = path.join(temporary, "catalog");
  const projectDirectory = path.join(catalogDirectory, "projects");
  const binDirectory = path.join(temporary, "bin");
  const profileFilename = path.join(temporary, "connection-profiles.json");
  try {
    await Promise.all([
      mkdir(projectDirectory, { recursive: true }),
      mkdir(binDirectory, { recursive: true }),
    ]);
    await writeFile(path.join(catalogDirectory, "hosts.yaml"), "version: 1\nhosts:\n  - id: fictional-host\n    name: Fictional host\n    kind: linux\n    location: local\n");
    await writeFile(path.join(projectDirectory, "fictional-project.yaml"), `version: 1
id: fictional-project
title: Fictional project
registration: overlay
description: Fictional bounded setup-run fixture.
lifecycle: active
kind: product
services:
  - id: gateway
    name: Gateway
    kind: api
    environment: local
    host: fictional-host
    runtime: systemd
    mode: always-on
    visibility: local
    commands:
      restart: systemctl restart fictional-gateway.service
`);
    await writeFile(profileFilename, `${JSON.stringify({ version: 1, profiles: [{
      version: 1,
      id: "fictional-local",
      connectorId: "local-host",
      authorization: { method: "local-session" },
      scope: { hostId: "fictional-host" },
      owner: "Fictional builder",
      state: "connected",
      lastObservedAt: NOW,
      freshForSeconds: 3600,
    }] }, null, 2)}\n`);
    const fakeSystemctl = path.join(binDirectory, "systemctl");
    await writeFile(fakeSystemctl, "#!/bin/sh\nexec sleep 60\n");
    await chmod(fakeSystemctl, 0o755);

    const { stdout, stderr } = await execFileAsync("npm", [
      "--silent", "run", "devhub", "--", "setup-run", "--sources", "local-host", "--deadline-ms", "150", "--json",
    ], {
      cwd: root,
      env: {
        ...process.env,
        DEVHUB_CATALOG_DIR: catalogDirectory,
        DEVHUB_CONNECTION_PROFILES_FILE: profileFilename,
        PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      timeout: 5_000,
    });
    assert.equal(stderr, "");
    const result = JSON.parse(stdout);
    assert.equal(result.command, "setup-run");
    assert.ok(["bounded-review", "overall-deadline-exceeded"].includes(result.execution.reason));
    assert.equal(result.execution.timedOut, result.execution.reason === "overall-deadline-exceeded");
    assert.equal((stdout.match(/"command": "setup-run"/g) ?? []).length, 1);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("production CLI returns one selected-only review through the default registries", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-setup-run-empty-profile-"));
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cli, "setup-run", "--sources", "github,vercel", "--json"], {
      cwd: root,
      env: { ...process.env, DEVHUB_CONNECTION_PROFILES_FILE: path.join(temporary, "missing-profiles.json") },
      timeout: 10_000,
    });
    assert.equal(stderr, "");
    const result = JSON.parse(stdout);
    assert.equal(result.command, "setup-run");
    assert.equal(result.selectedOnly, true);
    assert.deepEqual(result.preflight.selected.map((source) => source.connectorId), ["github", "vercel"]);
    assert.deepEqual(result.planning.sources.map((source) => source.connectorId), ["github", "vercel"]);
    assert.equal(result.safety.credentialValuesReturned, false);
    assert.equal(result.safety.privateScopeReturned, false);
    assert.doesNotMatch(stdout, /generic-password:|op:\/\/|"authorization"|private-profile-identifier/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("production CLI rejects missing and unsupported source selections without provider IO", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-setup-run-invalid-"));
  try {
    for (const args of [
      ["setup-run", "--json"],
      ["setup-run", "--sources", "cloudflare", "--json"],
      ["setup-run", "--sources", "github", "--deadline-ms", "99", "--json"],
    ]) {
      await assert.rejects(execFileAsync(process.execPath, [cli, ...args], {
        cwd: root,
        env: { ...process.env, DEVHUB_CONNECTION_PROFILES_FILE: path.join(temporary, "missing-profiles.json") },
        timeout: 10_000,
      }), (error) => {
        const failure = JSON.parse(error.stdout);
        return error.code === 3 && failure.command === "setup-run" && failure.readOnly === true;
      });
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
