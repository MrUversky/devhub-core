import { createHash } from "node:crypto";

import { createConnectionSnapshot } from "./connection-snapshot.mjs";
import { connectorContractRegistry } from "./connector-contracts.mjs";
import { buildDiscoveryInbox } from "./discovery-inbox.mjs";
import { parseConnectionProfileDocument, runSetupSession } from "./setup-session.mjs";
import { createConnectionOnboardingRegistry } from "./setup-connectors/onboarding-registry.mjs";
import {
  createTaskObservationBridgeRegistry,
  parseTaskObservationDocument,
  TaskObservationError,
} from "./task-observations.mjs";
import {
  createSetupRunPresentationPreflight,
  SETUP_RUN_CONNECTOR_SUPPORT,
  SetupRunError,
} from "./setup-run-presentation.mjs";

export { createSetupRunPresentationPreflight, SetupRunError } from "./setup-run-presentation.mjs";

export const SETUP_RUN_DEFAULT_DEADLINE_MS = 30_000;
export const SETUP_RUN_MAX_DEADLINE_MS = 120_000;

const CONNECTION_REVIEW_FIELDS = new Set(["version", "reviewId", "answers"]);
const CONNECTION_ANSWER_FIELDS = new Set(["questionId", "connectorId", "answer"]);

function fail(code, message) {
  throw new SetupRunError(code, message);
}

function bindTaskObservations(document, preflight, connectors, now) {
  const bridges = createTaskObservationBridgeRegistry(connectors);
  const selectedConnectorIds = preflight.presentation.selected.map((source) => source.connectorId);
  const eligible = preflight.presentation.selected.flatMap((source) => {
    const bridge = bridges.get(source.connectorId);
    return bridge && source.status === "needs-scope"
      ? [{ connectorId: source.connectorId, bridgeId: bridge.id, acquisition: bridge.acquisition }]
      : [];
  });
  if (document === null || document === undefined) {
    return freeze({
      document: null,
      connectorIds: [],
      eligible,
    });
  }
  let parsed;
  try {
    parsed = parseTaskObservationDocument(document, { selectedConnectorIds, bridges, now });
  } catch (error) {
    if (error instanceof TaskObservationError) fail(error.code, error.message);
    throw error;
  }
  const sourceByConnector = new Map(preflight.presentation.selected.map((source) => [source.connectorId, source]));
  for (const observation of parsed.observations) {
    if (sourceByConnector.get(observation.connectorId)?.status !== "needs-scope") {
      fail("task-observation-source-ineligible", `${observation.connectorId} task observation is accepted only when no saved connection is ready to check`);
    }
  }
  return freeze({
    document: parsed,
    connectorIds: parsed.observations.map((observation) => observation.connectorId),
    eligible,
  });
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactFields(value, fields, label, code = "connection-review-invalid") {
  if (!plainObject(value)) fail(code, `${label} must be an object`);
  for (const key of Object.keys(value)) if (!fields.has(key)) fail(code, `${label}.${key} is not supported`);
}

function requiredReviewString(value, label, maximum = 300) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    fail("connection-review-invalid", `${label} must be a non-empty bounded string`);
  }
  return value.trim();
}

/** Strict syntax parser. Current-question binding is checked again by runSetupReview before any provider I/O. */
export function parseConnectionReviewDocument(value, onboardings = createConnectionOnboardingRegistry()) {
  exactFields(value, CONNECTION_REVIEW_FIELDS, "connection review");
  if (value.version !== 1) fail("connection-review-invalid", "connection review.version must be 1");
  const reviewId = requiredReviewString(value.reviewId, "connection review.reviewId", 80);
  if (!/^sha256:[a-f0-9]{64}$/.test(reviewId)) fail("connection-review-invalid", "connection review.reviewId must be a sha256 identifier");
  if (!Array.isArray(value.answers) || value.answers.length !== 1) {
    fail("connection-review-invalid", "connection review.answers must contain exactly one reviewed answer");
  }
  const seenQuestions = new Set();
  const seenConnectors = new Set();
  const answers = value.answers.map((entry, index) => {
    const label = `connection review.answers[${index}]`;
    exactFields(entry, CONNECTION_ANSWER_FIELDS, label);
    const questionId = requiredReviewString(entry.questionId, `${label}.questionId`, 200);
    const connectorId = requiredReviewString(entry.connectorId, `${label}.connectorId`, 100);
    const onboarding = onboardings.get(connectorId);
    if (!onboarding) fail("connection-review-invalid", `${label}.connectorId is not continuation-capable`);
    if (seenQuestions.has(questionId) || seenConnectors.has(connectorId)) fail("connection-review-invalid", "connection review answers must be unique by question and connector");
    seenQuestions.add(questionId);
    seenConnectors.add(connectorId);
    let answer;
    try {
      answer = onboarding.validateAnswer(entry.answer);
    } catch (error) {
      fail(error?.code === "scope-invalid" ? "connection-review-scope-invalid" : "connection-review-invalid", `${connectorId} answer does not match its reviewed acquisition contract`);
    }
    return { questionId, connectorId, answer };
  });
  return freeze({ version: 1, reviewId, answers });
}

export function resolveSetupRunDeadline(value) {
  const deadlineMs = value ?? SETUP_RUN_DEFAULT_DEADLINE_MS;
  if (!Number.isInteger(deadlineMs) || deadlineMs < 100 || deadlineMs > SETUP_RUN_MAX_DEADLINE_MS) {
    fail("setup-run-deadline-invalid", `setup-run deadline must be an integer from 100 to ${SETUP_RUN_MAX_DEADLINE_MS}`);
  }
  return deadlineMs;
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function timestamp(value, label) {
  const date = new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) fail("setup-run-invalid", `${label} must be a valid timestamp`);
  return date;
}

function stableSessionId(selectedConnectorIds, evaluatedAt) {
  const material = JSON.stringify({ selectedConnectorIds, evaluatedAt });
  return `setup-run-${createHash("sha256").update(material).digest("hex").slice(0, 24)}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (plainObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function connectionReviewId(preflightQuestions, selectedSources) {
  if (!preflightQuestions.length) return null;
  const material = {
    version: 1,
    selected: selectedSources.map((source) => ({ connectorId: source.connectorId, status: source.status })),
    questions: preflightQuestions.map((question) => ({
      questionId: question.id,
      connectorId: question.provider,
      state: question.state,
      prompt: question.prompt,
      required: question.required,
      answerMode: question.answerMode,
      choices: question.choices,
      answerSchema: question.answerSchema ?? null,
      guidedConnection: question.guidedConnection ?? null,
    })),
  };
  return `sha256:${createHash("sha256").update(canonicalJson(material)).digest("hex")}`;
}

function connectionProfileFromAnswer(entry, onboarding) {
  const scopeDigest = createHash("sha256").update(canonicalJson(entry.answer.scope)).digest("hex").slice(0, 12);
  const proposed = onboarding.createProfileInput(entry.answer);
  const profile = {
    version: 1,
    id: `setup-${entry.connectorId}-${scopeDigest}`,
    connectorId: entry.connectorId,
    authorization: structuredClone(proposed.authorization),
    scope: structuredClone(proposed.scope),
    owner: proposed.owner,
    state: "authorization-required",
    lastObservedAt: null,
    freshForSeconds: 3600,
  };
  try {
    return parseConnectionProfileDocument({ version: 1, profiles: [profile] })[0];
  } catch {
    fail("connection-review-invalid", `${entry.connectorId} answer could not produce a supported reviewed profile proposal`);
  }
}

function bindConnectionReview(document, currentReviewId, preflightQuestions, onboardings) {
  if (document === null || document === undefined) {
    return freeze({ profiles: [], answeredQuestionIds: [], answeredConnectorIds: [], proposal: null });
  }
  const parsed = parseConnectionReviewDocument(document, onboardings);
  if (!currentReviewId || parsed.reviewId !== currentReviewId) {
    fail("connection-review-drift", "connection review no longer matches the current selected-source preflight");
  }
  const firstEligibleQuestion = preflightQuestions
    .find((question) => question.answerSchema && onboardings.has(question.provider));
  const profiles = [];
  for (const entry of parsed.answers) {
    if (!firstEligibleQuestion
      || firstEligibleQuestion.id !== entry.questionId
      || firstEligibleQuestion.provider !== entry.connectorId) {
      fail("connection-review-question-invalid", "connection review must answer the first current typed blocker in canonical selected-source order");
    }
    profiles.push(connectionProfileFromAnswer(entry, onboardings.get(entry.connectorId)));
  }
  const ids = new Set(profiles.map((profile) => profile.id));
  if (ids.size !== profiles.length) fail("connection-review-invalid", "connection review produced duplicate profile proposals");
  return freeze({
    profiles,
    answeredQuestionIds: parsed.answers.map((entry) => entry.questionId),
    answeredConnectorIds: parsed.answers.map((entry) => entry.connectorId),
    proposal: {
      version: 1,
      reviewId: parsed.reviewId,
      delivery: { transport: "stdout", writes: false },
      operations: profiles.map((profile) => ({ operation: "add", profile: structuredClone(profile) })),
    },
  });
}

function assertCapabilityParity(presentation) {
  for (const source of presentation.selected) {
    const contract = connectorContractRegistry.get(source.connectorId)?.contract;
    const canonical = contract && {
      setup: contract.capabilities.setup.length > 0,
      inventory: contract.capabilities.inventory.length > 0,
      evidence: contract.capabilities.evidence.length > 0,
    };
    if (!canonical || JSON.stringify(canonical) !== JSON.stringify(SETUP_RUN_CONNECTOR_SUPPORT[source.connectorId])) {
      fail("setup-run-capability-mismatch", `${source.connectorId} browser presentation does not match the canonical connector contract`);
    }
  }
}

function attentionQuestion(source, onboarding = null) {
  const type = source.status === "needs-scope"
    ? "scope"
    : source.status === "reviewed-binding-required"
      ? "binding"
      : "connection";
  const eligibleOnboarding = source.status === "needs-scope" ? onboarding : null;
  const answerSchema = eligibleOnboarding?.answerSchema ?? null;
  return freeze({
    id: `setup-run-${source.connectorId}-${source.status}`,
    type,
    phase: "preflight",
    prompt: source.reason,
    required: true,
    answerMode: answerSchema ? "typed-object" : "action",
    provider: source.connectorId,
    state: source.status,
    candidateCount: 0,
    candidateIds: [],
    candidates: [],
    choices: [{ id: answerSchema ? "open-guided-connection" : source.nextAction.id, label: eligibleOnboarding ? eligibleOnboarding.guidedCard.title : source.nextAction.label }],
    ...(answerSchema ? { answerSchema } : {}),
    ...(eligibleOnboarding ? { guidedConnection: structuredClone(eligibleOnboarding.guidedCard) } : {}),
    evidence: {
      sources: ["reviewed-redacted-connection-snapshot"],
      observedAt: { earliest: source.connection.lastObservedAt, latest: source.connection.lastObservedAt },
      validUntil: { earliest: source.connection.validUntil, latest: source.connection.validUntil },
      freshness: [source.connection.state],
      uncertainties: [source.status],
    },
  });
}

function range(values) {
  const sorted = [...new Set(values.filter(Boolean))].sort();
  return sorted.length ? { earliest: sorted[0], latest: sorted.at(-1) } : { earliest: null, latest: null };
}

function sessionQuestion(source, results) {
  const failed = results.filter((result) => result.state !== "connected");
  const statePriority = ["authorization-required", "unavailable", "stale", "unknown"];
  const state = statePriority.find((candidate) => failed.some((result) => result.state === candidate)) ?? "unknown";
  const messages = [...new Set(failed.map((result) => result.message).filter(Boolean))];
  const prompt = results.length === 1 && messages.length === 1
    ? messages[0]
    : `${failed.length} of ${results.length} bounded ${source.name} checks need attention (${[...new Set(failed.map((result) => result.state))].sort().join(", ")}).`;
  return freeze({
    id: `setup-run-${source.connectorId}-recheck`,
    type: state === "authorization-required" ? "access" : "connection",
    phase: "after-check",
    prompt,
    required: true,
    answerMode: "action",
    provider: source.connectorId,
    state,
    candidateCount: 0,
    candidateIds: [],
    candidates: [],
    choices: [{ id: state === "authorization-required" ? "reconnect" : "retry", label: state === "authorization-required" ? "Reconnect safely" : "Retry bounded check" }],
    evidence: {
      sources: [...new Set(failed.map((result) => result.evidence.source))].sort(),
      observedAt: range(failed.map((result) => result.observedAt)),
      validUntil: range(failed.map((result) => result.freshUntil)),
      freshness: [...new Set(failed.map((result) => result.state === "stale" ? "stale" : "unknown"))].sort(),
      uncertainties: [...new Set(failed.map((result) => result.state))].sort(),
    },
  });
}

function reviewQuestion(group) {
  return freeze({
    id: group.id,
    type: group.type,
    phase: group.phase,
    prompt: group.prompt,
    required: group.required,
    answerMode: group.answerMode,
    provider: group.provider,
    state: group.state,
    candidateCount: group.candidateCount,
    candidateIds: [...group.candidateIds],
    candidates: group.candidates.map((candidate) => ({ ...candidate })),
    choices: group.choices.map((choice) => ({ ...choice, ...(choice.followUp ? { followUp: [...choice.followUp] } : {}) })),
    evidence: structuredClone(group.evidence),
  });
}

function finding(item) {
  const candidate = item.candidate;
  const label = candidate?.fullName ?? candidate?.name ?? candidate?.serviceName ?? null;
  return freeze({
    candidateId: item.candidateId,
    state: item.state,
    identity: {
      provider: item.identity.provider,
      resourceType: item.identity.resourceType,
      resourceId: item.identity.resourceType === "scope" ? null : item.identity.resourceId,
    },
    label,
    reason: item.reason,
    exactMatch: item.exactMatch ? structuredClone(item.exactMatch) : null,
    possibleMatches: item.possibleMatches.map((match) => ({ ...match })),
    provenance: {
      source: item.provenance.source,
      connectorId: item.provenance.connectorId,
      observedAt: item.provenance.observedAt,
      validUntil: item.provenance.validUntil,
      freshness: item.provenance.freshness,
      uncertainty: item.provenance.uncertainty,
    },
    reviewedDecision: item.reviewedDecision ? structuredClone(item.reviewedDecision) : null,
    proposal: item.proposal ? {
      manifest: structuredClone(item.proposal.manifest),
      yaml: item.proposal.yaml,
    } : null,
  });
}

function sessionPresentation(session) {
  if (!session) return null;
  return freeze({
    sessionId: session.sessionId,
    status: session.status,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    results: session.results.map((result) => ({
      connectorId: result.connectorId,
      state: result.state,
      observedAt: result.observedAt,
      freshUntil: result.freshUntil,
      message: result.message,
      observationCount: result.evidence.observations.length,
    })),
  });
}

function planningPresentation(planning, preflight) {
  const execution = planning?.execution;
  const state = ["complete", "partial"].includes(execution?.state) ? execution.state : "unknown";
  const reason = ["local-marker-plan", "planning-deadline-exceeded", "planning-aborted"].includes(execution?.reason) ? execution.reason : "planning-unavailable";
  const deadlineMs = Number.isInteger(execution?.deadlineMs) ? execution.deadlineMs : null;
  const requestedIds = preflight.selected.map((source) => source.connectorId);
  const plannedIds = Array.isArray(planning?.connectors) ? planning.connectors.map((source) => source?.id) : null;
  const selectedOnly = planning == null || (planning.selectedOnly === true && plannedIds?.length === requestedIds.length && plannedIds.every((id, index) => id === requestedIds[index]));
  return freeze({
    readOnly: true,
    selectedOnly,
    execution: { state, reason, deadlineMs },
    sources: preflight.selected.map((source) => ({ connectorId: source.connectorId, detection: source.detection })),
  });
}

function connectorCheckState(results) {
  if (!results.length) return "not-checked";
  const states = [...new Set(results.map((result) => result.state))].sort();
  return states.length === 1 ? states[0] : "mixed";
}

function setupReviewPresentation({ preflight, sessionResultsByConnector, taskObservations, connectionQuestions, discoveryQuestions, findings, artifactId }) {
  const connectionQuestionByProvider = new Map(connectionQuestions.map((group) => [group.provider, group]));
  const taskObservationByConnector = new Map((taskObservations ?? []).map((observation) => [observation.connectorId, observation]));
  const ready = [];
  const taskOnly = [];
  const notChecked = [];
  const needsAttention = [];
  let checkedCount = 0;

  for (const source of preflight.selected) {
    const results = sessionResultsByConnector.get(source.connectorId) ?? [];
    if (results.length) checkedCount += 1;
    const taskObservation = taskObservationByConnector.get(source.connectorId) ?? null;
    if (taskObservation) checkedCount += 1;
    const question = connectionQuestionByProvider.get(source.connectorId);
    if (question) {
      const nextAction = question.choices[0] ?? source.nextAction;
      needsAttention.push({
        connectorId: source.connectorId,
        name: source.name,
        preflightStatus: source.status,
        state: question.state,
        questionGroupId: question.id,
        nextAction: { id: nextAction.id, label: nextAction.label },
        ...(question.guidedConnection ? { guidedConnection: structuredClone(question.guidedConnection) } : {}),
      });
      continue;
    }
    if (taskObservation) {
      taskOnly.push({
        connectorId: source.connectorId,
        name: source.name,
        preflightStatus: source.status,
        checked: true,
        checkState: "checked-this-task",
        observationCount: taskObservation.resourceCount,
        savedForRefresh: false,
        scopeLabel: taskObservation.scope.label,
      });
      continue;
    }
    const sourceResult = {
      connectorId: source.connectorId,
      name: source.name,
      preflightStatus: source.status,
      checked: results.length > 0,
      checkState: connectorCheckState(results),
      observationCount: results.reduce((total, result) => total + result.evidence.observations.length, 0),
    };
    if (sourceResult.checked) ready.push(sourceResult);
    else notChecked.push(sourceResult);
  }

  const exactMatches = findings.filter((entry) => entry.state === "exact-match");
  const exactMatchesByProvider = new Map();
  for (const entry of exactMatches) {
    const provider = entry.identity.provider;
    exactMatchesByProvider.set(provider, (exactMatchesByProvider.get(provider) ?? 0) + 1);
  }
  const candidateIds = new Set(discoveryQuestions.flatMap((group) => group.candidateIds));

  return freeze({
    version: 1,
    sourcePreflight: {
      selected: preflight.selected.length,
      profileReadyCount: preflight.summary.ready,
      checkedCount,
      checkedThisTaskCount: checkedCount,
      savedForRefreshCount: preflight.summary.ready,
      taskOnlyCount: taskOnly.length,
      taskOnly,
      readyCount: ready.length,
      ready,
      notCheckedCount: notChecked.length,
      notChecked,
      needsAttentionCount: needsAttention.length,
      needsAttention,
    },
    knownExactMatches: {
      count: exactMatches.length,
      hiddenFromHumanReview: true,
      byProvider: [...exactMatchesByProvider.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([provider, count]) => ({ provider, count })),
    },
    artifactReview: {
      artifactId,
      candidateCount: candidateIds.size,
      groupCount: discoveryQuestions.length,
      groupIds: discoveryQuestions.map((group) => group.id),
    },
    delivery: { transport: "stdout", writes: false },
  });
}

/** Server-side projection. Full reviewed profiles never enter the presentation. */
export function createSetupRunPreflight({ selectedConnectorIds, profileDocument = null, now, planning = null }) {
  const profiles = profileDocument === null || profileDocument === undefined
    ? []
    : [...parseConnectionProfileDocument(profileDocument)];
  const connections = profiles.length ? createConnectionSnapshot({ version: 1, profiles }) : createConnectionSnapshot();
  const presentation = createSetupRunPresentationPreflight({ selectedConnectorIds, connections, now, planning });
  assertCapabilityParity(presentation);
  const runnableConnectorIds = new Set(presentation.selected.filter((source) => source.support.setup).map((source) => source.connectorId));
  const selectedOrder = new Map(presentation.selected.map((source, index) => [source.connectorId, index]));
  const runnableProfiles = profiles.filter((profile) => runnableConnectorIds.has(profile.connectorId))
    .sort((left, right) => selectedOrder.get(left.connectorId) - selectedOrder.get(right.connectorId) || left.id.localeCompare(right.id));
  const runnableByConnector = new Set(runnableProfiles.map((profile) => profile.connectorId));
  for (const source of presentation.selected) {
    if (source.status === "needs-scope" && runnableByConnector.has(source.connectorId)) fail("setup-run-preflight-mismatch", `${source.connectorId} cannot need scope and have a runnable reviewed profile`);
    if (!source.support.setup && runnableByConnector.has(source.connectorId)) fail("setup-run-preflight-mismatch", `${source.connectorId} cannot run through a setup profile`);
  }
  return freeze({ presentation, runnableProfiles });
}

/**
 * Recheck selected setup-capable sources that have reviewed exact profiles and
 * return one read-only, artifact-bound review. Provider and catalog writes
 * remain outside this function.
 */
export async function runSetupReview(input, options = {}) {
  const now = timestamp(input?.now ?? options.now, "setup-run clock");
  const preflight = createSetupRunPreflight({
    selectedConnectorIds: input?.selectedConnectorIds,
    profileDocument: input?.profileDocument,
    planning: input?.planning ?? null,
    now,
  });
  const onboardings = createConnectionOnboardingRegistry(options.connectors);
  if (input?.connectionReviewDocument && input?.taskObservationDocument) {
    fail("setup-run-continuation-conflict", "setup-run accepts connection review or task observations in one run, not both");
  }
  const taskContinuation = bindTaskObservations(
    input?.taskObservationDocument ?? null,
    preflight,
    options.connectors,
    now,
  );
  const taskObservedConnectors = new Set(taskContinuation.connectorIds);
  const preflightConnectionQuestions = preflight.presentation.selected
    .filter((source) => ["needs-scope", "reviewed-binding-required"].includes(source.status))
    .map((source) => attentionQuestion(source, onboardings.get(source.connectorId) ?? null));
  const currentConnectionReviewId = connectionReviewId(preflightConnectionQuestions, preflight.presentation.selected);
  const reviewedContinuation = bindConnectionReview(
    input?.connectionReviewDocument ?? null,
    currentConnectionReviewId,
    preflightConnectionQuestions,
    onboardings,
  );
  const sessionProfiles = reviewedContinuation.profiles.length
    ? reviewedContinuation.profiles
    : preflight.runnableProfiles;
  if ((sessionProfiles.length || taskContinuation.document || input?.localDiscoveryDocument) && !input?.sourceCatalog) {
    fail("setup-run-catalog-required", "setup-run needs the validated source catalog when a setup session is ready");
  }
  const deadlineMs = resolveSetupRunDeadline(options.deadlineMs);
  const deadlineAt = options.deadlineAt ?? (Date.now() + deadlineMs);
  if (!Number.isFinite(deadlineAt)) fail("setup-run-deadline-invalid", "setup-run deadlineAt must be a finite runtime timestamp");
  if (options.deadlineExpired !== undefined && typeof options.deadlineExpired !== "boolean") {
    fail("setup-run-deadline-invalid", "setup-run deadlineExpired must be boolean when provided");
  }

  let session = null;
  let inbox = null;
  let timedOut = options.deadlineExpired === true;
  const controller = new AbortController();
  const externalAbort = () => controller.abort();
  if (timedOut || options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener?.("abort", externalAbort, { once: true });
  const remainingMs = Math.max(0, Math.min(deadlineMs, deadlineAt - Date.now()));
  let timeout = null;
  if (!timedOut && remainingMs === 0) {
    timedOut = true;
    controller.abort();
  } else if (!timedOut) {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, remainingMs);
  }
  try {
    if (sessionProfiles.length) {
      const profileDocument = { version: 1, profiles: sessionProfiles };
      session = await runSetupSession(profileDocument, {
        now,
        sessionId: options.sessionId ?? stableSessionId(preflight.presentation.selected.map((source) => source.connectorId), now.toISOString()),
        connectors: options.connectors,
        resolveCredential: options.resolveCredential,
        signal: controller.signal,
      });
    }
    if (session || taskContinuation.document || input?.localDiscoveryDocument) {
      const profileDocument = sessionProfiles.length ? { version: 1, profiles: sessionProfiles } : null;
      inbox = buildDiscoveryInbox(input.sourceCatalog, session, profileDocument, input?.discoveryReviewDocument ?? null, {
        now,
        projectDirectory: options.projectDirectory ?? null,
        taskObservationDocument: taskContinuation.document,
        localDiscoveryDocument: input?.localDiscoveryDocument ?? null,
      });
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    options.signal?.removeEventListener?.("abort", externalAbort);
  }

  if (Date.now() >= deadlineAt) timedOut = true;

  const sessionResultsByConnector = new Map();
  for (const result of session?.results ?? []) {
    const results = sessionResultsByConnector.get(result.connectorId) ?? [];
    results.push(result);
    sessionResultsByConnector.set(result.connectorId, results);
  }
  const connectionQuestions = [];
  const answeredConnectors = new Set(reviewedContinuation.answeredConnectorIds);
  for (const source of preflight.presentation.selected) {
    if (taskObservedConnectors.has(source.connectorId)) continue;
    if (["needs-scope", "reviewed-binding-required"].includes(source.status)) {
      if (!answeredConnectors.has(source.connectorId)) connectionQuestions.push(attentionQuestion(source, onboardings.get(source.connectorId) ?? null));
      else {
        const attempted = sessionResultsByConnector.get(source.connectorId) ?? [];
        if (!attempted.length || attempted.some((result) => result.state !== "connected")) {
          connectionQuestions.push(sessionQuestion(source, attempted.length ? attempted : [{
            state: "unknown",
            message: "The approved bounded connection check did not return a result.",
            evidence: { source: "on-demand-setup-connector" },
            observedAt: null,
            freshUntil: null,
          }]));
        }
      }
      continue;
    }
    const attempted = sessionResultsByConnector.get(source.connectorId) ?? [];
    if (attempted.length && attempted.some((result) => result.state !== "connected")) {
      connectionQuestions.push(sessionQuestion(source, attempted));
    }
  }
  const discoveryQuestions = inbox?.questionGroups.map(reviewQuestion) ?? [];
  const questionGroups = [...new Map([...connectionQuestions, ...discoveryQuestions].map((group) => [group.id, group])).values()];
  const findings = inbox?.items.map(finding) ?? [];
  const presentation = setupReviewPresentation({
    preflight: preflight.presentation,
    sessionResultsByConnector,
    taskObservations: taskContinuation.document?.observations ?? [],
    connectionQuestions,
    discoveryQuestions,
    findings,
    artifactId: inbox?.artifactId ?? null,
  });
  const planning = planningPresentation(input?.planning, preflight.presentation);
  const result = {
    version: 1,
    command: "setup-run",
    readOnly: true,
    persistent: false,
    selectedOnly: planning.selectedOnly,
    execution: {
      state: timedOut || controller.signal.aborted || questionGroups.length ? "review-required" : "complete",
      reason: timedOut ? "overall-deadline-exceeded" : options.signal?.aborted ? "aborted" : "bounded-review",
      deadlineMs,
      timedOut,
    },
    safety: {
      providerMutations: false,
      catalogWrites: false,
      credentialValuesReturned: false,
      credentialValuesPersisted: false,
      taskObservationWrites: false,
      taskObservationProfilesCreated: false,
      taskObservationExactMatchesAllowed: false,
      privateScopeReturned: reviewedContinuation.proposal !== null,
      privateScopeReturnedOnlyAsReviewedProposal: reviewedContinuation.proposal !== null,
    },
    planning,
    preflight: preflight.presentation,
    taskObservations: {
      version: 1,
      eligible: taskContinuation.eligible,
      checkedThisTask: (taskContinuation.document?.observations ?? []).map((observation) => ({
        connectorId: observation.connectorId,
        bridgeId: observation.bridgeId,
        state: "checked-this-task",
        savedForRefresh: false,
        scopeLabel: observation.scope.label,
        resourceCount: observation.resourceCount,
        observedAt: observation.observedAt,
        validUntil: observation.validUntil,
      })),
    },
    session: sessionPresentation(session),
    connectionProfileProposals: reviewedContinuation.proposal,
    review: {
      artifactId: inbox?.artifactId ?? null,
      connectionReviewId: currentConnectionReviewId,
      presentation,
      summary: {
        findings: findings.length,
        questions: questionGroups.length,
        connectionQuestions: connectionQuestions.length,
        candidateQuestions: discoveryQuestions.length,
      },
      questionGroups,
      findings,
    },
  };
  return freeze(result);
}

export function formatSetupReview(result) {
  const presentation = result.review.presentation;
  if (!presentation) {
    return `${result.preflight.summary.ready} of ${result.preflight.summary.selected} sources are ready.`;
  }

  const artifactGroupIds = new Set(presentation.artifactReview.groupIds);
  const connectionGroups = result.review.questionGroups.filter((group) => !artifactGroupIds.has(group.id));
  const taskOnly = presentation.sourcePreflight.taskOnly ?? [];
  const progress = taskOnly.length
    ? `${presentation.sourcePreflight.checkedThisTaskCount} of ${presentation.sourcePreflight.selected} sources checked for this task; ${presentation.sourcePreflight.savedForRefreshCount} saved for refresh, ${presentation.sourcePreflight.taskOnlyCount} task-only.`
    : `${presentation.sourcePreflight.readyCount} of ${presentation.sourcePreflight.selected} sources are ready.`;
  const taskLines = taskOnly.map((source) => `${source.name} · ${source.scopeLabel} · ${source.observationCount} ${source.observationCount === 1 ? "resource" : "resources"} checked for this task (not saved).`);
  if (connectionGroups.length) {
    const first = connectionGroups[0];
    const card = first.guidedConnection ?? null;
    const source = presentation.sourcePreflight.needsAttention.find((entry) => entry.questionGroupId === first.id) ?? null;
    const actions = card?.actions ?? first.choices.map((choice) => ({ label: choice.label, description: "Continue with this reviewed action." }));
    const lines = [
      progress,
      ...taskLines,
      `Next: connect ${presentation.sourcePreflight.needsAttentionCount} ${presentation.sourcePreflight.needsAttentionCount === 1 ? "source" : "sources"}.`,
      "",
      card?.title ?? `Connect ${source?.name ?? "the next source"}`,
      `What you need: ${card?.description ?? `Review the connection needed for ${source?.name ?? "this source"}.`}`,
      "Why: DevHub needs this reviewed choice before it can run a bounded read-only check.",
      "Actions:",
      ...actions.slice(0, 3).map((action) => `- ${action.label}: ${action.description}`),
    ];
    return lines.join("\n");
  }

  const findings = result.review.findings ?? [];
  const possible = findings.filter((entry) => entry.state === "possible-match").length;
  const fresh = findings.filter((entry) => entry.state === "new").length;
  return [
    progress,
    ...taskLines,
    `${presentation.knownExactMatches.count} known resources matched. ${possible} possible ${possible === 1 ? "match needs" : "matches need"} review. ${fresh} new ${fresh === 1 ? "item" : "items"} found.`,
  ].join("\n");
}
