import { READINESS_CHECKS } from "./readiness.mjs";
import { parseCredentialReference } from "./setup-session.mjs";

const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const environmentNamePattern = /^[A-Z][A-Z0-9_]*$/;
const reasonPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const safeEvidenceStates = new Set(["verified", "declared", "unknown"]);
const costStates = new Set(["present", "absent", "unknown"]);
const freshnessStates = new Set(["fresh", "stale", "unknown"]);
const executionStates = new Set(["succeeded", "failed"]);
const cacheStates = new Set(["none", "fresh", "stale"]);
const readinessChecks = new Set(READINESS_CHECKS);
const sensitiveKeyPattern = /(?:^|[-_])(?:api[-_]?key|authorization|credential|password|private[-_]?key|secret|signature|token)(?:$|[-_])/i;
const secretAssignmentPattern = /\b(?:api[-_]?key|access[-_]?token|authorization|client[-_]?secret|password|passwd|private[-_]?key|secret|token)\s*[:=]\s*["']?(?!\$|\$\{|<|example\b|redacted\b)[A-Za-z0-9_./+=-]{8,}/i;
const bearerCredentialPattern = /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i;
const knownTokenPattern = /\b(?:github_pat_|gh[oprsu]_|sk-(?:proj-)?)[A-Za-z0-9_-]{8,}/i;
const privateKeyPattern = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
const MAX_IDENTITY_DEPTH = 6;
const MAX_IDENTITY_FIELDS = 100;
const MAX_SAFE_STRING_LENGTH = 500;
const MAX_FRESH_SECONDS = 30 * 24 * 60 * 60;
const MAX_EVIDENCE_ITEMS = 50;
const DEFAULT_DEADLINE_MS = 10_000;
const MAX_DEADLINE_MS = 30_000;
const DEFAULT_MAX_PAGES = 20;
const MAX_PAGES = 100;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const trustedSuccessfulResults = new WeakSet();

export class EvidenceAdapterContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EvidenceAdapterContractError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new EvidenceAdapterContractError(code, message);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function object(value, field) {
  if (!isPlainObject(value)) fail("invalid-contract", `${field} must be a plain object`);
  return value;
}

function exactFields(value, fields, field) {
  for (const key of Object.keys(value)) {
    if (!fields.has(key)) fail("invalid-contract", `${field}.${key} is not supported`);
  }
}

function string(value, field, { maximum = MAX_SAFE_STRING_LENGTH } = {}) {
  if (typeof value !== "string" || value.trim() === "") fail("invalid-contract", `${field} must be a non-empty string`);
  if (value.length > maximum) fail("invalid-contract", `${field} must contain at most ${maximum} characters`);
  if (
    privateKeyPattern.test(value)
    || secretAssignmentPattern.test(value)
    || bearerCredentialPattern.test(value)
    || knownTokenPattern.test(value)
  ) {
    fail("unsafe-adapter-result", `${field} must not contain secret material`);
  }
  return value;
}

function id(value, field) {
  string(value, field, { maximum: 100 });
  if (!idPattern.test(value)) fail("invalid-contract", `${field} must use lowercase kebab-case`);
  return value;
}

function reason(value, field) {
  string(value, field, { maximum: 100 });
  if (!reasonPattern.test(value)) fail("invalid-contract", `${field} must be a stable lowercase reason code`);
  return value;
}

function dateTime(value, field) {
  string(value, field, { maximum: 50 });
  if (!/T/.test(value) || !Number.isFinite(Date.parse(value))) fail("invalid-contract", `${field} must be an ISO 8601 date-time`);
  return new Date(value).toISOString();
}

function safeUrl(value, field) {
  string(value, field, { maximum: 2048 });
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("invalid-contract", `${field} must be an absolute HTTP(S) URL`);
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) fail("invalid-contract", `${field} must use HTTP(S)`);
  if (parsed.username || parsed.password) fail("unsafe-adapter-result", `${field} must not contain URL credentials`);
  for (const key of parsed.searchParams.keys()) {
    if (sensitiveKeyPattern.test(key)) fail("unsafe-adapter-result", `${field} must not contain secret-bearing query parameters`);
  }
  return value;
}

function cloneSafeIdentity(value, field = "reviewedIdentity", depth = 0, counter = { count: 0 }) {
  if (depth > MAX_IDENTITY_DEPTH) fail("invalid-identity", `${field} is nested too deeply`);
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (typeof value === "string") {
    const result = string(value, field, { maximum: 300 });
    if (/^https?:\/\//i.test(result)) safeUrl(result, field);
    return result;
  }
  if (Array.isArray(value)) {
    if (value.length > 50) fail("invalid-identity", `${field} must contain at most 50 items`);
    return value.map((item, index) => cloneSafeIdentity(item, `${field}[${index}]`, depth + 1, counter));
  }
  object(value, field);
  const result = {};
  const keys = Object.keys(value).sort();
  if (keys.length === 0) fail("invalid-identity", `${field} must not be empty`);
  for (const key of keys) {
    counter.count += 1;
    if (counter.count > MAX_IDENTITY_FIELDS) fail("invalid-identity", `${field} has too many fields`);
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) fail("invalid-identity", `${field}.${key} has an unsupported field name`);
    if (sensitiveKeyPattern.test(key)) fail("unsafe-identity", `${field}.${key} must not contain credentials or secrets`);
    result[key] = cloneSafeIdentity(value[key], `${field}.${key}`, depth + 1, counter);
  }
  return result;
}

function immutable(value) {
  // AbortSignal has mutable internal slots; freezing it breaks abort().
  if (typeof AbortSignal !== "undefined" && value instanceof AbortSignal) return value;
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) immutable(child);
  }
  return value;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameIdentity(left, right) {
  return stableJson(left) === stableJson(right);
}

function asNow(value) {
  const result = value === undefined ? new Date() : new Date(value);
  if (Number.isNaN(result.getTime())) fail("invalid-now", "adapter execution requires a valid now value");
  return result;
}

function freshnessFor(observedAt, validUntil, now) {
  if (observedAt === null || validUntil === null) return "unknown";
  return Date.parse(validUntil) < now.getTime() ? "stale" : "fresh";
}

function validateAdapter(adapter) {
  object(adapter, "adapter");
  id(adapter.id, "adapter.id");
  id(adapter.provider, "adapter.provider");
  if (typeof adapter.validateIdentity !== "function") fail("invalid-adapter", "adapter.validateIdentity must be a function");
  if (typeof adapter.collect !== "function") fail("invalid-adapter", "adapter.collect must be a function");
}

export function validateEvidenceBinding(binding, adapter) {
  object(binding, "binding");
  exactFields(binding, new Set([
    "projectId", "serviceId", "adapterId", "provider", "reviewedIdentity",
    "credentialEnv", "credentialRef", "checks", "freshForSeconds", "deadlineMs", "maxPages", "maxResponseBytes", "maxCandidates",
  ]), "binding");
  validateAdapter(adapter);
  id(binding.projectId, "binding.projectId");
  id(binding.serviceId, "binding.serviceId");
  id(binding.adapterId, "binding.adapterId");
  id(binding.provider, "binding.provider");
  if (binding.adapterId !== adapter.id || binding.provider !== adapter.provider) {
    fail("adapter-binding-mismatch", "binding adapter and provider must exactly match the selected adapter");
  }
  const reviewedIdentity = cloneSafeIdentity(binding.reviewedIdentity);
  let identityAccepted = false;
  try {
    identityAccepted = adapter.validateIdentity(immutable(structuredClone(reviewedIdentity))) === true;
  } catch {
    fail("invalid-identity", "reviewedIdentity was rejected by the selected adapter");
  }
  if (!identityAccepted) fail("invalid-identity", "reviewedIdentity was rejected by the selected adapter");

  if (binding.credentialEnv !== undefined && binding.credentialEnv !== null) {
    string(binding.credentialEnv, "binding.credentialEnv", { maximum: 100 });
    if (!environmentNamePattern.test(binding.credentialEnv)) {
      fail("invalid-credential-environment", "binding.credentialEnv must name an uppercase environment variable");
    }
  }
  let credentialRef = null;
  if (binding.credentialRef !== undefined && binding.credentialRef !== null) {
    try {
      credentialRef = parseCredentialReference(binding.credentialRef, "binding.credentialRef");
    } catch {
      fail("invalid-credential-reference", "binding.credentialRef must be a reviewed external credential reference");
    }
  }
  if (binding.credentialEnv !== undefined && binding.credentialEnv !== null && credentialRef !== null) {
    fail("invalid-credential-reference", "binding must use exactly one of credentialEnv or credentialRef");
  }
  if (!Array.isArray(binding.checks) || binding.checks.length === 0) fail("invalid-contract", "binding.checks must not be empty");
  const checks = [];
  for (const [index, check] of binding.checks.entries()) {
    if (!readinessChecks.has(check)) fail("invalid-contract", `binding.checks[${index}] is not a supported readiness check`);
    if (checks.includes(check)) fail("invalid-contract", `binding.checks[${index}] duplicates ${check}`);
    checks.push(check);
  }
  if (!Number.isInteger(binding.freshForSeconds) || binding.freshForSeconds < 60 || binding.freshForSeconds > MAX_FRESH_SECONDS) {
    fail("invalid-contract", `binding.freshForSeconds must be an integer from 60 to ${MAX_FRESH_SECONDS}`);
  }
  const deadlineMs = binding.deadlineMs ?? DEFAULT_DEADLINE_MS;
  if (!Number.isInteger(deadlineMs) || deadlineMs < 100 || deadlineMs > MAX_DEADLINE_MS) {
    fail("invalid-contract", `binding.deadlineMs must be an integer from 100 to ${MAX_DEADLINE_MS}`);
  }
  const maxPages = binding.maxPages ?? DEFAULT_MAX_PAGES;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES) {
    fail("invalid-contract", `binding.maxPages must be an integer from 1 to ${MAX_PAGES}`);
  }
  const maxResponseBytes = binding.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > MAX_RESPONSE_BYTES) {
    fail("invalid-contract", `binding.maxResponseBytes must be an integer from 1 to ${MAX_RESPONSE_BYTES}`);
  }
  const maxCandidates = binding.maxCandidates ?? MAX_EVIDENCE_ITEMS;
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > MAX_EVIDENCE_ITEMS) {
    fail("invalid-contract", `binding.maxCandidates must be an integer from 1 to ${MAX_EVIDENCE_ITEMS}`);
  }
  return immutable({
    projectId: binding.projectId,
    serviceId: binding.serviceId,
    adapterId: binding.adapterId,
    provider: binding.provider,
    reviewedIdentity,
    credentialEnv: binding.credentialEnv ?? null,
    credentialRef,
    checks,
    freshForSeconds: binding.freshForSeconds,
    deadlineMs,
    maxPages,
    maxResponseBytes,
    maxCandidates,
  });
}

export function evidenceBindingKey(binding) {
  return stableJson({
    projectId: binding.projectId,
    serviceId: binding.serviceId,
    adapterId: binding.adapterId,
    provider: binding.provider,
    reviewedIdentity: binding.reviewedIdentity,
    checks: [...binding.checks].sort(),
    freshForSeconds: binding.freshForSeconds,
    deadlineMs: binding.deadlineMs,
    maxPages: binding.maxPages,
    maxResponseBytes: binding.maxResponseBytes,
    maxCandidates: binding.maxCandidates,
  });
}

export function createMemoryEvidenceCache() {
  const entries = new Map();
  return Object.freeze({
    get(key) {
      return entries.get(key) ?? null;
    },
    set(key, value) {
      entries.set(key, value);
    },
    clear() {
      entries.clear();
    },
  });
}

function normalizeEvidenceItem(item, { observedAt, validUntil, checks, index }) {
  object(item, `observation.evidence[${index}]`);
  exactFields(item, new Set(["id", "check", "state", "note", "url"]), `observation.evidence[${index}]`);
  id(item.id, `observation.evidence[${index}].id`);
  if (!checks.includes(item.check)) fail("invalid-adapter-result", `adapter returned unrequested check ${item.check}`);
  if (!safeEvidenceStates.has(item.state)) {
    fail("invalid-adapter-result", `observation.evidence[${index}].state must be verified, declared or unknown`);
  }
  const result = {
    id: item.id,
    check: item.check,
    state: item.state,
    source: "integration",
    note: string(item.note, `observation.evidence[${index}].note`),
    observedAt,
    validUntil,
  };
  if (item.url !== undefined) result.url = safeUrl(item.url, `observation.evidence[${index}].url`);
  return result;
}

function normalizeDeployment(deployment) {
  if (deployment === undefined) return undefined;
  object(deployment, "observation.deployment");
  exactFields(deployment, new Set(["identity", "revision", "url", "host", "deployedAt"]), "observation.deployment");
  const result = {};
  for (const field of ["identity", "revision", "host"]) {
    if (deployment[field] !== undefined) result[field] = string(deployment[field], `observation.deployment.${field}`, { maximum: 300 });
  }
  if (deployment.url !== undefined) result.url = safeUrl(deployment.url, "observation.deployment.url");
  if (deployment.deployedAt !== undefined) result.deployedAt = dateTime(deployment.deployedAt, "observation.deployment.deployedAt");
  if (Object.keys(result).length === 0) fail("invalid-adapter-result", "observation.deployment must not be empty");
  return result;
}

function normalizeRecurringCost(recurringCost, observedAt) {
  if (recurringCost === undefined) return undefined;
  object(recurringCost, "observation.recurringCost");
  exactFields(recurringCost, new Set(["state", "url"]), "observation.recurringCost");
  if (!costStates.has(recurringCost.state)) fail("invalid-adapter-result", "observation.recurringCost.state is invalid");
  const result = { state: recurringCost.state, observedAt };
  if (recurringCost.url !== undefined) result.url = safeUrl(recurringCost.url, "observation.recurringCost.url");
  return result;
}

function unknownEvidence(binding, reasonCode) {
  return binding.checks.map((check) => ({
    id: `${binding.adapterId}-${check}`,
    check,
    state: "unknown",
    source: "integration",
    note: `Integration evidence is unavailable (${reasonCode}).`,
  }));
}

function identityFor(binding) {
  return {
    projectId: binding.projectId,
    serviceId: binding.serviceId,
    adapterId: binding.adapterId,
    provider: binding.provider,
    reviewedIdentity: structuredClone(binding.reviewedIdentity),
  };
}

function failedResult(binding, reasonCode, now, cached = null) {
  if (cached !== null) {
    if (!trustedSuccessfulResults.has(cached)) {
      return failedResult(binding, "untrusted-cached-evidence", now, null);
    }
    let validated;
    try {
      validated = validateEvidenceAdapterResult(cached);
    } catch {
      return failedResult(binding, "invalid-cached-evidence", now, null);
    }
    const cachedChecks = validated.evidence.map((item) => item.check).sort();
    const bindingChecks = [...binding.checks].sort();
    if (
      !sameIdentity(validated.identity, identityFor(binding))
      || !sameIdentity(cachedChecks, bindingChecks)
      || validated.execution.state !== "succeeded"
    ) {
      return failedResult(binding, reasonCode, now, null);
    }
    const freshness = freshnessFor(validated.freshness.observedAt, validated.freshness.validUntil, now);
    return immutable(validateEvidenceAdapterResult({
      ...structuredClone(validated),
      execution: { state: "failed", reason: reasonCode, cache: freshness === "fresh" ? "fresh" : "stale" },
      freshness: { ...validated.freshness, state: freshness, evaluatedAt: now.toISOString() },
    }));
  }
  return immutable(validateEvidenceAdapterResult({
    formatVersion: 1,
    identity: identityFor(binding),
    execution: { state: "failed", reason: reasonCode, cache: "none" },
    freshness: { state: "unknown", observedAt: null, validUntil: null, evaluatedAt: now.toISOString() },
    evidence: unknownEvidence(binding, reasonCode),
  }));
}

function reasonFromUnavailable(observation) {
  if (!isPlainObject(observation) || observation.status !== "unavailable") return "invalid-adapter-result";
  try {
    exactFields(observation, new Set(["status", "reason"]), "observation");
    return reason(observation.reason, "observation.reason");
  } catch {
    return "invalid-adapter-result";
  }
}

function normalizeSuccess(binding, observation, now) {
  object(observation, "observation");
  exactFields(observation, new Set([
    "status", "observedIdentity", "observedAt", "evidence", "deployment", "recurringCost",
  ]), "observation");
  if (observation.status !== "success") fail("invalid-adapter-result", "observation.status must be success");
  const observedIdentity = cloneSafeIdentity(observation.observedIdentity, "observation.observedIdentity");
  if (!sameIdentity(observedIdentity, binding.reviewedIdentity)) {
    fail("identity-mismatch", "provider observation does not match the exact reviewed service identity");
  }
  const observedAt = dateTime(observation.observedAt, "observation.observedAt");
  if (Date.parse(observedAt) > now.getTime() + 5 * 60 * 1000) fail("invalid-adapter-result", "observation.observedAt is in the future");
  const validUntil = new Date(Date.parse(observedAt) + binding.freshForSeconds * 1000).toISOString();
  if (!Array.isArray(observation.evidence)) fail("invalid-adapter-result", "observation.evidence must be an array");
  if (observation.evidence.length > binding.maxCandidates) {
    fail("invalid-adapter-result", `observation.evidence must contain at most ${binding.maxCandidates} items`);
  }
  const evidence = observation.evidence.map((item, index) => normalizeEvidenceItem(item, {
    observedAt,
    validUntil,
    checks: binding.checks,
    index,
  }));
  const ids = new Set();
  const checks = new Set();
  for (const item of evidence) {
    if (ids.has(item.id)) fail("invalid-adapter-result", `adapter returned duplicate evidence id ${item.id}`);
    if (checks.has(item.check)) fail("invalid-adapter-result", `adapter returned duplicate evidence check ${item.check}`);
    ids.add(item.id);
    checks.add(item.check);
  }
  for (const check of binding.checks) {
    if (!checks.has(check)) {
      evidence.push({
        id: `${binding.adapterId}-${check}`,
        check,
        state: "unknown",
        source: "integration",
        note: "The adapter returned no observation for this reviewed check.",
        observedAt,
        validUntil,
      });
    }
  }
  const result = {
    formatVersion: 1,
    identity: identityFor(binding),
    execution: { state: "succeeded", reason: "adapter-observation", cache: "none" },
    freshness: {
      state: freshnessFor(observedAt, validUntil, now),
      observedAt,
      validUntil,
      evaluatedAt: now.toISOString(),
    },
    evidence,
  };
  const deployment = normalizeDeployment(observation.deployment);
  const recurringCost = normalizeRecurringCost(observation.recurringCost, observedAt);
  if (deployment !== undefined) result.deployment = deployment;
  if (recurringCost !== undefined) result.recurringCost = recurringCost;
  return validateEvidenceAdapterResult(result);
}

export async function runEvidenceAdapter({ binding, adapter, environment = {}, resolveCredential, now, cache = null }) {
  const executionTime = asNow(now);
  const reviewedBinding = validateEvidenceBinding(binding, adapter);
  const key = evidenceBindingKey(reviewedBinding);
  let cached = null;
  try {
    cached = cache?.get(key) ?? null;
  } catch {
    cached = null;
  }
  let credential = null;
  if (reviewedBinding.credentialEnv !== null) {
    credential = environment[reviewedBinding.credentialEnv];
    if (typeof credential !== "string" || credential.trim() === "") {
      return failedResult(reviewedBinding, "credential-unavailable", executionTime, cached);
    }
  } else if (reviewedBinding.credentialRef !== null) {
    if (typeof resolveCredential !== "function") return failedResult(reviewedBinding, "credential-unavailable", executionTime, cached);
    try {
      credential = await resolveCredential(reviewedBinding.credentialRef);
    } catch {
      return failedResult(reviewedBinding, "credential-unavailable", executionTime, cached);
    }
    if (typeof credential !== "string" || credential.trim() === "") {
      return failedResult(reviewedBinding, "credential-unavailable", executionTime, cached);
    }
  }

  const controller = new AbortController();
  let timeout;
  const deadline = new Promise((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve({ timedOut: true });
    }, reviewedBinding.deadlineMs);
  });
  let outcome;
  try {
    const request = immutable({
      provider: reviewedBinding.provider,
      reviewedIdentity: structuredClone(reviewedBinding.reviewedIdentity),
      checks: [...reviewedBinding.checks],
      credential,
      now: executionTime.toISOString(),
      signal: controller.signal,
      limits: {
        deadlineMs: reviewedBinding.deadlineMs,
        maxPages: reviewedBinding.maxPages,
        maxResponseBytes: reviewedBinding.maxResponseBytes,
        maxCandidates: reviewedBinding.maxCandidates,
      },
    });
    outcome = await Promise.race([
      Promise.resolve()
        .then(() => adapter.collect(request))
        .then((observation) => ({ observation }))
        .catch(() => ({ failed: true })),
      deadline,
    ]);
  } finally {
    clearTimeout(timeout);
    credential = null;
  }
  if (outcome.timedOut) return failedResult(reviewedBinding, "adapter-timeout", executionTime, cached);
  if (outcome.failed) {
    return failedResult(reviewedBinding, "adapter-error", executionTime, cached);
  }
  const observation = outcome.observation;
  if (observation?.status !== "success") {
    return failedResult(reviewedBinding, reasonFromUnavailable(observation), executionTime, cached);
  }
  let normalized;
  try {
    normalized = normalizeSuccess(reviewedBinding, observation, executionTime);
  } catch (error) {
    const code = error instanceof EvidenceAdapterContractError ? error.code : "invalid-adapter-result";
    return failedResult(reviewedBinding, code, executionTime, cached);
  }
  trustedSuccessfulResults.add(normalized);
  try {
    cache?.set(key, normalized);
  } catch {
    // Cache availability must not turn a verified provider observation into a failed refresh.
  }
  return immutable(normalized);
}

function validateNormalizedIdentity(value) {
  object(value, "identity");
  exactFields(value, new Set(["projectId", "serviceId", "adapterId", "provider", "reviewedIdentity"]), "identity");
  id(value.projectId, "identity.projectId");
  id(value.serviceId, "identity.serviceId");
  id(value.adapterId, "identity.adapterId");
  id(value.provider, "identity.provider");
  return {
    projectId: value.projectId,
    serviceId: value.serviceId,
    adapterId: value.adapterId,
    provider: value.provider,
    reviewedIdentity: cloneSafeIdentity(value.reviewedIdentity, "identity.reviewedIdentity"),
  };
}

function validateNormalizedEvidence(value, index) {
  const field = `evidence[${index}]`;
  object(value, field);
  exactFields(value, new Set(["id", "check", "state", "source", "note", "observedAt", "validUntil", "url"]), field);
  id(value.id, `${field}.id`);
  if (!readinessChecks.has(value.check)) fail("invalid-contract", `${field}.check is invalid`);
  if (!safeEvidenceStates.has(value.state)) fail("invalid-contract", `${field}.state is invalid`);
  if (value.source !== "integration") fail("invalid-contract", `${field}.source must be integration`);
  const result = {
    id: value.id,
    check: value.check,
    state: value.state,
    source: "integration",
    note: string(value.note, `${field}.note`),
  };
  if (value.observedAt !== undefined) result.observedAt = dateTime(value.observedAt, `${field}.observedAt`);
  if (value.validUntil !== undefined) result.validUntil = dateTime(value.validUntil, `${field}.validUntil`);
  if ((result.observedAt === undefined) !== (result.validUntil === undefined)) {
    fail("invalid-contract", `${field}.observedAt and validUntil must be present together`);
  }
  if (value.url !== undefined) result.url = safeUrl(value.url, `${field}.url`);
  return result;
}

export function validateEvidenceAdapterResult(value) {
  object(value, "result");
  exactFields(value, new Set([
    "formatVersion", "identity", "execution", "freshness", "evidence", "deployment", "recurringCost",
  ]), "result");
  if (value.formatVersion !== 1) fail("unsupported-version", "result.formatVersion must be 1");
  const identity = validateNormalizedIdentity(value.identity);

  object(value.execution, "execution");
  exactFields(value.execution, new Set(["state", "reason", "cache"]), "execution");
  if (!executionStates.has(value.execution.state)) fail("invalid-contract", "execution.state is invalid");
  reason(value.execution.reason, "execution.reason");
  if (!cacheStates.has(value.execution.cache)) fail("invalid-contract", "execution.cache is invalid");

  object(value.freshness, "freshness");
  exactFields(value.freshness, new Set(["state", "observedAt", "validUntil", "evaluatedAt"]), "freshness");
  if (!freshnessStates.has(value.freshness.state)) fail("invalid-contract", "freshness.state is invalid");
  const observedAt = value.freshness.observedAt === null ? null : dateTime(value.freshness.observedAt, "freshness.observedAt");
  const validUntil = value.freshness.validUntil === null ? null : dateTime(value.freshness.validUntil, "freshness.validUntil");
  if ((observedAt === null) !== (validUntil === null)) fail("invalid-contract", "freshness timestamps must both be null or present");
  const evaluatedAt = dateTime(value.freshness.evaluatedAt, "freshness.evaluatedAt");

  if (!Array.isArray(value.evidence) || value.evidence.length === 0) fail("invalid-contract", "result.evidence must not be empty");
  if (value.evidence.length > MAX_EVIDENCE_ITEMS) {
    fail("invalid-contract", `result.evidence must contain at most ${MAX_EVIDENCE_ITEMS} items`);
  }
  const evidence = value.evidence.map(validateNormalizedEvidence);
  const evidenceIds = new Set();
  const evidenceChecks = new Set();
  for (const item of evidence) {
    if (evidenceIds.has(item.id)) fail("invalid-contract", `result.evidence duplicates id ${item.id}`);
    if (evidenceChecks.has(item.check)) fail("invalid-contract", `result.evidence duplicates check ${item.check}`);
    evidenceIds.add(item.id);
    evidenceChecks.add(item.check);
  }
  if (freshnessStates.has(value.freshness.state) && value.freshness.state !== "unknown" && observedAt === null) {
    fail("invalid-contract", "fresh or stale results need observation timestamps");
  }
  if (value.freshness.state === "unknown" && (observedAt !== null || validUntil !== null)) {
    fail("invalid-contract", "unknown freshness must not carry observation timestamps");
  }
  if (value.execution.state === "succeeded" && value.execution.cache !== "none") {
    fail("invalid-contract", "successful execution must not claim cached evidence");
  }
  if (value.execution.state === "failed" && value.execution.cache === "none" && value.freshness.state !== "unknown") {
    fail("invalid-contract", "failed uncached execution must have unknown freshness");
  }
  if (value.execution.state === "failed" && value.execution.cache === "none" && evidence.some((item) => item.state !== "unknown")) {
    fail("invalid-contract", "failed uncached execution may contain only unknown evidence");
  }
  if (value.execution.state === "failed" && value.execution.cache !== "none" && value.freshness.state !== value.execution.cache) {
    fail("invalid-contract", "cached execution and freshness states must agree");
  }

  const result = {
    formatVersion: 1,
    identity,
    execution: {
      state: value.execution.state,
      reason: value.execution.reason,
      cache: value.execution.cache,
    },
    freshness: { state: value.freshness.state, observedAt, validUntil, evaluatedAt },
    evidence,
  };
  if (value.deployment !== undefined) result.deployment = normalizeDeployment(value.deployment);
  if (value.recurringCost !== undefined) {
    object(value.recurringCost, "recurringCost");
    exactFields(value.recurringCost, new Set(["state", "observedAt", "url"]), "recurringCost");
    if (!costStates.has(value.recurringCost.state)) fail("invalid-contract", "recurringCost.state is invalid");
    const costObservedAt = dateTime(value.recurringCost.observedAt, "recurringCost.observedAt");
    const recurringCost = { state: value.recurringCost.state, observedAt: costObservedAt };
    if (value.recurringCost.url !== undefined) recurringCost.url = safeUrl(value.recurringCost.url, "recurringCost.url");
    result.recurringCost = recurringCost;
  }
  if (value.execution.state === "failed" && value.execution.cache === "none" && (result.deployment || result.recurringCost)) {
    fail("invalid-contract", "failed uncached execution must not contain provider summaries");
  }
  return immutable(result);
}

export function parseEvidenceAdapterResult(json) {
  if (typeof json !== "string") fail("invalid-json", "adapter result input must be a JSON string");
  let value;
  try {
    value = JSON.parse(json);
  } catch {
    fail("invalid-json", "adapter result input must contain valid JSON");
  }
  return validateEvidenceAdapterResult(value);
}
