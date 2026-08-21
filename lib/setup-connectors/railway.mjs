import {
  runInventoryAdapter,
  validateInventoryBinding,
  validateNormalizedInventoryResult,
} from "../inventory-adapters.mjs";
import { createScopedConnectionOnboarding } from "../connection-onboarding.mjs";
import { getConnectionOnboardingPresentation } from "../connection-onboarding-presentation.mjs";
import {
  normalizeTaskObservationLabel,
  taskObservationDigest,
  validateTaskObservationBridge,
} from "../task-observations.mjs";
import {
  RAILWAY_INVENTORY_ADAPTER_ID,
  railwayInventoryAdapter,
} from "../inventory-adapters/providers/railway.mjs";

const PROVIDER = "railway";
const INTERNAL_CREDENTIAL_ENVIRONMENT = "DEVHUB_SETUP_RAILWAY_CREDENTIAL";
const DEFAULT_FRESH_FOR_SECONDS = 60 * 60;
const DEFAULT_LIMITS = Object.freeze({ maxResources: 200, maxPages: 20, deadlineMs: 10_000 });
const TASK_OBSERVATION_FRESH_MS = 5 * 60 * 1_000;
const railwayOnboardingPresentation = getConnectionOnboardingPresentation(PROVIDER);

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactFields(value, fields, label) {
  if (!plainObject(value)) throw new TypeError(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!fields.has(key)) throw new TypeError(`${label}.${key} is not supported`);
}

export const railwayTaskObservationBridge = validateTaskObservationBridge({
  formatVersion: 1,
  id: "railway-plugin-projects-v1",
  connectorId: PROVIDER,
  acquisition: "provider-plugin-session",
  maxResources: DEFAULT_LIMITS.maxResources,
  normalize(observation, context) {
    exactFields(observation.scope, new Set(["kind", "label"]), "Railway task observation scope");
    if (observation.scope.kind !== "workspace") {
      throw new TypeError("Railway task observation scope must be one recognizable workspace");
    }
    const scope = {
      kind: observation.scope.kind,
      label: normalizeTaskObservationLabel(observation.scope.label, "Railway task observation scope label"),
    };
    if (!Array.isArray(observation.resources) || observation.resources.length > context.maxResources) {
      throw new TypeError(`Railway task observation resources must contain at most ${context.maxResources} projects`);
    }
    const seen = new Set();
    const resources = observation.resources.map((resource, index) => {
      exactFields(resource, new Set(["kind", "label"]), `Railway task observation resources[${index}]`);
      if (resource.kind !== "project") throw new TypeError("Railway task observation resources must be projects");
      const label = normalizeTaskObservationLabel(resource.label, `Railway task observation resources[${index}].label`);
      const key = label.normalize("NFKD").toLowerCase();
      if (seen.has(key)) throw new TypeError("Railway task observation project labels must be unique in the selected workspace");
      seen.add(key);
      return { kind: "project", label };
    }).sort((left, right) => left.label.localeCompare(right.label));
    const observedAt = new Date(observation.observedAt).toISOString();
    const validUntil = new Date(Date.parse(observedAt) + TASK_OBSERVATION_FRESH_MS).toISOString();
    const scopeId = `task-scope-${taskObservationDigest({
      selectedConnectorIds: context.selectedConnectorIds,
      connectorId: PROVIDER,
      bridgeId: observation.bridgeId,
      scope,
    })}`;
    const normalizedInventory = validateNormalizedInventoryResult({
      formatVersion: 1,
      source: {
        adapterId: observation.bridgeId,
        provider: PROVIDER,
        scope: { kind: scope.kind, id: scopeId },
      },
      execution: { state: "succeeded", reason: "task-plugin-observation", pagesRead: 1 },
      freshness: {
        state: "fresh",
        observedAt,
        validUntil,
        evaluatedAt: new Date(context.now).toISOString(),
      },
      candidates: resources.map((resource) => ({
        provider: PROVIDER,
        resourceType: resource.kind,
        resourceId: `task-resource-${taskObservationDigest({ scopeId, resource })}`,
        name: resource.label,
        urls: [],
        observedAt,
        validUntil,
        freshness: "fresh",
      })),
    });
    return {
      version: 1,
      connectorId: PROVIDER,
      bridgeId: observation.bridgeId,
      acquisition: "provider-plugin-session",
      trust: "untrusted-transient-review-only",
      observedAt,
      validUntil,
      scope,
      resourceCount: resources.length,
      normalizedInventory,
    };
  },
});

export const railwayConnectionOnboarding = createScopedConnectionOnboarding({
  connectorId: PROVIDER, acquisition: railwayOnboardingPresentation.acquisition, authorizationMethod: "secret-reference",
  scopeSchema: { oneOf: [
    { type: "object", additionalProperties: false, required: ["kind", "id"], properties: { kind: { const: "workspace" }, id: { type: "string", format: "uuid" } } },
    { type: "object", additionalProperties: false, required: ["kind", "id", "parent"], properties: { kind: { const: "project" }, id: { type: "string", format: "uuid" }, parent: { type: "object", additionalProperties: false, required: ["kind", "id"], properties: { kind: { const: "workspace" }, id: { type: "string", format: "uuid" } } } } },
  ] },
  validateScope: (scope) => railwayInventoryAdapter.validateScope(scope),
  guidedCard: railwayOnboardingPresentation.guidedCard,
});

function immutable(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) immutable(child);
  }
  return value;
}

function candidateKey(candidate) {
  return `${candidate.resourceType}\u0000${candidate.resourceId}`;
}

function comparableCandidate(candidate) {
  return {
    provider: candidate.provider,
    resourceType: candidate.resourceType,
    resourceId: candidate.resourceId,
    parentResourceId: candidate.parentResourceId ?? null,
    name: candidate.name,
    environment: candidate.environment ?? null,
    runtime: candidate.runtime ?? null,
    status: candidate.status ?? null,
    urls: candidate.urls,
    repository: candidate.repository ?? null,
    metadata: candidate.metadata ?? null,
  };
}

function sameScope(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function deltaItem(kind, candidate, reason) {
  return {
    kind,
    identity: {
      provider: candidate.provider,
      resourceType: candidate.resourceType,
      resourceId: candidate.resourceId,
    },
    candidate: structuredClone(candidate),
    reason,
  };
}

function summarize(items, unchanged) {
  return {
    added: items.filter((item) => item.kind === "added").length,
    changed: items.filter((item) => item.kind === "changed").length,
    stale: items.filter((item) => item.kind === "stale").length,
    unclear: items.filter((item) => item.kind === "unclear").length,
    unchanged,
  };
}

/**
 * Convert one reviewed Railway connection profile to the existing inventory
 * binding. Credential resolution intentionally remains outside this module.
 */
export function railwayBindingFromConnectionProfile(profile, adapter = railwayInventoryAdapter) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new TypeError("Railway Connected Setup requires a reviewed connection profile");
  }
  if (profile.connectorId !== PROVIDER) {
    throw new TypeError("Railway connection profile must use connectorId railway");
  }
  if (profile.authorization?.method !== "secret-reference") {
    throw new TypeError("Railway Connected Setup requires secret-reference authorization");
  }
  if (!profile.authorization?.credentialRef) {
    throw new TypeError("Railway Connected Setup requires an external credential reference");
  }

  return validateInventoryBinding({
    adapterId: RAILWAY_INVENTORY_ADAPTER_ID,
    provider: PROVIDER,
    scope: structuredClone(profile.scope),
    credentialEnv: INTERNAL_CREDENTIAL_ENVIRONMENT,
    freshForSeconds: profile.freshForSeconds ?? DEFAULT_FRESH_FOR_SECONDS,
    maxResources: DEFAULT_LIMITS.maxResources,
    maxPages: DEFAULT_LIMITS.maxPages,
    deadlineMs: DEFAULT_LIMITS.deadlineMs,
  }, adapter);
}

/**
 * Execute the existing bounded inventory adapter. The Setup Runner supplies an
 * ephemeral environment after resolving the profile's external credential
 * reference; neither the reference value nor the environment is returned.
 */
export async function collectRailwaySetupInventory({
  profile,
  credential,
  now,
  signal,
  adapter = railwayInventoryAdapter,
}) {
  const binding = railwayBindingFromConnectionProfile(profile, adapter);
  const environment = { [INTERNAL_CREDENTIAL_ENVIRONMENT]: credential };
  return runInventoryAdapter({ binding, adapter, environment, now, signal });
}

export function validateRailwaySetupProfile(profile, adapter = railwayInventoryAdapter) {
  railwayBindingFromConnectionProfile(profile, adapter);
}

export function createRailwaySetupConnector({ adapter = railwayInventoryAdapter } = {}) {
  return Object.freeze({
    connectorId: PROVIDER,
    onboarding: railwayConnectionOnboarding,
    taskObservationBridge: railwayTaskObservationBridge,
    validateProfile(profile) {
      validateRailwaySetupProfile(profile, adapter);
    },
    async collect({ profile, credential, now, signal }) {
      if (typeof credential !== "string" || credential.length === 0) {
        return {
          state: "authorization-required",
          observedAt: now,
          message: "The reviewed Railway credential reference is unavailable.",
          observations: [],
        };
      }
      const result = await collectRailwaySetupInventory({ profile, credential, now, signal, adapter });
      if (result.execution.state !== "succeeded" || result.freshness.state !== "fresh") {
        return {
          state: "unknown",
          observedAt: result.freshness.evaluatedAt,
          message: `Railway inventory is ${result.execution.reason}; no absence or deletion was inferred.`,
          observations: [],
        };
      }
      return {
        state: "connected",
        observedAt: result.freshness.observedAt,
        message: `Railway returned ${result.candidates.length} candidate${result.candidates.length === 1 ? "" : "s"} from the reviewed scope.`,
        observations: [{
          kind: "normalized-provider-inventory",
          formatVersion: result.formatVersion,
          source: result.source,
          execution: result.execution,
          freshness: result.freshness,
          candidates: result.candidates,
        }],
      };
    },
  });
}

/**
 * Compare two normalized observations of the same reviewed Railway scope.
 * Absence never means deletion: a previously observed missing identity is
 * reported as unclear and kept for human review.
 */
export function compareRailwaySetupRefresh(previousInput, currentInput) {
  const previous = previousInput === null || previousInput === undefined
    ? null
    : validateNormalizedInventoryResult(previousInput);
  const current = validateNormalizedInventoryResult(currentInput);

  if (current.source.provider !== PROVIDER || current.source.adapterId !== RAILWAY_INVENTORY_ADAPTER_ID) {
    throw new TypeError("Railway refresh requires a normalized Railway inventory result");
  }
  if (previous && (
    previous.source.provider !== current.source.provider
    || previous.source.adapterId !== current.source.adapterId
    || !sameScope(previous.source.scope, current.source.scope)
  )) {
    throw new TypeError("Railway refresh must reuse the same reviewed scope");
  }

  const items = [];
  let unchanged = 0;
  if (current.execution.state !== "succeeded" || current.freshness.state === "unknown") {
    const candidates = previous?.candidates ?? [];
    if (candidates.length === 0) {
      items.push({
        kind: "unclear",
        identity: {
          provider: PROVIDER,
          resourceType: "scope",
          resourceId: current.source.scope.id,
        },
        candidate: null,
        reason: `Railway inventory is unavailable: ${current.execution.reason}. No resource absence was inferred.`,
      });
    } else {
      for (const candidate of candidates) {
        items.push(deltaItem(
          "unclear",
          candidate,
          `Railway inventory is unavailable: ${current.execution.reason}. The previous observation remains review context, not current proof.`,
        ));
      }
    }
    return immutable({
      version: 1,
      provider: PROVIDER,
      scope: structuredClone(current.source.scope),
      freshness: structuredClone(current.freshness),
      summary: summarize(items, unchanged),
      items,
    });
  }

  const previousByKey = new Map((previous?.candidates ?? []).map((candidate) => [candidateKey(candidate), candidate]));
  const seen = new Set();
  for (const candidate of current.candidates) {
    const key = candidateKey(candidate);
    seen.add(key);
    if (current.freshness.state === "stale" || candidate.freshness === "stale") {
      items.push(deltaItem("stale", candidate, "The Railway observation is stale and must be refreshed before it can update reviewed facts."));
      continue;
    }
    const before = previousByKey.get(key);
    if (!before) {
      items.push(deltaItem("added", candidate, "A fresh resource appeared in the same reviewed Railway scope."));
      continue;
    }
    if (JSON.stringify(comparableCandidate(before)) !== JSON.stringify(comparableCandidate(candidate))) {
      items.push(deltaItem("changed", candidate, "Fresh Railway metadata changed for this exact provider identity."));
    } else {
      unchanged += 1;
    }
  }

  for (const candidate of previous?.candidates ?? []) {
    if (seen.has(candidateKey(candidate))) continue;
    items.push(deltaItem(
      "unclear",
      candidate,
      "This previously observed resource was not returned. Absence does not prove deletion, non-use or safe cleanup.",
    ));
  }

  items.sort((left, right) => left.kind.localeCompare(right.kind)
    || left.identity.resourceType.localeCompare(right.identity.resourceType)
    || left.identity.resourceId.localeCompare(right.identity.resourceId));

  return immutable({
    version: 1,
    provider: PROVIDER,
    scope: structuredClone(current.source.scope),
    freshness: structuredClone(current.freshness),
    summary: summarize(items, unchanged),
    items,
  });
}

export const railwaySetupConnector = createRailwaySetupConnector();
