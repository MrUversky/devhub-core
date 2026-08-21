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
  VERCEL_INVENTORY_ADAPTER_ID,
  vercelInventoryAdapter,
} from "../inventory-adapters/providers/vercel.mjs";

const PROVIDER = "vercel";
const INTERNAL_CREDENTIAL_ENVIRONMENT = "DEVHUB_SETUP_VERCEL_CREDENTIAL";
const DEFAULT_FRESH_FOR_SECONDS = 60 * 60;
const DEFAULT_LIMITS = Object.freeze({ maxResources: 200, maxPages: 20, deadlineMs: 10_000 });
const TASK_OBSERVATION_FRESH_MS = 5 * 60 * 1_000;
const vercelOnboardingPresentation = getConnectionOnboardingPresentation(PROVIDER);

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactFields(value, fields, label) {
  if (!plainObject(value)) throw new TypeError(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!fields.has(key)) throw new TypeError(`${label}.${key} is not supported`);
}

export const vercelTaskObservationBridge = validateTaskObservationBridge({
  formatVersion: 1,
  id: "vercel-plugin-projects-v1",
  connectorId: PROVIDER,
  acquisition: "provider-plugin-session",
  maxResources: DEFAULT_LIMITS.maxResources,
  normalize(observation, context) {
    exactFields(observation.scope, new Set(["kind", "label"]), "Vercel task observation scope");
    if (!new Set(["team", "account"]).has(observation.scope.kind)) {
      throw new TypeError("Vercel task observation scope must be one recognizable team or account");
    }
    const scope = {
      kind: observation.scope.kind,
      label: normalizeTaskObservationLabel(observation.scope.label, "Vercel task observation scope label"),
    };
    if (!Array.isArray(observation.resources) || observation.resources.length > context.maxResources) {
      throw new TypeError(`Vercel task observation resources must contain at most ${context.maxResources} projects`);
    }
    const seen = new Set();
    const resources = observation.resources.map((resource, index) => {
      exactFields(resource, new Set(["kind", "label"]), `Vercel task observation resources[${index}]`);
      if (resource.kind !== "project") throw new TypeError("Vercel task observation resources must be projects");
      const label = normalizeTaskObservationLabel(resource.label, `Vercel task observation resources[${index}].label`);
      const key = label.normalize("NFKD").toLowerCase();
      if (seen.has(key)) throw new TypeError("Vercel task observation project labels must be unique in the selected scope");
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

export const vercelConnectionOnboarding = createScopedConnectionOnboarding({
  connectorId: PROVIDER, acquisition: vercelOnboardingPresentation.acquisition, authorizationMethod: "secret-reference",
  scopeSchema: { oneOf: [
    { type: "object", additionalProperties: false, required: ["kind", "id"], properties: { kind: { const: "team" }, id: { type: "string", pattern: "^team_[A-Za-z0-9]{1,95}$" } } },
    { type: "object", additionalProperties: false, required: ["kind", "id"], properties: { kind: { const: "account" }, id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,100}$" } } },
  ] },
  validateScope: (scope) => vercelInventoryAdapter.validateScope(scope),
  guidedCard: vercelOnboardingPresentation.guidedCard,
});

/** Convert a reviewed Vercel connection profile to the existing bounded inventory binding. */
export function vercelBindingFromConnectionProfile(profile, adapter = vercelInventoryAdapter) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new TypeError("Vercel Connected Setup requires a reviewed connection profile");
  }
  if (profile.connectorId !== PROVIDER) {
    throw new TypeError("Vercel connection profile must use connectorId vercel");
  }
  if (profile.authorization?.method !== "secret-reference") {
    throw new TypeError("Vercel Connected Setup requires secret-reference authorization");
  }
  if (!profile.authorization?.credentialRef) {
    throw new TypeError("Vercel Connected Setup requires an external credential reference");
  }

  return validateInventoryBinding({
    adapterId: VERCEL_INVENTORY_ADAPTER_ID,
    provider: PROVIDER,
    scope: structuredClone(profile.scope),
    credentialEnv: INTERNAL_CREDENTIAL_ENVIRONMENT,
    freshForSeconds: profile.freshForSeconds ?? DEFAULT_FRESH_FOR_SECONDS,
    maxResources: DEFAULT_LIMITS.maxResources,
    maxPages: DEFAULT_LIMITS.maxPages,
    deadlineMs: DEFAULT_LIMITS.deadlineMs,
  }, adapter);
}

export async function collectVercelSetupInventory({
  profile,
  credential,
  now,
  signal,
  adapter = vercelInventoryAdapter,
}) {
  const binding = vercelBindingFromConnectionProfile(profile, adapter);
  return runInventoryAdapter({
    binding,
    adapter,
    environment: { [INTERNAL_CREDENTIAL_ENVIRONMENT]: credential },
    now,
    signal,
  });
}

export function validateVercelSetupProfile(profile, adapter = vercelInventoryAdapter) {
  vercelBindingFromConnectionProfile(profile, adapter);
}

export function createVercelSetupConnector({ adapter = vercelInventoryAdapter } = {}) {
  return Object.freeze({
    connectorId: PROVIDER,
    onboarding: vercelConnectionOnboarding,
    taskObservationBridge: vercelTaskObservationBridge,
    validateProfile(profile) {
      validateVercelSetupProfile(profile, adapter);
    },
    async collect({ profile, credential, now, signal }) {
      if (typeof credential !== "string" || credential.length === 0) {
        return {
          state: "authorization-required",
          observedAt: now,
          message: "The reviewed Vercel credential reference is unavailable.",
          observations: [],
        };
      }
      const result = await collectVercelSetupInventory({ profile, credential, now, signal, adapter });
      if (result.execution.state !== "succeeded" || result.freshness.state !== "fresh") {
        return {
          state: "unknown",
          observedAt: result.freshness.evaluatedAt,
          message: `Vercel inventory is ${result.execution.reason}; no absence or deletion was inferred.`,
          observations: [],
        };
      }
      return {
        state: "connected",
        observedAt: result.freshness.observedAt,
        message: `Vercel returned ${result.candidates.length} candidate${result.candidates.length === 1 ? "" : "s"} from the reviewed scope.`,
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

export const vercelSetupConnector = createVercelSetupConnector();
