const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ENV_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const FIELD_PATTERN = /^[a-z][a-zA-Z0-9]*$/;
const REASON_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SCOPE_KINDS = new Set(["account", "team", "workspace", "project"]);
const PARENT_SCOPE_KINDS = new Set(["account", "team", "workspace"]);
const STATUS_VALUES = new Set(["running", "stopped", "deploying", "failed", "unknown"]);
const URL_KINDS = new Set(["service", "console", "status", "documentation"]);
const FRESHNESS_VALUES = new Set(["fresh", "stale", "unknown"]);
const EXECUTION_VALUES = new Set(["succeeded", "failed"]);
const METADATA_FIELDS = new Set([
  "region", "plan", "version", "revision", "deployedAt", "workspaceId", "projectId", "serviceId", "environmentId", "deploymentId",
  "ownerType", "ownerId", "createdAt", "lastUsedAt",
]);
const SENSITIVE_KEY = /(?:^|[-_])(?:api[-_]?key|authorization|credential|password|private[-_]?key|secret|signature|token)(?:$|[-_])/i;
const SECRET_ASSIGNMENT = /\b(?:api[-_]?key|access[-_]?token|authorization|client[-_]?secret|password|passwd|private[-_]?key|secret|token)\s*[:=]\s*["']?(?!\$|\$\{|<|example\b|redacted\b)[A-Za-z0-9_./+=-]{8,}/i;
const SECRET_VALUE = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bbearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:github_pat_|gh[oprsu]_|sk-(?:proj-)?)[A-Za-z0-9_-]{8,})/i;
const DEFAULT_LIMITS = Object.freeze({ maxResources: 200, maxPages: 20, deadlineMs: 10_000, maxResponseBytes: 1024 * 1024 });
const MAX_FRESH_SECONDS = 30 * 24 * 60 * 60;
const MAX_RESOURCES = 1_000;
const MAX_PAGES = 100;
const MAX_DEADLINE_MS = 30_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_URLS = 20;

export class InventoryAdapterContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "InventoryAdapterContractError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new InventoryAdapterContractError(code, message);
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function object(value, field) {
  if (!plainObject(value)) fail("invalid-contract", `${field} must be a plain object`);
  return value;
}

function exactFields(value, fields, field) {
  for (const key of Object.keys(value)) {
    if (!fields.has(key)) fail("invalid-contract", `${field}.${key} is not supported`);
  }
}

function safeString(value, field, maximum = 300) {
  if (typeof value !== "string" || value.trim() === "") fail("invalid-contract", `${field} must be a non-empty string`);
  if (value.length > maximum) fail("invalid-contract", `${field} must contain at most ${maximum} characters`);
  if (value !== value.trim() || [...value].some((character) => {
    const code = character.codePointAt(0);
    return code < 32 || code === 127;
  })) fail("invalid-contract", `${field} contains unsupported whitespace or control characters`);
  if (SECRET_ASSIGNMENT.test(value) || SECRET_VALUE.test(value)) fail("unsafe-adapter-result", `${field} must not contain secret material`);
  return value;
}

function stableId(value, field) {
  const result = safeString(value, field, 100);
  if (!ID_PATTERN.test(result)) fail("invalid-contract", `${field} must use lowercase kebab-case`);
  return result;
}

function reasonCode(value, field) {
  const result = safeString(value, field, 100);
  if (!REASON_PATTERN.test(result)) fail("invalid-contract", `${field} must be a stable lowercase reason code`);
  return result;
}

function dateTime(value, field) {
  const result = safeString(value, field, 50);
  if (!result.includes("T") || !Number.isFinite(Date.parse(result))) fail("invalid-contract", `${field} must be an ISO 8601 date-time`);
  return new Date(result).toISOString();
}

function safeUrl(value, field) {
  const result = safeString(value, field, 2048);
  let parsed;
  try {
    parsed = new URL(result);
  } catch {
    fail("invalid-contract", `${field} must be an absolute HTTP(S) URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") fail("invalid-contract", `${field} must use HTTP(S)`);
  if (parsed.username || parsed.password) fail("unsafe-adapter-result", `${field} must not contain URL credentials`);
  for (const key of parsed.searchParams.keys()) {
    if (SENSITIVE_KEY.test(key)) fail("unsafe-adapter-result", `${field} must not contain secret-bearing query parameters`);
  }
  return result;
}

function boundedInteger(value, field, minimum, maximum, fallback) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    fail("invalid-contract", `${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return result;
}

function immutable(value) {
  // AbortSignal has internal mutable slots; freezing it makes abort() throw in Node.
  if (typeof AbortSignal !== "undefined" && value instanceof AbortSignal) return value;
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) immutable(child);
  }
  return value;
}

function normalizeScope(scope, field = "binding.scope") {
  object(scope, field);
  exactFields(scope, new Set(["kind", "id", "parent"]), field);
  if (!SCOPE_KINDS.has(scope.kind)) fail("invalid-scope", `${field}.kind is not supported`);
  const id = safeString(scope.id, `${field}.id`, 300);
  if (/^https?:\/\//i.test(id)) fail("invalid-scope", `${field}.id must be a provider identity, not a URL`);
  const result = { kind: scope.kind, id };
  if (scope.parent !== undefined) {
    object(scope.parent, `${field}.parent`);
    exactFields(scope.parent, new Set(["kind", "id"]), `${field}.parent`);
    if (!PARENT_SCOPE_KINDS.has(scope.parent.kind)) fail("invalid-scope", `${field}.parent.kind is not supported`);
    const parentId = safeString(scope.parent.id, `${field}.parent.id`, 300);
    if (/^https?:\/\//i.test(parentId)) fail("invalid-scope", `${field}.parent.id must be a provider identity, not a URL`);
    result.parent = { kind: scope.parent.kind, id: parentId };
  }
  return result;
}

function validateAdapter(adapter) {
  object(adapter, "adapter");
  stableId(adapter.id, "adapter.id");
  stableId(adapter.provider, "adapter.provider");
  if (typeof adapter.validateScope !== "function") fail("invalid-adapter", "adapter.validateScope must be a function");
  if (typeof adapter.collect !== "function") fail("invalid-adapter", "adapter.collect must be a function");
}

export function validateInventoryBinding(binding, adapter) {
  object(binding, "binding");
  exactFields(binding, new Set([
    "adapterId", "provider", "scope", "credentialEnv", "credentialRef", "freshForSeconds", "maxResources", "maxPages", "deadlineMs", "maxResponseBytes",
  ]), "binding");
  validateAdapter(adapter);
  const adapterId = stableId(binding.adapterId, "binding.adapterId");
  const provider = stableId(binding.provider, "binding.provider");
  if (adapterId !== adapter.id || provider !== adapter.provider) {
    fail("adapter-binding-mismatch", "binding adapter and provider must exactly match the selected adapter");
  }
  const scope = normalizeScope(binding.scope);
  let scopeAccepted = false;
  try {
    scopeAccepted = adapter.validateScope(immutable(structuredClone(scope))) === true;
  } catch {
    fail("invalid-scope", "binding.scope was rejected by the selected adapter");
  }
  if (!scopeAccepted) fail("invalid-scope", "binding.scope was rejected by the selected adapter");
  let credentialEnv = null;
  if (binding.credentialEnv !== undefined && binding.credentialEnv !== null) {
    credentialEnv = safeString(binding.credentialEnv, "binding.credentialEnv", 100);
    if (!ENV_PATTERN.test(credentialEnv)) fail("invalid-credential-environment", "binding.credentialEnv must name an uppercase environment variable");
  }
  let credentialRef = null;
  if (binding.credentialRef !== undefined && binding.credentialRef !== null) {
    try {
      credentialRef = parseCredentialReference(binding.credentialRef, "binding.credentialRef");
    } catch {
      fail("invalid-credential-reference", "binding.credentialRef must be a reviewed external credential reference");
    }
  }
  if (credentialEnv !== null && credentialRef !== null) {
    fail("invalid-credential-reference", "binding must use exactly one of credentialEnv or credentialRef");
  }
  const freshForSeconds = boundedInteger(binding.freshForSeconds, "binding.freshForSeconds", 60, MAX_FRESH_SECONDS);
  const maxResources = boundedInteger(binding.maxResources, "binding.maxResources", 1, MAX_RESOURCES, DEFAULT_LIMITS.maxResources);
  const maxPages = boundedInteger(binding.maxPages, "binding.maxPages", 1, MAX_PAGES, DEFAULT_LIMITS.maxPages);
  const deadlineMs = boundedInteger(binding.deadlineMs, "binding.deadlineMs", 100, MAX_DEADLINE_MS, DEFAULT_LIMITS.deadlineMs);
  const maxResponseBytes = boundedInteger(
    binding.maxResponseBytes,
    "binding.maxResponseBytes",
    1,
    MAX_RESPONSE_BYTES,
    DEFAULT_LIMITS.maxResponseBytes,
  );
  return immutable({ adapterId, provider, scope, credentialEnv, credentialRef, freshForSeconds, maxResources, maxPages, deadlineMs, maxResponseBytes });
}

function asNow(value) {
  const result = value === undefined ? new Date() : new Date(value);
  if (Number.isNaN(result.getTime())) fail("invalid-now", "inventory execution requires a valid now value");
  return result;
}

function failedResult(binding, reason, now, pagesRead = 0) {
  return immutable(validateNormalizedInventoryResult({
    formatVersion: 1,
    source: { adapterId: binding.adapterId, provider: binding.provider, scope: structuredClone(binding.scope) },
    execution: { state: "failed", reason, pagesRead },
    freshness: { state: "unknown", observedAt: null, validUntil: null, evaluatedAt: now.toISOString() },
    candidates: [],
  }));
}

function normalizeUrl(value, field) {
  object(value, field);
  exactFields(value, new Set(["kind", "url"]), field);
  if (!URL_KINDS.has(value.kind)) fail("invalid-adapter-result", `${field}.kind is invalid`);
  return { kind: value.kind, url: safeUrl(value.url, `${field}.url`) };
}

function normalizeRepository(value, field) {
  object(value, field);
  exactFields(value, new Set(["provider", "owner", "name", "ref"]), field);
  const result = {
    provider: stableId(value.provider, `${field}.provider`),
    owner: safeString(value.owner, `${field}.owner`, 100),
    name: safeString(value.name, `${field}.name`, 100),
  };
  if (/[/\s]/.test(result.owner) || /[/\s]/.test(result.name)) fail("invalid-adapter-result", `${field} owner and name must be single repository path segments`);
  if (value.ref !== undefined) result.ref = safeString(value.ref, `${field}.ref`, 300);
  return result;
}

function normalizeMetadata(value, field) {
  object(value, field);
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (!FIELD_PATTERN.test(key) || !METADATA_FIELDS.has(key)) fail("invalid-adapter-result", `${field}.${key} is not allowlisted`);
    if (SENSITIVE_KEY.test(key)) fail("unsafe-adapter-result", `${field}.${key} must not contain credential data`);
    const item = value[key];
    if (typeof item === "string") result[key] = safeString(item, `${field}.${key}`, 300);
    else if (typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) result[key] = item;
    else fail("invalid-adapter-result", `${field}.${key} must be a safe scalar`);
  }
  return result;
}

function normalizeCandidate(value, { binding, rootObservedAt, validUntil, now, index, normalized = false }) {
  const field = `candidates[${index}]`;
  object(value, field);
  exactFields(value, new Set([
    "provider", "resourceType", "resourceId", "parentResourceId", "name", "environment", "runtime", "status",
    "urls", "repository", "observedAt", "validUntil", "freshness", "metadata",
  ]), field);
  if (value.provider !== binding.provider) fail("provider-mismatch", `${field}.provider must match the reviewed binding`);
  const observedAt = dateTime(value.observedAt ?? rootObservedAt, `${field}.observedAt`);
  if (Date.parse(observedAt) > now.getTime() + 5 * 60 * 1000) fail("invalid-adapter-result", `${field}.observedAt is in the future`);
  const candidateValidUntil = normalized ? dateTime(value.validUntil, `${field}.validUntil`) : validUntil(observedAt);
  const freshness = Date.parse(candidateValidUntil) < now.getTime() ? "stale" : "fresh";
  if (normalized && value.freshness !== freshness) fail("invalid-contract", `${field}.freshness does not match its timestamps`);
  if (!Array.isArray(value.urls) || value.urls.length > MAX_URLS) fail("invalid-adapter-result", `${field}.urls must contain at most ${MAX_URLS} items`);
  const urls = value.urls.map((url, urlIndex) => normalizeUrl(url, `${field}.urls[${urlIndex}]`));
  if (new Set(urls.map((item) => `${item.kind}\u0000${item.url}`)).size !== urls.length) fail("invalid-adapter-result", `${field}.urls contains duplicates`);
  const result = {
    provider: binding.provider,
    resourceType: safeString(value.resourceType, `${field}.resourceType`, 100),
    resourceId: safeString(value.resourceId, `${field}.resourceId`, 300),
    name: safeString(value.name, `${field}.name`, 300),
    urls,
    observedAt,
    validUntil: candidateValidUntil,
    freshness,
  };
  if (value.parentResourceId !== undefined) result.parentResourceId = safeString(value.parentResourceId, `${field}.parentResourceId`, 300);
  if (value.environment !== undefined) result.environment = safeString(value.environment, `${field}.environment`, 100);
  if (value.runtime !== undefined) result.runtime = safeString(value.runtime, `${field}.runtime`, 100);
  if (value.status !== undefined) {
    if (!STATUS_VALUES.has(value.status)) fail("invalid-adapter-result", `${field}.status is not a supported observation state`);
    result.status = value.status;
  }
  if (value.repository !== undefined) result.repository = normalizeRepository(value.repository, `${field}.repository`);
  if (value.metadata !== undefined) result.metadata = normalizeMetadata(value.metadata, `${field}.metadata`);
  return result;
}

function reasonFromUnavailable(observation) {
  if (!plainObject(observation) || observation.status !== "unavailable") return "invalid-adapter-result";
  try {
    exactFields(observation, new Set(["status", "reason"]), "observation");
    return reasonCode(observation.reason, "observation.reason");
  } catch {
    return "invalid-adapter-result";
  }
}

function normalizeSuccess(binding, observation, now) {
  object(observation, "observation");
  exactFields(observation, new Set(["status", "observedAt", "pagesRead", "candidates"]), "observation");
  if (observation.status !== "success") fail("invalid-adapter-result", "observation.status must be success");
  const observedAt = dateTime(observation.observedAt, "observation.observedAt");
  if (Date.parse(observedAt) > now.getTime() + 5 * 60 * 1000) fail("invalid-adapter-result", "observation.observedAt is in the future");
  const pagesRead = boundedInteger(observation.pagesRead, "observation.pagesRead", 0, binding.maxPages);
  if (!Array.isArray(observation.candidates) || observation.candidates.length > binding.maxResources) {
    fail("resource-limit-exceeded", `observation.candidates exceeds the reviewed limit of ${binding.maxResources}`);
  }
  const rootValidUntil = new Date(Date.parse(observedAt) + binding.freshForSeconds * 1000).toISOString();
  const candidates = observation.candidates.map((candidate, index) => normalizeCandidate(candidate, {
    binding,
    rootObservedAt: observedAt,
    validUntil: (candidateObservedAt) => new Date(Date.parse(candidateObservedAt) + binding.freshForSeconds * 1000).toISOString(),
    now,
    index,
  }));
  const identities = new Set();
  for (const candidate of candidates) {
    const key = `${candidate.resourceType}\u0000${candidate.resourceId}`;
    if (identities.has(key)) fail("invalid-adapter-result", `adapter returned duplicate resource ${candidate.resourceType}/${candidate.resourceId}`);
    identities.add(key);
  }
  return validateNormalizedInventoryResult({
    formatVersion: 1,
    source: { adapterId: binding.adapterId, provider: binding.provider, scope: structuredClone(binding.scope) },
    execution: { state: "succeeded", reason: "adapter-observation", pagesRead },
    freshness: {
      state: Date.parse(rootValidUntil) < now.getTime() ? "stale" : "fresh",
      observedAt,
      validUntil: rootValidUntil,
      evaluatedAt: now.toISOString(),
    },
    candidates,
  });
}

export async function runInventoryAdapter({ binding, adapter, environment = {}, resolveCredential, now, signal }) {
  const executionTime = asNow(now);
  const reviewedBinding = validateInventoryBinding(binding, adapter);
  let credential = null;
  if (reviewedBinding.credentialEnv !== null) {
    credential = environment[reviewedBinding.credentialEnv];
    if (typeof credential !== "string" || credential.trim() === "") {
      return failedResult(reviewedBinding, "credential-unavailable", executionTime);
    }
  } else if (reviewedBinding.credentialRef !== null) {
    if (typeof resolveCredential !== "function") return failedResult(reviewedBinding, "credential-unavailable", executionTime);
    try {
      credential = await resolveCredential(reviewedBinding.credentialRef);
    } catch {
      return failedResult(reviewedBinding, "credential-unavailable", executionTime);
    }
    if (typeof credential !== "string" || credential.trim() === "") {
      return failedResult(reviewedBinding, "credential-unavailable", executionTime);
    }
  }
  const controller = new AbortController();
  let timeout;
  let externalAbortHandler;
  const deadline = new Promise((resolve) => {
    externalAbortHandler = () => {
      controller.abort();
      resolve({ aborted: true });
    };
    if (signal?.aborted) externalAbortHandler();
    else signal?.addEventListener?.("abort", externalAbortHandler, { once: true });
    timeout = setTimeout(() => {
      controller.abort();
      resolve({ timedOut: true });
    }, reviewedBinding.deadlineMs);
  });
  let outcome;
  try {
    const request = immutable({
      provider: reviewedBinding.provider,
      scope: structuredClone(reviewedBinding.scope),
      credential,
      now: executionTime.toISOString(),
      limits: {
        maxResources: reviewedBinding.maxResources,
        maxPages: reviewedBinding.maxPages,
        deadlineMs: reviewedBinding.deadlineMs,
        maxResponseBytes: reviewedBinding.maxResponseBytes,
      },
      signal: controller.signal,
    });
    outcome = await Promise.race([
      Promise.resolve().then(() => adapter.collect(request)).then((observation) => ({ observation })).catch(() => ({ failed: true })),
      deadline,
    ]);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener?.("abort", externalAbortHandler);
  }
  if (outcome.aborted) return failedResult(reviewedBinding, "adapter-aborted", executionTime);
  if (outcome.timedOut) return failedResult(reviewedBinding, "adapter-timeout", executionTime);
  if (outcome.failed) return failedResult(reviewedBinding, "adapter-error", executionTime);
  if (outcome.observation?.status !== "success") {
    return failedResult(reviewedBinding, reasonFromUnavailable(outcome.observation), executionTime);
  }
  try {
    return immutable(normalizeSuccess(reviewedBinding, outcome.observation, executionTime));
  } catch (error) {
    const code = error instanceof InventoryAdapterContractError ? error.code : "invalid-adapter-result";
    return failedResult(reviewedBinding, code, executionTime);
  }
}

export function validateNormalizedInventoryResult(value) {
  object(value, "result");
  exactFields(value, new Set(["formatVersion", "source", "execution", "freshness", "candidates"]), "result");
  if (value.formatVersion !== 1) fail("unsupported-version", "result.formatVersion must be 1");
  object(value.source, "source");
  exactFields(value.source, new Set(["adapterId", "provider", "scope"]), "source");
  const source = {
    adapterId: stableId(value.source.adapterId, "source.adapterId"),
    provider: stableId(value.source.provider, "source.provider"),
    scope: normalizeScope(value.source.scope, "source.scope"),
  };
  object(value.execution, "execution");
  exactFields(value.execution, new Set(["state", "reason", "pagesRead"]), "execution");
  if (!EXECUTION_VALUES.has(value.execution.state)) fail("invalid-contract", "execution.state is invalid");
  const execution = {
    state: value.execution.state,
    reason: reasonCode(value.execution.reason, "execution.reason"),
    pagesRead: boundedInteger(value.execution.pagesRead, "execution.pagesRead", 0, MAX_PAGES),
  };
  object(value.freshness, "freshness");
  exactFields(value.freshness, new Set(["state", "observedAt", "validUntil", "evaluatedAt"]), "freshness");
  if (!FRESHNESS_VALUES.has(value.freshness.state)) fail("invalid-contract", "freshness.state is invalid");
  const evaluatedAt = dateTime(value.freshness.evaluatedAt, "freshness.evaluatedAt");
  const observedAt = value.freshness.observedAt === null ? null : dateTime(value.freshness.observedAt, "freshness.observedAt");
  const validUntil = value.freshness.validUntil === null ? null : dateTime(value.freshness.validUntil, "freshness.validUntil");
  if ((observedAt === null) !== (validUntil === null)) fail("invalid-contract", "freshness timestamps must both be null or present");
  const expectedFreshness = observedAt === null ? "unknown" : (Date.parse(validUntil) < Date.parse(evaluatedAt) ? "stale" : "fresh");
  if (value.freshness.state !== expectedFreshness) fail("invalid-contract", "freshness.state does not match its timestamps");
  if (!Array.isArray(value.candidates) || value.candidates.length > MAX_RESOURCES) fail("invalid-contract", `result.candidates must contain at most ${MAX_RESOURCES} items`);
  if (execution.state === "failed" && (value.freshness.state !== "unknown" || value.candidates.length !== 0)) {
    fail("invalid-contract", "failed inventory results must be unknown and contain no candidates");
  }
  if (execution.state === "succeeded" && observedAt === null) fail("invalid-contract", "successful inventory results require timestamps");
  const binding = { provider: source.provider };
  const candidates = value.candidates.map((candidate, index) => normalizeCandidate(candidate, {
    binding,
    rootObservedAt: observedAt,
    validUntil: () => validUntil,
    now: new Date(evaluatedAt),
    index,
    normalized: true,
  }));
  const identities = new Set();
  for (const candidate of candidates) {
    const key = `${candidate.resourceType}\u0000${candidate.resourceId}`;
    if (identities.has(key)) fail("invalid-contract", `result.candidates duplicates ${candidate.resourceType}/${candidate.resourceId}`);
    identities.add(key);
  }
  return immutable({
    formatVersion: 1,
    source,
    execution,
    freshness: { state: value.freshness.state, observedAt, validUntil, evaluatedAt },
    candidates,
  });
}

export function parseNormalizedInventoryResult(json) {
  if (typeof json !== "string") fail("invalid-json", "inventory result input must be a JSON string");
  let value;
  try {
    value = JSON.parse(json);
  } catch {
    fail("invalid-json", "inventory result input must contain valid JSON");
  }
  return validateNormalizedInventoryResult(value);
}
import { parseCredentialReference } from "./setup-session.mjs";
