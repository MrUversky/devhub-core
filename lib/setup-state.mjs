import { createHash } from "node:crypto";

import { validateNormalizedInventoryResult } from "./inventory-adapters.mjs";
import { parseConnectionProfileDocument } from "./setup-session.mjs";

const CONNECTION_STATES = new Set(["authorization-required", "connected", "unavailable", "stale", "unknown"]);
const REFRESH_KINDS = Object.freeze(["new", "changed", "stale", "unclear"]);
const MAX_INPUT_BYTES = 1024 * 1024;
const SECRET_LITERAL = /(?:\bgh[pousr]_[A-Za-z0-9]{16,}\b|\bgithub_pat_[A-Za-z0-9_]{16,}\b|\bsk-[A-Za-z0-9_-]{20,}\b|\b(?:bearer|basic)\s+[A-Za-z0-9._~+/-]{8,}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/i;

export class SetupStateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SetupStateError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new SetupStateError(code, message);
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function immutable(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) immutable(child);
  }
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

function exactFields(value, fields, label) {
  for (const key of Object.keys(value)) if (!fields.has(key)) fail("invalid-setup-session", `${label}.${key} is not supported`);
}

function boundedInput(value, label, maximum = MAX_INPUT_BYTES) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    fail("invalid-setup-state", `${label} must contain acyclic JSON data only`);
  }
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > maximum) {
    fail("invalid-setup-state", `${label} exceeds the ${maximum}-byte input limit`);
  }
  if (SECRET_LITERAL.test(serialized)) fail("unsafe-setup-state", `${label} appears to contain secret material`);
}

function digest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function timestamp(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string") fail("invalid-setup-state", `${label} must be an ISO 8601 UTC timestamp`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    fail("invalid-setup-state", `${label} must be an ISO 8601 UTC timestamp`);
  }
  return value;
}

function safeString(value, label, maximum = 500) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    fail("invalid-setup-state", `${label} must be a non-empty string of at most ${maximum} characters`);
  }
  if (SECRET_LITERAL.test(value)) fail("unsafe-setup-state", `${label} appears to contain secret material`);
  return value.trim();
}

function asNow(value) {
  const now = new Date(value ?? Date.now());
  if (!Number.isFinite(now.getTime())) fail("invalid-now", "setup state requires a valid now value");
  return now;
}

function profileFingerprint(profile) {
  return digest({
    version: profile.version,
    id: profile.id,
    connectorId: profile.connectorId,
    scope: profile.scope,
    authorization: profile.authorization,
    owner: profile.owner,
    freshForSeconds: profile.freshForSeconds,
  });
}

function parseProfilesAllowEmpty(value) {
  if (value === undefined || value === null) return [];
  boundedInput(value, "profileDocument", 256 * 1024);
  if (plainObject(value) && value.version === 1 && Array.isArray(value.profiles) && value.profiles.length === 0) {
    if (Object.keys(value).some((key) => !new Set(["version", "profiles"]).has(key))) fail("invalid-setup-state", "empty profile document contains unsupported fields");
    return [];
  }
  return [...parseConnectionProfileDocument(value)];
}

function parseProfiles(value) {
  boundedInput(value, "profileDocument", 256 * 1024);
  return [...parseConnectionProfileDocument(value)];
}

function safeUrl(value, label, hostname = null) {
  const text = safeString(value, label, 2_048);
  let parsed;
  try { parsed = new URL(text); } catch { fail("invalid-setup-session", `${label} must be an absolute safe URL`); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || (hostname && parsed.hostname !== hostname)) {
    fail("invalid-setup-session", `${label} must be an expected credential-free HTTPS URL`);
  }
  if ([...parsed.searchParams.keys()].some((key) => /token|secret|key|auth|signature/i.test(key))) {
    fail("unsafe-setup-state", `${label} contains a secret-bearing query parameter`);
  }
  return text;
}

function simpleId(value, label, maximum = 300) {
  const result = safeString(value, label, maximum);
  if (/\s/.test(result)) fail("invalid-setup-session", `${label} must not contain whitespace`);
  return result;
}

function validateObservation(observation, profile, label) {
  if (!plainObject(observation)) fail("invalid-setup-session", `${label} must be an object`);
  const kind = safeString(observation.kind, `${label}.kind`, 100);
  if (kind === "normalized-provider-inventory") {
    exactFields(observation, new Set(["kind", "formatVersion", "source", "execution", "freshness", "candidates"]), label);
    let normalized;
    try {
      normalized = validateNormalizedInventoryResult({
        formatVersion: observation.formatVersion,
        source: observation.source,
        execution: observation.execution,
        freshness: observation.freshness,
        candidates: observation.candidates,
      });
    } catch {
      fail("invalid-setup-session", `${label} is not a valid normalized provider inventory result`);
    }
    if (normalized.source.provider !== profile.connectorId || canonicalJson(normalized.source.scope) !== canonicalJson(profile.scope)) {
      fail("connection-profile-drift", `${label} provider or exact scope does not match the reviewed connection profile`);
    }
    return immutable({ kind, ...structuredClone(normalized) });
  }

  if (kind === "account-identity") {
    exactFields(observation, new Set(["kind", "provider", "providerId", "login", "accountKind"]), label);
    if (observation.provider !== profile.connectorId || !["user", "bot"].includes(observation.accountKind)) fail("invalid-setup-session", `${label} account identity does not match the connector`);
    return immutable({ kind, provider: observation.provider, providerId: simpleId(observation.providerId, `${label}.providerId`), login: simpleId(observation.login, `${label}.login`, 100), accountKind: observation.accountKind });
  }
  if (kind === "reviewed-scope") {
    exactFields(observation, new Set(["kind", "provider", "providerId", "login", "scopeKind"]), label);
    if (observation.provider !== profile.connectorId || observation.login !== profile.scope.login || observation.scopeKind !== profile.scope.kind) fail("connection-profile-drift", `${label} does not match the exact reviewed scope`);
    return immutable({ kind, provider: observation.provider, providerId: simpleId(observation.providerId, `${label}.providerId`), login: simpleId(observation.login, `${label}.login`, 100), scopeKind: simpleId(observation.scopeKind, `${label}.scopeKind`, 40) });
  }
  if (kind === "repository-candidate") {
    exactFields(observation, new Set(["kind", "provider", "providerId", "owner", "name", "fullName", "url", "visibility", "archived", "disabled", "access", "ownership", "identity"]), label);
    if (observation.provider !== profile.connectorId || !plainObject(observation.identity)
      || canonicalJson(Object.keys(observation.identity).sort()) !== canonicalJson(["name", "owner", "provider"])
      || observation.identity.provider !== observation.provider || observation.identity.owner !== observation.owner || observation.identity.name !== observation.name
      || observation.fullName !== `${observation.owner}/${observation.name}`
      || typeof observation.archived !== "boolean" || typeof observation.disabled !== "boolean"
      || !["public", "private", "internal"].includes(observation.visibility)
      || !["admin", "write", "read", "unknown"].includes(observation.access) || observation.ownership !== "unknown") {
      fail("invalid-setup-session", `${label} is not a strict repository candidate`);
    }
    safeUrl(observation.url, `${label}.url`, "github.com");
    simpleId(observation.providerId, `${label}.providerId`);
    simpleId(observation.owner, `${label}.owner`, 100);
    simpleId(observation.name, `${label}.name`, 100);
    return immutable(structuredClone(observation));
  }
  if (kind === "provider-limitation") {
    const withSummary = Object.hasOwn(observation, "summary");
    exactFields(observation, new Set(withSummary
      ? ["kind", "provider", "code", "state", "summary"]
      : ["kind", "provider", "code", "state", "nextActionId"]), label);
    if (observation.provider !== profile.connectorId || !["unknown", "observed"].includes(observation.state)) fail("invalid-setup-session", `${label} is not a strict provider limitation`);
    simpleId(observation.code, `${label}.code`, 100);
    if (withSummary) safeString(observation.summary, `${label}.summary`);
    else simpleId(observation.nextActionId, `${label}.nextActionId`, 100);
    return immutable(structuredClone(observation));
  }
  if (kind === "exact-evidence-capability") {
    exactFields(observation, new Set(["kind", "provider", "adapterId", "check", "state"]), label);
    if (observation.provider !== profile.connectorId || observation.state !== "requires-reviewed-identity") fail("invalid-setup-session", `${label} is not a strict evidence capability`);
    simpleId(observation.adapterId, `${label}.adapterId`, 100);
    simpleId(observation.check, `${label}.check`, 100);
    return immutable(structuredClone(observation));
  }
  if (kind === "host-identity") {
    exactFields(observation, new Set(["kind", "id", "name", "hostKind", "location", "identitySource", "identityVerified"]), label);
    if (observation.id !== profile.scope.hostId || observation.identityVerified !== false || observation.identitySource !== "reviewed-connection-profile") fail("connection-profile-drift", `${label} does not match the reviewed local host`);
    return immutable(structuredClone(observation));
  }
  if (kind === "project-repository") {
    exactFields(observation, new Set(["kind", "projectId", "hostId", "source", "repository"]), label);
    if (profile.connectorId !== "local-host" || observation.hostId !== profile.scope.hostId || observation.source !== "git-origin"
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(observation.projectId)
      || !plainObject(observation.repository)
      || canonicalJson(Object.keys(observation.repository).sort()) !== canonicalJson(["name", "owner", "provider"])
      || observation.repository.provider !== "github"
      || !/^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(observation.repository.owner)
      || !/^[a-z0-9._-]{1,100}$/.test(observation.repository.name)) {
      fail("connection-profile-drift", `${label} is not a canonical repository identity for the exact reviewed local host`);
    }
    return immutable(structuredClone(observation));
  }
  if (kind === "inspection-source") {
    exactFields(observation, new Set(["kind", "type", "available", "timedOut", "observations"]), label);
    if (typeof observation.available !== "boolean" || (observation.timedOut !== undefined && typeof observation.timedOut !== "boolean") || !Number.isSafeInteger(observation.observations) || observation.observations < 0) fail("invalid-setup-session", `${label} is not a strict inspection source`);
    simpleId(observation.type, `${label}.type`, 100);
    return immutable(structuredClone(observation));
  }
  if (kind === "service-runtime" || kind === "service-runtime-unknown") {
    const common = ["kind", "projectId", "projectTitle", "serviceId", "serviceName", "runtime", "mode"];
    const extra = kind === "service-runtime"
      ? ["source", "identifier", "state", "definition", "activeState", "subState", "unitFileState", "definitionPresent", "loaded", "containersObserved"]
      : ["reason", "message"];
    exactFields(observation, new Set([...common, ...extra]), label);
    for (const field of ["projectId", "serviceId", "runtime", "mode"]) simpleId(observation[field], `${label}.${field}`, 100);
    safeString(observation.projectTitle, `${label}.projectTitle`, 300);
    safeString(observation.serviceName, `${label}.serviceName`, 300);
    if (kind === "service-runtime") {
      simpleId(observation.source, `${label}.source`, 100);
      safeString(observation.identifier, `${label}.identifier`, 300);
      if (!["running", "stopped", "failed", "unknown"].includes(observation.state)) fail("invalid-setup-session", `${label}.state is invalid`);
    } else {
      simpleId(observation.reason, `${label}.reason`, 100);
      safeString(observation.message, `${label}.message`);
    }
    return immutable(structuredClone(observation));
  }
  fail("invalid-setup-session", `${label}.kind is not allowlisted`);
}

function validateSession(input, profiles, nowInput) {
  const now = asNow(nowInput);
  boundedInput(input, "session");
  if (!plainObject(input) || input.version !== 1 || input.command !== "setup-session" || input.readOnly !== true || input.persistent !== false) {
    fail("invalid-setup-session", "setup state requires a read-only setup-session v1 result");
  }
  exactFields(input, new Set(["version", "command", "sessionId", "startedAt", "completedAt", "status", "readOnly", "persistent", "safety", "results"]), "session");
  const sessionId = safeString(input.sessionId, "session.sessionId", 200);
  const startedAt = timestamp(input.startedAt, "session.startedAt");
  const completedAt = timestamp(input.completedAt, "session.completedAt");
  if (new Date(startedAt) > new Date(completedAt) || new Date(completedAt) > now) fail("invalid-setup-session", "session timestamps must be ordered and not in the future");
  if (!new Set(["complete", "review-required"]).has(input.status)) fail("invalid-setup-session", "session.status is invalid");
  if (!plainObject(input.safety)) fail("invalid-setup-session", "session.safety must be an object");
  exactFields(input.safety, new Set(["catalogWrites", "providerMutations", "credentialValuesReturned", "browserExecution", "residentProcess"]), "session.safety");
  if (Object.values(input.safety).some((value) => value !== false)) fail("invalid-setup-session", "session safety boundary must remain false for every mutation or persistence field");
  if (!Array.isArray(input.results) || input.results.length > 50) fail("invalid-setup-session", "session.results must contain at most 50 items");
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const seen = new Set();
  const results = input.results.map((result, index) => {
    const label = `session.results[${index}]`;
    if (!plainObject(result)) fail("invalid-setup-session", `${label} must be an object`);
    exactFields(result, new Set(["profileId", "connectorId", "state", "observedAt", "freshUntil", "reviewedConnection", "evidence", "message"]), label);
    const profileId = safeString(result.profileId, `${label}.profileId`, 100);
    if (seen.has(profileId)) fail("invalid-setup-session", `session duplicates profile ${profileId}`);
    seen.add(profileId);
    const profile = profileById.get(profileId);
    if (!profile) fail("invalid-setup-session", `${label} does not match a reviewed connection profile`);
    if (result.connectorId !== profile.connectorId || !CONNECTION_STATES.has(result.state)) {
      fail("invalid-setup-session", `${label} connector or state does not match the reviewed profile`);
    }
    if (!plainObject(result.reviewedConnection)) fail("invalid-setup-session", `${label}.reviewedConnection must be an object`);
    exactFields(result.reviewedConnection, new Set(["scope", "owner", "authorization", "priorState", "priorObservedAt"]), `${label}.reviewedConnection`);
    if (canonicalJson(result.reviewedConnection.scope) !== canonicalJson(profile.scope)
      || canonicalJson(result.reviewedConnection.authorization) !== canonicalJson(profile.authorization)
      || result.reviewedConnection.owner !== profile.owner
      || result.reviewedConnection.priorState !== profile.state
      || result.reviewedConnection.priorObservedAt !== profile.lastObservedAt) {
      fail("connection-profile-drift", `${label} changed the reviewed scope, owner or authorization reference`);
    }
    const observedAt = result.observedAt === null ? null : timestamp(result.observedAt, `${label}.observedAt`);
    const freshUntil = result.freshUntil === null ? null : timestamp(result.freshUntil, `${label}.freshUntil`);
    if ((observedAt === null) !== (freshUntil === null)) fail("invalid-setup-session", `${label} freshness timestamps must both be present or null`);
    if (observedAt && new Date(observedAt) > new Date(completedAt)) fail("invalid-setup-session", `${label}.observedAt must not be later than session.completedAt`);
    if (observedAt) {
      const expectedFreshUntil = new Date(new Date(observedAt).getTime() + profile.freshForSeconds * 1_000).toISOString();
      if (freshUntil !== expectedFreshUntil) fail("invalid-setup-session", `${label}.freshUntil must equal observedAt plus the reviewed freshness lifetime`);
    }
    if (["connected", "stale"].includes(result.state) && observedAt === null) fail("invalid-setup-session", `${label} connected or stale state requires an observation time`);
    if (!plainObject(result.evidence)) fail("invalid-setup-session", `${label}.evidence must be an object`);
    exactFields(result.evidence, new Set(["source", "observations"]), `${label}.evidence`);
    if (!new Set(["reviewed-connection-profile", "on-demand-setup-connector"]).has(result.evidence.source)) fail("invalid-setup-session", `${label}.evidence.source is not trusted`);
    const observations = result.evidence.observations;
    if (!Array.isArray(observations) || observations.length > 500 || observations.some((item) => !plainObject(item))) {
      fail("invalid-setup-session", `${label} must contain bounded object observations`);
    }
    if (Buffer.byteLength(JSON.stringify(observations), "utf8") > 512 * 1024) fail("invalid-setup-session", `${label} observations exceed the byte limit`);
    if (SECRET_LITERAL.test(JSON.stringify(observations))) fail("unsafe-setup-state", `${label} contains secret material`);
    const normalizedObservations = observations.map((observation, observationIndex) => validateObservation(observation, profile, `${label}.evidence.observations[${observationIndex}]`));
    return immutable({
      profile,
      profileId,
      connectorId: profile.connectorId,
      state: result.state,
      observedAt,
      freshUntil,
      observations: normalizedObservations,
      message: result.message === null ? null : safeString(result.message, `${label}.message`),
    });
  });
  return immutable({ sessionId, startedAt, completedAt, status: input.status, results });
}

export function validateSetupSessionArtifact(sessionInput, profileInput, options = {}) {
  const profiles = parseProfiles(profileInput);
  return validateSession(sessionInput, profiles, options.now);
}

function effectiveState(result, now) {
  if (result.state !== "connected") return result.state;
  if (!result.freshUntil || new Date(result.freshUntil) <= now) return "stale";
  return "connected";
}

function parseAvailabilityReviews(value, profiles, session, now) {
  if (value === undefined || value === null) return [];
  boundedInput(value, "availabilityReview", 256 * 1024);
  if (!plainObject(value) || value.version !== 1 || !Array.isArray(value.decisions) || value.decisions.length > 50) {
    fail("invalid-availability-review", "availability review must be a version 1 document with at most 50 decisions");
  }
  for (const key of Object.keys(value)) if (!new Set(["version", "decisions"]).has(key)) fail("invalid-availability-review", `availabilityReview.${key} is not supported`);
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const resultById = new Map(session.results.map((result) => [result.profileId, result]));
  const seen = new Set();
  return value.decisions.map((decision, index) => {
    const label = `availabilityReview.decisions[${index}]`;
    if (!plainObject(decision) || decision.disposition !== "accepted-unavailable") {
      fail("invalid-availability-review", `${label} must be an accepted-unavailable decision`);
    }
    for (const key of Object.keys(decision)) {
      if (!new Set(["profileId", "disposition", "sessionId", "connectorId", "profileFingerprint", "reviewedAt", "reviewedBy", "reason"]).has(key)) {
        fail("invalid-availability-review", `${label}.${key} is not supported`);
      }
    }
    const profileId = safeString(decision.profileId, `${label}.profileId`, 100);
    if (seen.has(profileId)) fail("invalid-availability-review", `${label} duplicates profile ${profileId}`);
    seen.add(profileId);
    const profile = profileById.get(profileId);
    const result = resultById.get(profileId);
    if (!profile || !result || result.state !== "unavailable") {
      fail("invalid-availability-review", `${label} requires an unavailable result for the reviewed profile`);
    }
    if (decision.sessionId !== session.sessionId || decision.connectorId !== profile.connectorId) {
      fail("invalid-availability-review", `${label} does not match the reviewed session and connector`);
    }
    if (decision.profileFingerprint !== profileFingerprint(profile)) {
      fail("connection-profile-drift", `${label} does not match the reviewed scope or authorization reference`);
    }
    const reviewedAt = timestamp(decision.reviewedAt, `${label}.reviewedAt`);
    if (new Date(reviewedAt) < new Date(session.completedAt) || new Date(reviewedAt) > now) {
      fail("invalid-availability-review", `${label}.reviewedAt must be between session completion and evaluation time`);
    }
    const reviewedBy = safeString(decision.reviewedBy, `${label}.reviewedBy`, 200);
    const reason = safeString(decision.reason, `${label}.reason`, 500);
    return immutable({ profileId, disposition: "accepted-unavailable", sessionId: session.sessionId, connectorId: profile.connectorId, profileFingerprint: decision.profileFingerprint, reviewedAt, reviewedBy, reason });
  });
}

export function createUnavailableAcceptance(profileInput, sessionInput, options = {}) {
  const profiles = parseProfiles(profileInput);
  if (profiles.length !== 1) fail("invalid-availability-review", "createUnavailableAcceptance requires exactly one reviewed profile");
  const reviewedAt = timestamp(options.reviewedAt, "reviewedAt");
  const session = validateSession(sessionInput, profiles, reviewedAt);
  const profile = profiles[0];
  const result = session.results.find((item) => item.profileId === profile.id);
  if (!result || result.state !== "unavailable") fail("invalid-availability-review", "only an unavailable setup result can be explicitly accepted");
  return immutable({
    profileId: profile.id,
    disposition: "accepted-unavailable",
    sessionId: session.sessionId,
    connectorId: profile.connectorId,
    profileFingerprint: profileFingerprint(profile),
    reviewedAt,
    reviewedBy: safeString(options.reviewedBy, "reviewedBy", 200),
    reason: safeString(options.reason, "reason", 500),
  });
}

function resultSummary(result) {
  const kinds = {};
  for (const observation of result.observations) {
    const kind = typeof observation.kind === "string" ? observation.kind : "unknown";
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  return { observations: result.observations.length, kinds };
}

function summarizeDiscoveryInbox(inbox) {
  if (inbox === undefined || inbox === null) return null;
  if (!plainObject(inbox) || inbox.version !== 1 || inbox.command !== "discovery-inbox" || !plainObject(inbox.summary) || !Array.isArray(inbox.items) || !Array.isArray(inbox.questionGroups)) {
    fail("invalid-discovery-inbox", "discovery inbox must expose its versioned summary and items");
  }
  const unresolvedStates = new Set(["possible-match", "new", "unknown"]);
  const reviewRequired = inbox.items.filter((item) => item?.reviewRequired === true || unresolvedStates.has(item?.state)).length;
  const unansweredRequiredQuestions = inbox.summary.unansweredRequiredCandidateQuestions;
  const unansweredRequiredQuestionGroups = inbox.summary.unansweredRequiredQuestions;
  const proposals = inbox.summary.proposals;
  if (!Number.isSafeInteger(unansweredRequiredQuestions) || unansweredRequiredQuestions < 0 || !Number.isSafeInteger(unansweredRequiredQuestionGroups) || unansweredRequiredQuestionGroups < 0 || !Number.isSafeInteger(proposals) || proposals < 0) {
    fail("invalid-discovery-inbox", "discovery inbox summary counts must be non-negative integers");
  }
  const pending = reviewRequired + unansweredRequiredQuestions + proposals;
  return { items: inbox.items.length, reviewRequired, unansweredRequiredQuestions, unansweredRequiredQuestionGroups, proposals, state: pending === 0 ? "reviewed" : "review-required" };
}

export function evaluateSetupState(profileInput, sessionInput, options = {}) {
  const now = asNow(options.now);
  const profiles = parseProfilesAllowEmpty(profileInput);
  if (profiles.length === 0) {
    return immutable({
      version: 1,
      command: "setup-state",
      evaluatedAt: now.toISOString(),
      status: "not-started",
      setupComplete: false,
      reason: "Setup requires at least one reviewed connection profile and cannot be inferred from catalog presence.",
      connections: [],
      discovery: summarizeDiscoveryInbox(options.discoveryInbox),
      nextActions: ["connect-another-source"],
      safety: { catalogPresenceUsed: false, catalogWrites: false, providerMutations: false, backgroundSync: false },
    });
  }
  const session = validateSession(sessionInput, profiles, now);
  const reviews = parseAvailabilityReviews(options.availabilityReview, profiles, session, now);
  const reviewByProfile = new Map(reviews.map((review) => [review.profileId, review]));
  const resultByProfile = new Map(session.results.map((result) => [result.profileId, result]));
  const connections = profiles.map((profile) => {
    const result = resultByProfile.get(profile.id) ?? null;
    const state = result ? effectiveState(result, now) : "unknown";
    const acceptance = reviewByProfile.get(profile.id) ?? null;
    const qualifies = state === "connected" || (state === "unavailable" && acceptance !== null);
    return immutable({
      profileId: profile.id,
      connectorId: profile.connectorId,
      reviewedScope: structuredClone(profile.scope),
      owner: profile.owner,
      authorization: structuredClone(profile.authorization),
      state,
      lastSync: result?.observedAt ?? null,
      freshness: state === "connected" ? "fresh" : state === "stale" ? "stale" : "unknown",
      resultSummary: result ? resultSummary(result) : { observations: 0, kinds: {} },
      acceptedUnavailable: acceptance,
      qualifiesForCompletion: qualifies,
    });
  }).sort((left, right) => left.profileId.localeCompare(right.profileId));
  const discovery = summarizeDiscoveryInbox(options.discoveryInbox);
  const connectionsComplete = connections.length > 0 && connections.every((connection) => connection.qualifiesForCompletion);
  const complete = connectionsComplete && (discovery === null || discovery.state === "reviewed");
  return immutable({
    version: 1,
    command: "setup-state",
    evaluatedAt: now.toISOString(),
    status: complete ? "complete" : connections.length ? "review-required" : "not-started",
    setupComplete: complete,
    reason: complete
      ? "Every reviewed connection has a fresh observation or an explicitly reviewed unavailable decision."
      : "Setup requires a fresh connected observation or an explicitly reviewed unavailable decision for every reviewed connection.",
    connections,
    discovery,
    nextActions: complete
      ? ["refresh-my-devhub", "connect-another-source"]
      : ["review-connections", "connect-another-source"],
    safety: { catalogPresenceUsed: false, catalogWrites: false, providerMutations: false, backgroundSync: false },
  });
}

function knownObservationIdentity(profileId, connectorId, observation) {
  const provider = typeof observation.provider === "string" ? observation.provider : connectorId;
  if (plainObject(observation.identity)
    && typeof observation.identity.provider === "string"
    && typeof observation.identity.resourceType === "string"
    && typeof observation.identity.resourceId === "string") {
    return { profileId, provider: observation.identity.provider, resourceType: observation.identity.resourceType, resourceId: observation.identity.resourceId };
  }
  const shapes = {
    "account-identity": ["account", observation.providerId],
    "reviewed-scope": ["scope", observation.providerId],
    "repository-candidate": ["repository", observation.providerId],
    "provider-limitation": ["limitation", observation.code],
    "exact-evidence-capability": ["evidence-capability", `${observation.adapterId ?? ""}:${observation.check ?? ""}`],
    "host-identity": ["host", observation.id],
    "project-repository": ["project-repository", `${observation.hostId ?? ""}:${observation.projectId ?? ""}:${observation.repository?.provider ?? ""}:${observation.repository?.owner ?? ""}/${observation.repository?.name ?? ""}`],
    "service-runtime": ["service-instance", `${observation.projectId ?? ""}:${observation.serviceId ?? ""}`],
    "service-runtime-unknown": ["service-instance", `${observation.projectId ?? ""}:${observation.serviceId ?? ""}`],
    "inspection-source": ["inspection-source", observation.type],
  };
  const selected = shapes[observation.kind];
  if (!selected || typeof selected[1] !== "string" || !selected[1] || selected[1] === ":") return null;
  return { profileId, provider, resourceType: selected[0], resourceId: selected[1] };
}

function semanticObservation(value) {
  const ignored = new Set(["observedAt", "validUntil", "freshness", "evaluatedAt"]);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !ignored.has(key)));
}

function flattenObservations(result) {
  const resources = [];
  const unidentified = [];
  for (const observation of result.observations) {
    if (observation.kind === "normalized-provider-inventory" && Array.isArray(observation.candidates)) {
      for (const candidate of observation.candidates) {
        if (!plainObject(candidate) || typeof candidate.provider !== "string" || typeof candidate.resourceType !== "string" || typeof candidate.resourceId !== "string") {
          unidentified.push(observation);
          continue;
        }
        resources.push({
          identity: { profileId: result.profileId, provider: candidate.provider, resourceType: candidate.resourceType, resourceId: candidate.resourceId },
          value: candidate,
          stale: candidate.freshness === "stale" || observation.freshness?.state === "stale",
        });
      }
      continue;
    }
    const identity = knownObservationIdentity(result.profileId, result.connectorId, observation);
    if (!identity) unidentified.push(observation);
    else resources.push({ identity, value: observation, stale: false });
  }
  return { resources, unidentified };
}

function identityKey(identity) {
  return `${identity.profileId}\u0000${identity.provider}\u0000${identity.resourceType}\u0000${identity.resourceId}`;
}

function refreshItem(kind, identity, reason, observation = null) {
  return { kind, identity: structuredClone(identity), reason, observation: observation ? structuredClone(observation) : null };
}

export function compareSetupRefresh(profileInput, previousSessionInput, currentSessionInput, options = {}) {
  const now = asNow(options.now);
  const profiles = parseProfiles(profileInput);
  const previous = validateSession(previousSessionInput, profiles, now);
  const current = validateSession(currentSessionInput, profiles, now);
  const priorByProfile = new Map(previous.results.map((result) => [result.profileId, result]));
  const currentByProfile = new Map(current.results.map((result) => [result.profileId, result]));
  const items = [];
  let unchanged = 0;

  for (const profile of profiles) {
    const before = priorByProfile.get(profile.id);
    const after = currentByProfile.get(profile.id);
    if (!before || !after) {
      items.push(refreshItem("unclear", { profileId: profile.id, provider: profile.connectorId, resourceType: "scope", resourceId: profile.id }, "The refresh did not contain both observations for this reviewed connection."));
      continue;
    }
    const previousFlat = flattenObservations(before);
    const currentFlat = flattenObservations(after);
    if (new Set(previousFlat.resources.map((resource) => identityKey(resource.identity))).size !== previousFlat.resources.length
      || new Set(currentFlat.resources.map((resource) => identityKey(resource.identity))).size !== currentFlat.resources.length) {
      fail("invalid-setup-session", `setup observations duplicate an exact resource identity for profile ${profile.id}`);
    }
    const beforeByIdentity = new Map(previousFlat.resources.map((resource) => [identityKey(resource.identity), resource]));
    const seen = new Set();
    const state = effectiveState(after, now);
    if (state !== "connected" && state !== "stale") {
      const previousResources = previousFlat.resources.length ? previousFlat.resources : [{ identity: { profileId: profile.id, provider: profile.connectorId, resourceType: "scope", resourceId: profile.id }, value: null }];
      for (const resource of previousResources) items.push(refreshItem("unclear", resource.identity, `The refreshed connection is ${state}; no resource absence or deletion was inferred.`, resource.value));
      continue;
    }
    for (const resource of currentFlat.resources) {
      const key = identityKey(resource.identity);
      seen.add(key);
      if (state === "stale" || resource.stale) {
        items.push(refreshItem("stale", resource.identity, "The refreshed observation is stale and cannot update reviewed facts.", resource.value));
        continue;
      }
      const prior = beforeByIdentity.get(key);
      if (!prior) items.push(refreshItem("new", resource.identity, "A fresh identity appeared inside the same reviewed connection scope.", resource.value));
      else if (canonicalJson(semanticObservation(prior.value)) !== canonicalJson(semanticObservation(resource.value))) {
        items.push(refreshItem("changed", resource.identity, "Meaningful normalized metadata changed for this exact identity.", resource.value));
      } else unchanged += 1;
    }
    for (const resource of previousFlat.resources) {
      if (!seen.has(identityKey(resource.identity))) items.push(refreshItem("unclear", resource.identity, "A previously observed identity was not returned. Absence does not prove deletion, non-use or safe cleanup.", resource.value));
    }
    if (currentFlat.unidentified.length) {
      items.push(refreshItem("unclear", { profileId: profile.id, provider: profile.connectorId, resourceType: "unidentified-observation", resourceId: digest(currentFlat.unidentified) }, "The connector returned observations without a stable provider identity; they require review."));
    }
  }
  const order = new Map(REFRESH_KINDS.map((kind, index) => [kind, index]));
  items.sort((left, right) => order.get(left.kind) - order.get(right.kind) || identityKey(left.identity).localeCompare(identityKey(right.identity)));
  const summary = Object.fromEntries(REFRESH_KINDS.map((kind) => [kind, items.filter((item) => item.kind === kind).length]));
  summary.unchanged = unchanged;
  return immutable({
    version: 1,
    command: "refresh-my-devhub",
    generatedAt: now.toISOString(),
    previousSessionId: previous.sessionId,
    currentSessionId: current.sessionId,
    readOnly: true,
    reusedReviewedConnections: profiles.map((profile) => ({ profileId: profile.id, connectorId: profile.connectorId, scope: structuredClone(profile.scope), authorization: structuredClone(profile.authorization) })),
    summary,
    items,
    safety: { catalogWrites: false, providerMutations: false, deletionsInferred: false, backgroundSync: false },
  });
}

export function createSetupRefreshPlan(profileInput) {
  const profiles = parseProfiles(profileInput);
  return immutable({
    version: 1,
    command: "refresh-my-devhub-plan",
    readOnly: true,
    connections: profiles.map((profile) => ({ profileId: profile.id, connectorId: profile.connectorId, scope: structuredClone(profile.scope), authorization: structuredClone(profile.authorization), owner: profile.owner })),
    nextAction: "Run one on-demand setup session with these exact reviewed scopes and credential references.",
    safety: { scopesBroadened: false, credentialReferencesChanged: false, backgroundSync: false, catalogWrites: false, providerMutations: false },
  });
}

export function proposeConnectionDisconnect(profileInput, options = {}) {
  const profiles = parseProfiles(profileInput);
  if (profiles.length !== 1) fail("invalid-disconnect-proposal", "disconnect requires exactly one reviewed connection profile");
  const profile = profiles[0];
  const action = options.action ?? "remove";
  if (!new Set(["remove", "disable"]).has(action)) fail("invalid-disconnect-proposal", "disconnect action must be remove or disable");
  return immutable({
    version: 1,
    command: "disconnect-connection-proposal",
    readOnly: true,
    apply: false,
    requestedAt: timestamp(options.requestedAt, "requestedAt"),
    requestedBy: safeString(options.requestedBy, "requestedBy", 200),
    reason: safeString(options.reason, "reason", 500),
    profileChange: { action, profileId: profile.id, expectedFingerprint: profileFingerprint(profile) },
    preserved: { catalogRecords: true, providerResources: true, evidenceHistory: true },
    safety: { profileWrites: false, catalogWrites: false, providerMutations: false, resourceDeletions: false },
  });
}
