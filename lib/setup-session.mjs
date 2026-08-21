import { randomUUID } from "node:crypto";

import { getConnector } from "./connectors.mjs";
import { validateConnectionOnboarding } from "./connection-onboarding.mjs";
import { validateTaskObservationBridge } from "./task-observations.mjs";

const stableId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const environmentName = /^[A-Z_][A-Z0-9_]{0,127}$/;
const credentialKinds = new Set(["environment", "keychain", "secret-manager"]);
const keychainLocator = /^generic-password:[A-Za-z0-9._@+-]{1,100}:[A-Za-z0-9._@+-]{1,100}$/;
const onePasswordLocator = /^op:\/\/[A-Za-z0-9._ -]{1,100}\/[A-Za-z0-9._ -]{1,100}\/[A-Za-z0-9._ -]{1,100}$/;
const profileStates = new Set(["authorization-required", "connected", "unavailable", "unknown"]);
const resultStates = new Set(["authorization-required", "connected", "unavailable", "unknown"]);
const forbiddenKey = /password|passwd|secret|token|api[-_.]?key|apikey|private[-_.]?key|privatekey|connection[-_.]?string|connectionstring|cookie|authorization/i;
const secretAssignment = /\b(?:password|passwd|secret|token|api[-_]?key|private[-_]?key|connection[-_]?string)\s*[:=]\s*["']?(?!<|\$|redacted\b)[^\s,"']{8,}/i;
const privateKey = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
const secretLiteral = /(?:\bgh[pousr]_[A-Za-z0-9]{16,}\b|\bgithub_pat_[A-Za-z0-9_]{16,}\b|\bsk-[A-Za-z0-9_-]{20,}\b|\b(?:bearer|basic)\s+[A-Za-z0-9._~+/-]{8,}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b)/i;
const profileFields = new Set(["version", "id", "connectorId", "authorization", "scope", "owner", "state", "lastObservedAt", "freshForSeconds"]);
const authorizationFields = new Set(["method", "credentialRef"]);
const credentialRefFields = new Set(["kind", "locator"]);
const publicScopeMetadataKeys = new Set(["kind", "provider", "scopeKind", "type"]);
const genericConnectorMessages = Object.freeze({
  connected: "The bounded connector check completed.",
  "authorization-required": "The bounded connector check requires reviewed authorization.",
  unavailable: "The bounded connector check is unavailable.",
  unknown: "The bounded connector check did not return a usable observation.",
});

export class SetupSessionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SetupSessionError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new SetupSessionError(code, message);
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactFields(value, fields, label) {
  for (const key of Object.keys(value)) if (!fields.has(key)) fail("invalid-connection-profile", `${label}.${key} is not supported`);
}

function requiredString(value, label, maximum = 300) {
  if (typeof value !== "string" || !value.trim()) fail("invalid-connection-profile", `${label} must be a non-empty string`);
  if (value.length > maximum) fail("invalid-connection-profile", `${label} must contain at most ${maximum} characters`);
  return value.trim();
}

function isoTimestamp(value, label) {
  const timestamp = requiredString(value, label, 40);
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    fail("invalid-connection-profile", `${label} must be an ISO 8601 UTC timestamp`);
  }
  return timestamp;
}

function assertSafeString(value, label) {
  if (privateKey.test(value) || secretAssignment.test(value) || secretLiteral.test(value)) fail("unsafe-setup-metadata", `${label} appears to contain secret material`);
  const urls = value.match(/https?:\/\/[^\s"']+/gi) ?? [];
  for (const candidate of urls) {
    let parsed;
    try { parsed = new URL(candidate); } catch { continue; }
    if (parsed.username || parsed.password || [...parsed.searchParams.keys()].some((key) => forbiddenKey.test(key))) {
      fail("unsafe-setup-metadata", `${label} must not contain credentials or secret-bearing URLs`);
    }
  }
}

function safeMetadata(value, label, depth = 0) {
  if (depth > 8) fail("invalid-connection-profile", `${label} exceeds the maximum metadata depth`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("invalid-connection-profile", `${label} must contain finite numbers only`);
    return value;
  }
  if (typeof value === "string") {
    if (value.length > 2_000) fail("invalid-connection-profile", `${label} contains an oversized string`);
    assertSafeString(value, label);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 500) fail("invalid-connection-profile", `${label} contains too many items`);
    return value.map((item, index) => safeMetadata(item, `${label}[${index}]`, depth + 1));
  }
  if (!plainObject(value)) fail("invalid-connection-profile", `${label} must contain JSON metadata only`);
  const entries = Object.entries(value);
  if (entries.length > 100) fail("invalid-connection-profile", `${label} contains too many fields`);
  return Object.fromEntries(entries.map(([key, item]) => {
    if (!key || key.length > 100 || forbiddenKey.test(key)) fail("unsafe-setup-metadata", `${label}.${key || "<empty>"} is not allowed`);
    return [key, safeMetadata(item, `${label}.${key}`, depth + 1)];
  }));
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

export function parseCredentialReference(value, label = "credentialRef") {
  if (!plainObject(value)) fail("invalid-connection-profile", `${label} must be an object`);
  exactFields(value, credentialRefFields, label);
  const kind = requiredString(value.kind, `${label}.kind`, 30);
  if (!credentialKinds.has(kind)) fail("invalid-connection-profile", `${label}.kind is not supported`);
  const locator = requiredString(value.locator, `${label}.locator`, 300);
  if (privateKey.test(locator) || secretLiteral.test(locator)) fail("unsafe-setup-metadata", `${label}.locator appears to contain secret material`);
  if (kind === "environment" && !environmentName.test(locator)) {
    fail("invalid-connection-profile", `${label}.locator must be an environment variable name`);
  }
  if (kind === "keychain" && !keychainLocator.test(locator)) {
    fail("invalid-connection-profile", `${label}.locator must use generic-password:<service>:<account>`);
  }
  if (kind === "secret-manager" && !onePasswordLocator.test(locator)) {
    fail("invalid-connection-profile", `${label}.locator must use an op://vault/item/field reference`);
  }
  return { kind, locator };
}

export function validateConnectionProfile(value, options = {}) {
  const label = options.label ?? "profile";
  if (!plainObject(value)) fail("invalid-connection-profile", `${label} must be an object`);
  exactFields(value, profileFields, label);
  if (value.version !== 1) fail("invalid-connection-profile", `${label}.version must be 1`);
  const id = requiredString(value.id, `${label}.id`, 100);
  if (!stableId.test(id)) fail("invalid-connection-profile", `${label}.id must use lowercase kebab-case`);
  const connectorId = requiredString(value.connectorId, `${label}.connectorId`, 100);
  const definition = getConnector(connectorId);
  if (!definition) fail("invalid-connection-profile", `${label}.connectorId is not in the connector catalog`);
  if (!plainObject(value.authorization)) fail("invalid-connection-profile", `${label}.authorization must be an object`);
  exactFields(value.authorization, authorizationFields, `${label}.authorization`);
  const method = requiredString(value.authorization.method, `${label}.authorization.method`, 40);
  if (!definition.auth.includes(method)) fail("invalid-connection-profile", `${label}.authorization.method is not supported by ${connectorId}`);
  const authorization = {
    method,
    ...(value.authorization.credentialRef === undefined ? {} : {
      credentialRef: parseCredentialReference(value.authorization.credentialRef, `${label}.authorization.credentialRef`),
    }),
  };
  if (method === "secret-reference" && !authorization.credentialRef) {
    fail("invalid-connection-profile", `${label}.authorization.credentialRef is required for secret-reference`);
  }
  if (method !== "secret-reference" && authorization.credentialRef) {
    fail("invalid-connection-profile", `${label}.authorization.credentialRef is only supported for secret-reference`);
  }
  if (!plainObject(value.scope) || !Object.keys(value.scope).length) fail("invalid-connection-profile", `${label}.scope must be a non-empty object`);
  const scope = safeMetadata(value.scope, `${label}.scope`);
  const owner = requiredString(value.owner, `${label}.owner`, 200);
  assertSafeString(owner, `${label}.owner`);
  const state = requiredString(value.state, `${label}.state`, 40);
  if (!profileStates.has(state)) fail("invalid-connection-profile", `${label}.state is not supported`);
  const freshForSeconds = value.freshForSeconds;
  if (!Number.isInteger(freshForSeconds) || freshForSeconds < 60 || freshForSeconds > 31_536_000) {
    fail("invalid-connection-profile", `${label}.freshForSeconds must be an integer from 60 to 31536000`);
  }
  const lastObservedAt = value.lastObservedAt === undefined || value.lastObservedAt === null
    ? null
    : isoTimestamp(value.lastObservedAt, `${label}.lastObservedAt`);
  if (state === "connected" && !lastObservedAt) fail("invalid-connection-profile", `${label}.lastObservedAt is required when state is connected`);
  return deepFreeze({ version: 1, id, connectorId, authorization, scope, owner, state, lastObservedAt, freshForSeconds });
}

export function parseConnectionProfileDocument(value) {
  if (!plainObject(value)) fail("invalid-connection-profile", "connection profile document must be an object");
  const profiles = Object.hasOwn(value, "profiles") ? value.profiles : [value];
  if (Object.hasOwn(value, "profiles")) {
    exactFields(value, new Set(["version", "profiles"]), "document");
    if (value.version !== 1) fail("invalid-connection-profile", "document.version must be 1");
  }
  if (!Array.isArray(profiles) || !profiles.length || profiles.length > 50) {
    fail("invalid-connection-profile", "connection profile document must contain 1 to 50 profiles");
  }
  const parsed = profiles.map((profile, index) => validateConnectionProfile(profile, { label: `profiles[${index}]` }));
  const ids = new Set();
  for (const profile of parsed) {
    if (ids.has(profile.id)) fail("invalid-connection-profile", `duplicate connection profile id: ${profile.id}`);
    ids.add(profile.id);
  }
  return Object.freeze(parsed);
}

export function validateSetupConnector(value) {
  if (!plainObject(value) || typeof value.collect !== "function") fail("invalid-setup-connector", "setup connector must expose collect()" );
  const connectorId = requiredString(value.connectorId, "setup connector.connectorId", 100);
  if (!getConnector(connectorId)) fail("invalid-setup-connector", `unknown setup connector: ${connectorId}`);
  if (value.validateProfile !== undefined && typeof value.validateProfile !== "function") {
    fail("invalid-setup-connector", `${connectorId}.validateProfile must be a function`);
  }
  if (value.awaitAbortCleanup !== undefined && typeof value.awaitAbortCleanup !== "boolean") {
    fail("invalid-setup-connector", `${connectorId}.awaitAbortCleanup must be a boolean`);
  }
  const onboarding = value.onboarding === undefined ? null : validateConnectionOnboarding(value.onboarding);
  if (onboarding && onboarding.connectorId !== connectorId) {
    fail("invalid-setup-connector", `${connectorId}.onboarding.connectorId must match the setup connector`);
  }
  const taskObservationBridge = value.taskObservationBridge === undefined
    ? null
    : validateTaskObservationBridge(value.taskObservationBridge);
  if (taskObservationBridge && taskObservationBridge.connectorId !== connectorId) {
    fail("invalid-setup-connector", `${connectorId}.taskObservationBridge.connectorId must match the setup connector`);
  }
  return Object.freeze({
    connectorId,
    collect: value.collect,
    ...(onboarding ? { onboarding } : {}),
    ...(taskObservationBridge ? { taskObservationBridge } : {}),
    ...(value.validateProfile ? { validateProfile: value.validateProfile } : {}),
    ...(value.awaitAbortCleanup ? { awaitAbortCleanup: true } : {}),
  });
}

function containsCredential(value, credential) {
  if (typeof credential !== "string" || !credential.length) return false;
  if (typeof value === "string") return value.includes(credential);
  if (Array.isArray(value)) return value.some((item) => containsCredential(item, credential));
  return plainObject(value) && Object.values(value).some((item) => containsCredential(item, credential));
}

function privateProfileValues(profile) {
  const values = new Set([profile.id, profile.owner, profile.authorization.credentialRef?.locator].filter(Boolean));
  const visit = (value, key = null) => {
    if (typeof value === "string") {
      if (!publicScopeMetadataKeys.has(key)) values.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (plainObject(value)) {
      for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
    }
  };
  visit(profile.scope);
  return [...values].map((value) => value.trim().toLowerCase()).filter(Boolean);
}

function safeConnectorMessage(value, profile, state, credential) {
  if (value === undefined) return null;
  const message = requiredString(value, `${profile.connectorId}.message`, 500);
  let unsafe = containsCredential(message, credential);
  try {
    assertSafeString(message, `${profile.connectorId}.message`);
  } catch (error) {
    if (error?.code !== "unsafe-setup-metadata") throw error;
    unsafe = true;
  }
  const normalized = message.toLowerCase();
  if (privateProfileValues(profile).some((privateValue) => normalized.includes(privateValue))) unsafe = true;
  return unsafe ? genericConnectorMessages[state] : message;
}

function normalizeConnectorResult(value, profile, now, credential) {
  if (!plainObject(value)) fail("invalid-setup-result", `${profile.connectorId} returned a non-object result`);
  for (const key of Object.keys(value)) {
    if (!["state", "observedAt", "message", "observations"].includes(key)) fail("invalid-setup-result", `${profile.connectorId} returned unsupported field ${key}`);
  }
  if (!resultStates.has(value.state)) fail("invalid-setup-result", `${profile.connectorId} returned an unsupported state`);
  const observedAt = value.observedAt === undefined ? now.toISOString() : isoTimestamp(value.observedAt, `${profile.connectorId}.observedAt`);
  if (new Date(observedAt) > now) fail("invalid-setup-result", `${profile.connectorId}.observedAt must not be in the future`);
  const message = safeConnectorMessage(value.message, profile, value.state, credential);
  const observations = value.observations === undefined ? [] : safeMetadata(value.observations, `${profile.connectorId}.observations`);
  if (!Array.isArray(observations)) fail("invalid-setup-result", `${profile.connectorId}.observations must be an array`);
  if (observations.length > 500 || observations.some((item) => !plainObject(item))) {
    fail("invalid-setup-result", `${profile.connectorId}.observations must contain at most 500 objects`);
  }
  if (Buffer.byteLength(JSON.stringify(observations), "utf8") > 512 * 1024) {
    fail("invalid-setup-result", `${profile.connectorId}.observations exceeds the 524288-byte limit`);
  }
  if (containsCredential(observations, credential)) {
    fail("unsafe-setup-metadata", `${profile.connectorId} returned the resolved credential value`);
  }
  return { state: value.state, observedAt, message, observations };
}

function staleAt(profile, observedAt) {
  return new Date(new Date(observedAt).getTime() + (profile.freshForSeconds * 1_000)).toISOString();
}

function waitWithSignal(operation, signal) {
  const settled = Promise.resolve(operation).then(
    (value) => ({ state: "settled", value }),
    (error) => ({ state: "rejected", error }),
  );
  if (!signal) return settled;
  if (signal.aborted) return Promise.resolve({ state: "aborted" });
  return new Promise((resolve) => {
    const aborted = () => resolve({ state: "aborted" });
    signal.addEventListener("abort", aborted, { once: true });
    settled.then((outcome) => {
      signal.removeEventListener("abort", aborted);
      resolve(outcome);
    });
  });
}

function deadlineResult(profile, reviewedConnection) {
  return {
    profileId: profile.id,
    connectorId: profile.connectorId,
    state: "unknown",
    observedAt: null,
    freshUntil: null,
    reviewedConnection,
    evidence: { source: "on-demand-setup-connector", observations: [] },
    message: "The overall setup-run deadline expired before this source returned a bounded observation.",
  };
}

export async function runSetupSession(input, options = {}) {
  const profiles = parseConnectionProfileDocument(input);
  const now = new Date(options.now ?? Date.now());
  if (!Number.isFinite(now.getTime())) fail("invalid-now", "setup session requires a valid now value");
  const connectorValues = options.connectors instanceof Map ? [...options.connectors.values()] : Object.values(options.connectors ?? {});
  const connectors = new Map(connectorValues.map((connector) => {
    const validated = validateSetupConnector(connector);
    return [validated.connectorId, validated];
  }));
  const duplicateConnectorIds = connectorValues.length !== connectors.size;
  if (duplicateConnectorIds) fail("invalid-setup-connector", "setup connector IDs must be unique");
  const results = [];
  let normalizedObservationBytes = 0;
  for (const profile of profiles) {
    const reviewedConnection = deepFreeze({
      scope: structuredClone(profile.scope),
      owner: profile.owner,
      authorization: structuredClone(profile.authorization),
      priorState: profile.state,
      priorObservedAt: profile.lastObservedAt,
    });
    if (options.signal?.aborted) {
      results.push(deadlineResult(profile, reviewedConnection));
      continue;
    }
    const connector = connectors.get(profile.connectorId);
    if (!connector) {
      results.push({ profileId: profile.id, connectorId: profile.connectorId, state: "unavailable", observedAt: null, freshUntil: null, reviewedConnection, evidence: { source: "reviewed-connection-profile", observations: [] }, message: "No on-demand setup connector is available in this session." });
      continue;
    }
    try {
      const validation = await waitWithSignal(
        connector.validateProfile?.(profile, { signal: options.signal }),
        options.signal,
      );
      if (validation.state === "aborted") {
        results.push(deadlineResult(profile, reviewedConnection));
        continue;
      }
      if (validation.state === "rejected") throw validation.error;
    } catch {
      results.push({ profileId: profile.id, connectorId: profile.connectorId, state: "unknown", observedAt: null, freshUntil: null, reviewedConnection, evidence: { source: "reviewed-connection-profile", observations: [] }, message: "The connector rejected this reviewed profile scope." });
      continue;
    }
    let credential;
    if (profile.authorization.credentialRef) {
      if (typeof options.resolveCredential !== "function") {
        results.push({ profileId: profile.id, connectorId: profile.connectorId, state: "authorization-required", observedAt: null, freshUntil: null, reviewedConnection, evidence: { source: "reviewed-connection-profile", observations: [] }, message: "The reviewed credential reference was not resolved for this on-demand session." });
        continue;
      }
      try {
        const resolution = await waitWithSignal(
          options.resolveCredential(profile.authorization.credentialRef, { profile, signal: options.signal }),
          options.signal,
        );
        if (resolution.state === "aborted") {
          results.push(deadlineResult(profile, reviewedConnection));
          continue;
        }
        if (resolution.state === "rejected") throw resolution.error;
        credential = resolution.value;
      } catch {
        results.push({ profileId: profile.id, connectorId: profile.connectorId, state: "authorization-required", observedAt: null, freshUntil: null, reviewedConnection, evidence: { source: "reviewed-connection-profile", observations: [] }, message: "The reviewed credential reference could not be resolved." });
        continue;
      }
      if (typeof credential !== "string" || !credential.length || Buffer.byteLength(credential, "utf8") > 64 * 1024) {
        results.push({ profileId: profile.id, connectorId: profile.connectorId, state: "authorization-required", observedAt: null, freshUntil: null, reviewedConnection, evidence: { source: "reviewed-connection-profile", observations: [] }, message: "The reviewed credential reference is unavailable." });
        continue;
      }
    }
    let collected;
    try {
      const collectionOperation = connector.collect({ profile, credential, now: now.toISOString(), signal: options.signal });
      const collection = await waitWithSignal(
        collectionOperation,
        options.signal,
      );
      if (collection.state === "aborted") {
        if (connector.awaitAbortCleanup) await Promise.resolve(collectionOperation).catch(() => undefined);
        results.push(deadlineResult(profile, reviewedConnection));
        continue;
      }
      if (collection.state === "rejected") throw collection.error;
      collected = normalizeConnectorResult(collection.value, profile, now, credential);
    } catch {
      results.push({ profileId: profile.id, connectorId: profile.connectorId, state: "unknown", observedAt: null, freshUntil: null, reviewedConnection, evidence: { source: "on-demand-setup-connector", observations: [] }, message: "The connector did not return a valid bounded observation." });
      continue;
    } finally {
      credential = undefined;
    }
    const freshUntil = staleAt(profile, collected.observedAt);
    const state = collected.state === "connected" && new Date(freshUntil) <= now ? "stale" : collected.state;
    normalizedObservationBytes += Buffer.byteLength(JSON.stringify(collected.observations), "utf8");
    if (normalizedObservationBytes > 1024 * 1024) {
      results.push({ profileId: profile.id, connectorId: profile.connectorId, state: "unknown", observedAt: null, freshUntil: null, reviewedConnection, evidence: { source: "on-demand-setup-connector", observations: [] }, message: "The setup session exceeded the bounded observation limit." });
      continue;
    }
    results.push({ profileId: profile.id, connectorId: profile.connectorId, state, observedAt: collected.observedAt, freshUntil, reviewedConnection, evidence: { source: "on-demand-setup-connector", observations: collected.observations }, message: collected.message });
  }
  return {
    version: 1,
    command: "setup-session",
    sessionId: options.sessionId ?? randomUUID(),
    startedAt: now.toISOString(),
    completedAt: now.toISOString(),
    status: results.some((result) => ["authorization-required", "unavailable", "stale", "unknown"].includes(result.state)) ? "review-required" : "complete",
    readOnly: true,
    persistent: false,
    safety: { catalogWrites: false, providerMutations: false, credentialValuesReturned: false, browserExecution: false, residentProcess: false },
    results,
  };
}

export const createSetupSession = runSetupSession;
