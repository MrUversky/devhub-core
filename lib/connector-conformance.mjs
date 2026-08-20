import { CONNECTOR_CATALOG } from "./connectors.mjs";
import { runEvidenceAdapter, validateEvidenceBinding } from "./evidence-adapters.mjs";
import { runInventoryAdapter, validateInventoryBinding } from "./inventory-adapters.mjs";

export const CONNECTOR_CONTRACT_VERSION = 1;

export const CONNECTOR_CONFORMANCE_CEILINGS = Object.freeze({
  deadlineMs: 30_000,
  maxPages: 100,
  maxResponseBytes: 2 * 1024 * 1024,
  maxCandidates: 1_000,
});

const CONTRACT_FIELDS = new Set([
  "formatVersion", "connectorId", "provider", "compatibility", "capabilities", "limits", "boundaries",
]);
const COMPATIBILITY_FIELDS = new Set([
  "status", "since", "deprecatedSince", "replacementConnectorId",
]);
const CAPABILITY_GROUPS = Object.freeze(["profiles", "setup", "inventory", "evidence"]);
const CAPABILITY_FIELDS = new Set(["id", "formatVersion"]);
const LIMIT_FIELDS = new Set(["deadlineMs", "maxPages", "maxResponseBytes", "maxCandidates"]);
const BOUNDARY_REQUIREMENTS = Object.freeze({
  exactScope: true,
  credentialIsolation: true,
  readOnly: true,
  hardDeadline: true,
  boundedPagination: true,
  boundedResponses: true,
  boundedCandidates: true,
  freshnessRequired: true,
  secretsRejected: true,
  normalizedOnly: true,
  providerMutations: false,
  catalogWrites: false,
  catalogMatching: false,
  ownershipDecisions: false,
});
const BOUNDARY_FIELDS = new Set(Object.keys(BOUNDARY_REQUIREMENTS));
const COMPATIBILITY_STATUSES = new Set(["experimental", "supported", "deprecated"]);
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

export class ConnectorConformanceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ConnectorConformanceError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ConnectorConformanceError(code, message);
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function object(value, field) {
  if (!plainObject(value)) fail("invalid-connector-contract", `${field} must be a plain object`);
  return value;
}

function exactFields(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("invalid-connector-contract", `${field}.${key} is not supported`);
  }
}

function stableId(value, field) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    fail("invalid-connector-contract", `${field} must use lowercase kebab-case`);
  }
  return value;
}

function version(value, field) {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    fail("invalid-connector-contract", `${field} must be a semantic version`);
  }
  return value;
}

function exactInteger(value, field, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail("connector-limit-exceeded", `${field} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function normalizeCompatibility(value, connectorId) {
  object(value, "contract.compatibility");
  exactFields(value, COMPATIBILITY_FIELDS, "contract.compatibility");
  if (!COMPATIBILITY_STATUSES.has(value.status)) {
    fail("invalid-connector-contract", "contract.compatibility.status is not supported");
  }
  const since = version(value.since, "contract.compatibility.since");
  const deprecatedSince = value.deprecatedSince === null
    ? null
    : version(value.deprecatedSince, "contract.compatibility.deprecatedSince");
  const replacementConnectorId = value.replacementConnectorId === null
    ? null
    : stableId(value.replacementConnectorId, "contract.compatibility.replacementConnectorId");
  if (value.status === "deprecated" && deprecatedSince === null) {
    fail("invalid-connector-contract", "deprecated connector contracts require deprecatedSince");
  }
  if (value.status !== "deprecated" && (deprecatedSince !== null || replacementConnectorId !== null)) {
    fail("invalid-connector-contract", "only deprecated connector contracts may declare deprecation metadata");
  }
  if (replacementConnectorId === connectorId) {
    fail("invalid-connector-contract", "a deprecated connector cannot replace itself");
  }
  return { status: value.status, since, deprecatedSince, replacementConnectorId };
}

function normalizeCapabilityList(value, kind) {
  if (!Array.isArray(value)) {
    fail("invalid-connector-contract", `contract.capabilities.${kind} must be an array`);
  }
  if ((kind === "profiles" || kind === "setup") && value.length > 1) {
    fail("invalid-connector-contract", `contract.capabilities.${kind} may contain at most one capability`);
  }
  const seen = new Set();
  return value.map((capability, index) => {
    const field = `contract.capabilities.${kind}[${index}]`;
    object(capability, field);
    exactFields(capability, CAPABILITY_FIELDS, field);
    const id = stableId(capability.id, `${field}.id`);
    if (capability.formatVersion !== 1) {
      fail("unsupported-capability-version", `${field}.formatVersion must be 1`);
    }
    if (seen.has(id)) fail("invalid-connector-contract", `${field}.id duplicates ${id}`);
    seen.add(id);
    return { id, formatVersion: 1 };
  });
}

function normalizeCapabilities(value, connectorId) {
  object(value, "contract.capabilities");
  exactFields(value, new Set(CAPABILITY_GROUPS), "contract.capabilities");
  const result = Object.fromEntries(CAPABILITY_GROUPS.map((kind) => [
    kind,
    normalizeCapabilityList(value[kind], kind),
  ]));
  if (result.profiles.some(({ id }) => id !== connectorId)) {
    fail("connector-capability-mismatch", "connection-profile capability ID must match connectorId");
  }
  if (result.setup.some(({ id }) => id !== connectorId)) {
    fail("connector-capability-mismatch", "setup capability ID must match connectorId");
  }
  if (result.setup.length && result.profiles.length === 0) {
    fail("connector-capability-mismatch", "setup capability requires a versioned connection-profile capability");
  }
  if (result.setup.length + result.inventory.length + result.evidence.length === 0) {
    fail("invalid-connector-contract", "a connector contract must expose setup, inventory or evidence collection");
  }
  return result;
}

function normalizeLimits(value) {
  object(value, "contract.limits");
  exactFields(value, LIMIT_FIELDS, "contract.limits");
  return {
    deadlineMs: exactInteger(value.deadlineMs, "contract.limits.deadlineMs", CONNECTOR_CONFORMANCE_CEILINGS.deadlineMs),
    maxPages: exactInteger(value.maxPages, "contract.limits.maxPages", CONNECTOR_CONFORMANCE_CEILINGS.maxPages),
    maxResponseBytes: exactInteger(
      value.maxResponseBytes,
      "contract.limits.maxResponseBytes",
      CONNECTOR_CONFORMANCE_CEILINGS.maxResponseBytes,
    ),
    maxCandidates: exactInteger(
      value.maxCandidates,
      "contract.limits.maxCandidates",
      CONNECTOR_CONFORMANCE_CEILINGS.maxCandidates,
    ),
  };
}

function normalizeBoundaries(value) {
  object(value, "contract.boundaries");
  exactFields(value, BOUNDARY_FIELDS, "contract.boundaries");
  const result = {};
  for (const [name, required] of Object.entries(BOUNDARY_REQUIREMENTS)) {
    if (value[name] !== required) {
      fail("unsafe-connector-contract", `contract.boundaries.${name} must be ${required}`);
    }
    result[name] = required;
  }
  return result;
}

export function validateConnectorContract(value) {
  object(value, "contract");
  exactFields(value, CONTRACT_FIELDS, "contract");
  if (value.formatVersion !== CONNECTOR_CONTRACT_VERSION) {
    fail("unsupported-connector-contract-version", `contract.formatVersion must be ${CONNECTOR_CONTRACT_VERSION}`);
  }
  const connectorId = stableId(value.connectorId, "contract.connectorId");
  const provider = stableId(value.provider, "contract.provider");
  return deepFreeze({
    formatVersion: CONNECTOR_CONTRACT_VERSION,
    connectorId,
    provider,
    compatibility: normalizeCompatibility(value.compatibility, connectorId),
    capabilities: normalizeCapabilities(value.capabilities, connectorId),
    limits: normalizeLimits(value.limits),
    boundaries: normalizeBoundaries(value.boundaries),
  });
}

export function defineConnectorContract(value) {
  return validateConnectorContract(value);
}

function connectorDefinitionsById(connectorCatalog) {
  if (!Array.isArray(connectorCatalog)) {
    fail("invalid-connector-registry", "connectorCatalog must be an array of canonical connector definitions");
  }
  const result = new Map();
  for (const definition of connectorCatalog) {
    const id = stableId(definition?.id, "connector definition id");
    if (result.has(id)) fail("invalid-connector-registry", `connectorCatalog duplicates ${id}`);
    result.set(id, definition);
  }
  return result;
}

function iterableValues(value, field) {
  if (value === undefined || value === null) return [];
  if (value instanceof Map) return [...value.values()];
  if (Array.isArray(value)) return [...value];
  if (plainObject(value) && Array.isArray(value.ids) && typeof value.get === "function") {
    return value.ids.map((id) => value.get(id));
  }
  if (plainObject(value)) return Object.values(value);
  fail("invalid-connector-registry", `${field} must be an array, map, object or { ids, get } registry`);
}

function runtimeMap(value, kind) {
  const map = new Map();
  for (const runtime of iterableValues(value, `${kind} runtimes`)) {
    if (!plainObject(runtime)) fail("invalid-connector-runtime", `${kind} runtime must be a plain object`);
    const id = kind === "setup"
      ? stableId(runtime.connectorId, "setup runtime.connectorId")
      : stableId(runtime.id, `${kind} runtime.id`);
    if (map.has(id)) fail("invalid-connector-runtime", `${kind} runtime duplicates ${id}`);
    if (typeof runtime.collect !== "function") fail("invalid-connector-runtime", `${kind} runtime ${id} must expose collect()`);
    if (kind === "inventory" && typeof runtime.validateScope !== "function") {
      fail("invalid-connector-runtime", `inventory runtime ${id} must expose validateScope()`);
    }
    if (kind === "evidence" && typeof runtime.validateIdentity !== "function") {
      fail("invalid-connector-runtime", `evidence runtime ${id} must expose validateIdentity()`);
    }
    map.set(id, runtime);
  }
  return map;
}

function validateRuntimeClaims(runtimes, claims) {
  for (const kind of ["setup", "inventory", "evidence"]) {
    for (const id of runtimes[kind].keys()) {
      const count = claims.get(`${kind}:${id}`) ?? 0;
      if (count !== 1) {
        fail(
          count === 0 ? "connector-runtime-unclaimed" : "connector-runtime-claimed-multiple-times",
          `${kind} runtime ${id} must be claimed by exactly one connector contract`,
        );
      }
    }
  }
}

function connectorEntry(byId, connectorId) {
  const entry = byId.get(connectorId);
  if (!entry) fail("connector-runtime-missing", `connector ${connectorId} has no bound runtime contract`);
  return entry;
}

function capabilityRuntime(entry, kind, adapterId) {
  const claimed = entry.contract.capabilities[kind].some((capability) => capability.id === adapterId);
  if (!claimed) {
    fail("connector-runtime-unclaimed", `${kind} runtime ${adapterId} is not claimed by connector ${entry.contract.connectorId}`);
  }
  const runtime = entry.runtimes[kind].find((candidate) => candidate.id === adapterId);
  if (!runtime) fail("connector-runtime-missing", `${kind} runtime ${adapterId} is unavailable`);
  return runtime;
}

function enforceInventoryLimits(contract, binding) {
  const comparisons = [
    ["deadlineMs", binding.deadlineMs, contract.limits.deadlineMs],
    ["maxPages", binding.maxPages, contract.limits.maxPages],
    ["maxResources", binding.maxResources, contract.limits.maxCandidates],
    ["maxResponseBytes", binding.maxResponseBytes, contract.limits.maxResponseBytes],
  ];
  for (const [name, requested, maximum] of comparisons) {
    if (requested > maximum) {
      fail("connector-limit-exceeded", `${contract.connectorId} binding.${name} exceeds its connector contract limit of ${maximum}`);
    }
  }
}

function enforceRequestedLimits(contract, binding, mappings) {
  for (const [bindingField, contractField] of mappings) {
    const requested = binding?.[bindingField];
    const maximum = contract.limits[contractField];
    if (requested !== undefined && Number.isFinite(requested) && requested > maximum) {
      fail("connector-limit-exceeded", `${contract.connectorId} binding.${bindingField} exceeds its connector contract limit of ${maximum}`);
    }
  }
}

function enforceEvidenceLimits(contract, binding) {
  const comparisons = [
    ["deadlineMs", binding.deadlineMs, contract.limits.deadlineMs],
    ["maxPages", binding.maxPages, contract.limits.maxPages],
    ["maxResponseBytes", binding.maxResponseBytes, contract.limits.maxResponseBytes],
    ["maxCandidates", binding.maxCandidates, contract.limits.maxCandidates],
  ];
  for (const [name, requested, maximum] of comparisons) {
    if (requested > maximum) {
      fail("connector-limit-exceeded", `${contract.connectorId} binding.${name} exceeds its connector contract limit of ${maximum}`);
    }
  }
}

function claimedContract(contracts, kind, runtime) {
  if (!Array.isArray(contracts) || contracts.length === 0) {
    fail("invalid-connector-registry", "contracts must be a non-empty array");
  }
  const claims = contracts
    .map(validateConnectorContract)
    .filter((contract) => contract.capabilities[kind].some((capability) => capability.id === runtime.id));
  if (claims.length !== 1) {
    fail(
      claims.length === 0 ? "connector-runtime-unclaimed" : "connector-runtime-claimed-multiple-times",
      `${kind} runtime ${runtime.id} must be claimed by exactly one connector contract`,
    );
  }
  const [contract] = claims;
  if (runtime.provider !== contract.provider) {
    fail("connector-runtime-mismatch", `${kind} runtime ${runtime.id} provider does not match ${contract.provider}`);
  }
  return contract;
}

export function validateConnectorInventoryExecution({ contracts, binding, adapter }) {
  const contract = claimedContract(contracts, "inventory", adapter);
  enforceRequestedLimits(contract, binding, [
    ["deadlineMs", "deadlineMs"],
    ["maxPages", "maxPages"],
    ["maxResources", "maxCandidates"],
    ["maxResponseBytes", "maxResponseBytes"],
  ]);
  const reviewedBinding = validateInventoryBinding({
    ...binding,
    deadlineMs: binding?.deadlineMs ?? Math.min(10_000, contract.limits.deadlineMs),
    maxPages: binding?.maxPages ?? Math.min(20, contract.limits.maxPages),
    maxResources: binding?.maxResources ?? Math.min(200, contract.limits.maxCandidates),
    maxResponseBytes: binding?.maxResponseBytes ?? Math.min(1024 * 1024, contract.limits.maxResponseBytes),
  }, adapter);
  enforceInventoryLimits(contract, reviewedBinding);
  return deepFreeze({ contract, binding: reviewedBinding, adapter });
}

export function validateConnectorEvidenceExecution({ contracts, binding, adapter }) {
  const contract = claimedContract(contracts, "evidence", adapter);
  enforceRequestedLimits(contract, binding, [
    ["deadlineMs", "deadlineMs"],
    ["maxPages", "maxPages"],
    ["maxResponseBytes", "maxResponseBytes"],
    ["maxCandidates", "maxCandidates"],
  ]);
  const reviewedBinding = validateEvidenceBinding({
    ...binding,
    deadlineMs: binding?.deadlineMs ?? Math.min(10_000, contract.limits.deadlineMs),
    maxPages: binding?.maxPages ?? Math.min(20, contract.limits.maxPages),
    maxResponseBytes: binding?.maxResponseBytes ?? Math.min(1024 * 1024, contract.limits.maxResponseBytes),
    maxCandidates: binding?.maxCandidates ?? Math.min(50, contract.limits.maxCandidates),
  }, adapter);
  enforceEvidenceLimits(contract, reviewedBinding);
  return deepFreeze({ contract, binding: reviewedBinding, adapter });
}

function definitionSupports(definition, capabilityKind) {
  if (capabilityKind === "profiles" || capabilityKind === "setup") return true;
  if (capabilityKind === "inventory") return definition.capabilities?.includes("inventory") === true;
  return definition.capabilities?.some((capability) => (
    ["deployments", "monitoring", "ownership", "costs", "recovery", "key-metadata"].includes(capability)
  )) === true;
}

export function createConnectorContractRegistry({
  contracts,
  connectorCatalog = CONNECTOR_CATALOG,
} = {}) {
  if (!Array.isArray(contracts) || contracts.length === 0) {
    fail("invalid-connector-registry", "contracts must be a non-empty array");
  }
  const definitions = connectorDefinitionsById(connectorCatalog);
  const entries = [];
  const seenContracts = new Set();
  for (const input of contracts) {
    const contract = validateConnectorContract(input);
    if (seenContracts.has(contract.connectorId)) {
      fail("invalid-connector-registry", `contracts duplicate ${contract.connectorId}`);
    }
    seenContracts.add(contract.connectorId);
    const definition = definitions.get(contract.connectorId);
    if (!definition) {
      fail("connector-definition-missing", `${contract.connectorId} is not in the canonical connector catalog`);
    }
    if (contract.compatibility.replacementConnectorId !== null
        && !definitions.has(contract.compatibility.replacementConnectorId)) {
      fail("connector-definition-missing", `replacement connector ${contract.compatibility.replacementConnectorId} is not canonical`);
    }
    for (const kind of CAPABILITY_GROUPS) {
      if (!definitionSupports(definition, kind) && contract.capabilities[kind].length) {
        fail("connector-capability-mismatch", `${contract.connectorId} canonical metadata does not advertise ${kind}`);
      }
    }
    entries.push(deepFreeze({ definition, contract }));
  }
  entries.sort((left, right) => left.definition.priority - right.definition.priority);
  deepFreeze(entries);
  const byId = new Map(entries.map((entry) => [entry.contract.connectorId, entry]));
  return Object.freeze({
    formatVersion: CONNECTOR_CONTRACT_VERSION,
    ids: Object.freeze(entries.map((entry) => entry.contract.connectorId)),
    get(connectorId) {
      return byId.get(connectorId) ?? null;
    },
    list() {
      return entries;
    },
  });
}

export function createConnectorRuntimeRegistry({
  contracts,
  setupConnectors = [],
  inventoryAdapters = [],
  evidenceAdapters = [],
  connectorCatalog = CONNECTOR_CATALOG,
} = {}) {
  const contractRegistry = createConnectorContractRegistry({ contracts, connectorCatalog });
  const runtimes = {
    setup: runtimeMap(setupConnectors, "setup"),
    inventory: runtimeMap(inventoryAdapters, "inventory"),
    evidence: runtimeMap(evidenceAdapters, "evidence"),
  };
  const entries = [];
  const claims = new Map();
  for (const { definition, contract } of contractRegistry.list()) {
    const boundRuntimes = { setup: [], inventory: [], evidence: [] };
    for (const kind of CAPABILITY_GROUPS) {
      if (kind === "profiles") continue;
      for (const capability of contract.capabilities[kind]) {
        const claimKey = `${kind}:${capability.id}`;
        claims.set(claimKey, (claims.get(claimKey) ?? 0) + 1);
        const runtime = runtimes[kind].get(capability.id);
        if (!runtime) fail("connector-runtime-missing", `${kind} runtime ${capability.id} is not registered`);
        if (kind !== "setup" && runtime.provider !== contract.provider) {
          fail("connector-runtime-mismatch", `${kind} runtime ${capability.id} provider does not match ${contract.provider}`);
        }
        boundRuntimes[kind].push(runtime);
      }
    }
    entries.push(deepFreeze({
      definition,
      contract,
      runtimes: boundRuntimes,
    }));
  }
  validateRuntimeClaims(runtimes, claims);
  entries.sort((left, right) => left.definition.priority - right.definition.priority);
  deepFreeze(entries);
  const byId = new Map(entries.map((entry) => [entry.contract.connectorId, entry]));
  const ids = Object.freeze(entries.map((entry) => entry.contract.connectorId));
  return Object.freeze({
    formatVersion: CONNECTOR_CONTRACT_VERSION,
    ids,
    get(connectorId) {
      return byId.get(connectorId) ?? null;
    },
    list() {
      return entries;
    },
    metadata() {
      return entries.map(({ definition, contract }) => deepFreeze({
        definition,
        contract,
      }));
    },
    getRuntime(kind, id) {
      if (!new Set(["setup", "inventory", "evidence"]).has(kind)) return null;
      return runtimes[kind].get(id) ?? null;
    },
    async runInventory(connectorId, options) {
      const entry = connectorEntry(byId, connectorId);
      const adapterId = options?.binding?.adapterId;
      const adapter = capabilityRuntime(entry, "inventory", adapterId);
      const { binding } = validateConnectorInventoryExecution({
        contracts: [entry.contract],
        binding: options.binding,
        adapter,
      });
      return runInventoryAdapter({ ...options, binding, adapter });
    },
    async runEvidence(connectorId, options) {
      const entry = connectorEntry(byId, connectorId);
      const adapterId = options?.binding?.adapterId;
      const adapter = capabilityRuntime(entry, "evidence", adapterId);
      const { binding } = validateConnectorEvidenceExecution({
        contracts: [entry.contract],
        binding: options.binding,
        adapter,
      });
      return runEvidenceAdapter({ ...options, binding, adapter });
    },
  });
}
