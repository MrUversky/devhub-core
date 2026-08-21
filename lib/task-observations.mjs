import { createHash } from "node:crypto";

const BRIDGE_FIELDS = new Set(["formatVersion", "id", "connectorId", "acquisition", "maxResources", "normalize"]);
const DOCUMENT_FIELDS = new Set(["version", "selectedConnectorIds", "observations"]);
const OBSERVATION_FIELDS = new Set(["connectorId", "bridgeId", "observedAt", "scope", "resources"]);
const BOUND_FIELDS = new Set([
  "version", "connectorId", "bridgeId", "acquisition", "trust", "observedAt", "validUntil",
  "scope", "resourceCount", "normalizedInventory",
]);
const BOUND_CANDIDATE_FIELDS = new Set([
  "provider", "resourceType", "resourceId", "name", "urls", "observedAt", "validUntil", "freshness",
]);
const stableIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const secretAssignmentPattern = /\b(?:api[-_ ]?key|access[-_ ]?token|authorization|client[-_ ]?secret|password|passwd|private[-_ ]?key|secret|token)\s*[:=]\s*["']?(?!\$|\$\{|<|example\b|redacted\b)[A-Za-z0-9_./+=-]{8,}/i;
const secretValuePattern = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bbearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:github_pat_|gh[oprsu]_|sk-(?:proj-)?)[A-Za-z0-9_-]{8,})/i;
const unsafeLocatorPattern = /(?:\b(?:locator|credential|password|secret|token)\b|\b(?:op|https?):\/\/|generic-password:)/i;
const MAX_OBSERVATION_AGE_MS = 5 * 60 * 1_000;
const MAX_BRIDGE_RESOURCES = 1_000;

export class TaskObservationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TaskObservationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new TaskObservationError(code, message);
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactFields(value, fields, label) {
  if (!plainObject(value)) fail("task-observation-invalid", `${label} must be an object`);
  for (const key of Object.keys(value)) if (!fields.has(key)) fail("task-observation-invalid", `${label}.${key} is not supported`);
}

function requiredString(value, label, maximum = 240) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    fail("task-observation-invalid", `${label} must be a non-empty bounded string`);
  }
  const result = value.trim();
  if (secretAssignmentPattern.test(result) || secretValuePattern.test(result) || unsafeLocatorPattern.test(result)) {
    fail("task-observation-unsafe", `${label} must not contain credentials, locators or URLs`);
  }
  return result;
}

function stableId(value, label) {
  const result = requiredString(value, label, 100);
  if (!stableIdPattern.test(result)) fail("task-observation-invalid", `${label} must use lowercase kebab-case`);
  return result;
}

function timestamp(value, label) {
  const result = requiredString(value, label, 50);
  const parsed = new Date(result);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) {
    fail("task-observation-invalid", `${label} must be an ISO 8601 UTC timestamp`);
  }
  return result;
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function connectorValues(connectors) {
  if (connectors === undefined || connectors === null) return [];
  if (connectors instanceof Map) return [...connectors.values()];
  if (Array.isArray(connectors)) return [...connectors];
  if (plainObject(connectors)) return Object.values(connectors);
  fail("task-observation-bridge-invalid", "task observation connectors must be an array, map or object");
}

export function taskObservationDigest(value, length = 24) {
  if (!Number.isInteger(length) || length < 8 || length > 64) throw new TypeError("task observation digest length must be 8 to 64");
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, length);
}

export function normalizeTaskObservationLabel(value, label = "task observation label", maximum = 200) {
  return requiredString(value, label, maximum);
}

export function validateTaskObservationBridge(value) {
  exactFields(value, BRIDGE_FIELDS, "task observation bridge");
  if (value.formatVersion !== 1) fail("task-observation-bridge-invalid", "task observation bridge.formatVersion must be 1");
  const id = stableId(value.id, "task observation bridge.id");
  const connectorId = stableId(value.connectorId, "task observation bridge.connectorId");
  if (value.acquisition !== "provider-plugin-session") {
    fail("task-observation-bridge-invalid", `${connectorId} task observation acquisition is unsupported`);
  }
  if (!Number.isInteger(value.maxResources) || value.maxResources < 1 || value.maxResources > MAX_BRIDGE_RESOURCES) {
    fail("task-observation-bridge-invalid", `${connectorId} task observation maxResources must be 1 to ${MAX_BRIDGE_RESOURCES}`);
  }
  if (typeof value.normalize !== "function") fail("task-observation-bridge-invalid", `${connectorId} task observation bridge must expose normalize()`);
  return freeze({
    formatVersion: 1,
    id,
    connectorId,
    acquisition: "provider-plugin-session",
    maxResources: value.maxResources,
    normalize: value.normalize,
  });
}

export function createTaskObservationBridgeRegistry(connectors = []) {
  const registry = new Map();
  for (const connector of connectorValues(connectors)) {
    if (connector?.taskObservationBridge === undefined) continue;
    const bridge = validateTaskObservationBridge(connector.taskObservationBridge);
    if (connector.connectorId !== bridge.connectorId) {
      fail("task-observation-bridge-invalid", "task observation bridge connectorId must match its setup connector");
    }
    if (registry.has(bridge.connectorId)) fail("task-observation-bridge-invalid", `duplicate task observation bridge for ${bridge.connectorId}`);
    registry.set(bridge.connectorId, bridge);
  }
  return registry;
}

function validateSelectedConnectorIds(value, expected) {
  if (!Array.isArray(value) || value.length !== expected.length) {
    fail("task-observation-selection-mismatch", "task observation selectedConnectorIds must exactly match this setup-run selection");
  }
  const parsed = value.map((item, index) => stableId(item, `task observation selectedConnectorIds[${index}]`));
  if (new Set(parsed).size !== parsed.length || parsed.some((id, index) => id !== expected[index])) {
    fail("task-observation-selection-mismatch", "task observation selectedConnectorIds must exactly match canonical selected-source order");
  }
  return parsed;
}

function validateBoundObservation(value, bridge, raw, now) {
  exactFields(value, BOUND_FIELDS, `${bridge.connectorId} bound task observation`);
  if (value.version !== 1
      || value.connectorId !== bridge.connectorId
      || value.bridgeId !== bridge.id
      || value.acquisition !== bridge.acquisition
      || value.trust !== "untrusted-transient-review-only"
      || value.observedAt !== raw.observedAt) {
    fail("task-observation-bridge-invalid", `${bridge.connectorId} bridge returned mismatched task observation metadata`);
  }
  const validUntil = timestamp(value.validUntil, `${bridge.connectorId} bound task observation.validUntil`);
  if (Date.parse(validUntil) <= Date.parse(value.observedAt) || Date.parse(validUntil) > now.getTime() + MAX_OBSERVATION_AGE_MS) {
    fail("task-observation-bridge-invalid", `${bridge.connectorId} bridge returned invalid task observation freshness`);
  }
  exactFields(value.scope, new Set(["kind", "label"]), `${bridge.connectorId} bound task observation.scope`);
  const scope = {
    kind: stableId(value.scope.kind, `${bridge.connectorId} bound task observation.scope.kind`),
    label: requiredString(value.scope.label, `${bridge.connectorId} bound task observation.scope.label`, 200),
  };
  if (!Number.isInteger(value.resourceCount) || value.resourceCount < 0 || value.resourceCount > bridge.maxResources) {
    fail("task-observation-bridge-invalid", `${bridge.connectorId} bridge returned invalid resourceCount`);
  }
  const inventory = value.normalizedInventory;
  if (!plainObject(inventory)
      || inventory.formatVersion !== 1
      || inventory.source?.provider !== bridge.connectorId
      || inventory.source?.adapterId !== bridge.id
      || inventory.source?.scope?.kind !== scope.kind
      || !/^task-scope-[a-f0-9]{24}$/.test(inventory.source?.scope?.id ?? "")
      || inventory.execution?.state !== "succeeded"
      || inventory.execution?.reason !== "task-plugin-observation"
      || inventory.execution?.pagesRead !== 1
      || inventory.freshness?.state !== "fresh"
      || inventory.freshness?.observedAt !== value.observedAt
      || inventory.freshness?.validUntil !== validUntil
      || !Array.isArray(inventory.candidates)
      || inventory.candidates.length !== value.resourceCount) {
    fail("task-observation-bridge-invalid", `${bridge.connectorId} bridge returned an invalid normalized inventory envelope`);
  }
  for (const [index, candidate] of inventory.candidates.entries()) {
    exactFields(candidate, BOUND_CANDIDATE_FIELDS, `${bridge.connectorId} bridge candidate ${index}`);
    if (!plainObject(candidate)
        || candidate.provider !== bridge.connectorId
        || candidate.resourceType !== "project"
        || !/^task-resource-[a-f0-9]{24}$/.test(candidate.resourceId ?? "")
        || candidate.observedAt !== value.observedAt
        || candidate.validUntil !== validUntil
        || candidate.freshness !== "fresh"
        || !Array.isArray(candidate.urls)
        || candidate.urls.length !== 0) {
      fail("task-observation-bridge-invalid", `${bridge.connectorId} bridge candidate ${index} is not a task-local review-only candidate`);
    }
    requiredString(candidate.name, `${bridge.connectorId} bridge candidate ${index}.name`, 200);
  }
  return freeze({ ...value, scope, normalizedInventory: structuredClone(inventory) });
}

export function parseTaskObservationDocument(value, options = {}) {
  exactFields(value, DOCUMENT_FIELDS, "task observation document");
  if (value.version !== 1) fail("task-observation-invalid", "task observation document.version must be 1");
  const selectedConnectorIds = validateSelectedConnectorIds(value.selectedConnectorIds, options.selectedConnectorIds ?? []);
  const bridges = options.bridges ?? createTaskObservationBridgeRegistry(options.connectors);
  if (!Array.isArray(value.observations) || value.observations.length < 1 || value.observations.length > selectedConnectorIds.length) {
    fail("task-observation-invalid", "task observation document.observations must contain 1 to N selected observations");
  }
  const now = new Date(options.now ?? Date.now());
  if (!Number.isFinite(now.getTime())) fail("task-observation-invalid", "task observation validation requires a valid clock");
  const selectedOrder = new Map(selectedConnectorIds.map((connectorId, index) => [connectorId, index]));
  const seen = new Set();
  let priorIndex = -1;
  const observations = value.observations.map((raw, index) => {
    const label = `task observation document.observations[${index}]`;
    exactFields(raw, OBSERVATION_FIELDS, label);
    const connectorId = stableId(raw.connectorId, `${label}.connectorId`);
    const bridgeId = stableId(raw.bridgeId, `${label}.bridgeId`);
    const order = selectedOrder.get(connectorId);
    if (order === undefined || seen.has(connectorId) || order <= priorIndex) {
      fail("task-observation-selection-mismatch", "task observations must be unique selected sources in canonical selected-source order");
    }
    priorIndex = order;
    seen.add(connectorId);
    const bridge = bridges.get(connectorId);
    if (!bridge || bridge.id !== bridgeId) fail("task-observation-bridge-unavailable", `${connectorId} has no matching task observation bridge`);
    const observedAt = timestamp(raw.observedAt, `${label}.observedAt`);
    const age = now.getTime() - Date.parse(observedAt);
    if (age > MAX_OBSERVATION_AGE_MS || age < 0) {
      fail("task-observation-stale", `${connectorId} task observation must be current within five minutes`);
    }
    let normalized;
    try {
      normalized = bridge.normalize({
        connectorId,
        bridgeId,
        observedAt,
        scope: raw.scope,
        resources: raw.resources,
      }, { selectedConnectorIds, now: now.toISOString(), maxResources: bridge.maxResources });
    } catch (error) {
      if (error instanceof TaskObservationError) throw error;
      fail("task-observation-invalid", `${connectorId} task observation did not match its connector-owned bridge`);
    }
    return validateBoundObservation(normalized, bridge, { ...raw, connectorId, bridgeId, observedAt }, now);
  });
  return freeze({ version: 1, selectedConnectorIds, observations });
}
