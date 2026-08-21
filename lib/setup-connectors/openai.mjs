import { runInventoryAdapter, validateInventoryBinding } from "../inventory-adapters.mjs";
import { createScopedConnectionOnboarding } from "../connection-onboarding.mjs";
import { getConnectionOnboardingPresentation } from "../connection-onboarding-presentation.mjs";
import {
  OPENAI_PROJECT_INVENTORY_ADAPTER_ID,
  openAIProjectInventoryAdapter,
} from "../inventory-adapters/providers/openai.mjs";

const PROVIDER = "openai";
const INTERNAL_CREDENTIAL_ENVIRONMENT = "DEVHUB_SETUP_OPENAI_ADMIN_CREDENTIAL";
const openAIOnboardingPresentation = getConnectionOnboardingPresentation(PROVIDER);

export const openAIConnectionOnboarding = createScopedConnectionOnboarding({
  connectorId: PROVIDER,
  acquisition: openAIOnboardingPresentation.acquisition,
  authorizationMethod: "secret-reference",
  scopeSchema: {
    type: "object", additionalProperties: false, required: ["kind", "id", "parent"],
    properties: {
      kind: { const: "project" }, id: { type: "string", pattern: "^proj_[A-Za-z0-9_-]{3,123}$" },
      parent: { type: "object", additionalProperties: false, required: ["kind", "id"], properties: { kind: { const: "workspace" }, id: { type: "string", pattern: "^org[-_][A-Za-z0-9_-]{3,124}$" } } },
    },
  },
  validateScope: (scope) => openAIProjectInventoryAdapter.validateScope(scope),
  guidedCard: openAIOnboardingPresentation.guidedCard,
});

export function openAIProjectBindingFromConnectionProfile(profile, adapter = openAIProjectInventoryAdapter) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile) || profile.connectorId !== PROVIDER) {
    throw new TypeError("OpenAI connection profile must use connectorId openai");
  }
  if (profile.authorization?.method !== "secret-reference" || !profile.authorization?.credentialRef) {
    throw new TypeError("OpenAI Connected Setup requires an external Admin credential reference");
  }
  return validateInventoryBinding({
    adapterId: OPENAI_PROJECT_INVENTORY_ADAPTER_ID,
    provider: PROVIDER,
    scope: structuredClone(profile.scope),
    credentialEnv: INTERNAL_CREDENTIAL_ENVIRONMENT,
    freshForSeconds: profile.freshForSeconds ?? 3600,
    maxResources: 50,
    maxPages: 20,
    deadlineMs: 10_000,
    maxResponseBytes: 1024 * 1024,
  }, adapter);
}

export function createOpenAISetupConnector({ adapter = openAIProjectInventoryAdapter } = {}) {
  return Object.freeze({
    connectorId: PROVIDER,
    onboarding: openAIConnectionOnboarding,
    validateProfile(profile) {
      openAIProjectBindingFromConnectionProfile(profile, adapter);
    },
    async collect({ profile, credential, now, signal }) {
      if (typeof credential !== "string" || credential.length === 0) {
        return { state: "authorization-required", observedAt: now, message: "The reviewed OpenAI Admin credential reference is unavailable.", observations: [] };
      }
      const binding = openAIProjectBindingFromConnectionProfile(profile, adapter);
      const result = await runInventoryAdapter({
        binding,
        adapter,
        environment: { [INTERNAL_CREDENTIAL_ENVIRONMENT]: credential },
        now,
        signal,
      });
      if (result.execution.state !== "succeeded" || result.freshness.state !== "fresh") {
        return {
          state: "unknown",
          observedAt: result.freshness.evaluatedAt,
          message: `OpenAI project inventory is ${result.execution.reason}; no ownership or billing access was inferred.`,
          observations: [],
        };
      }
      return {
        state: "connected",
        observedAt: result.freshness.observedAt,
        message: `OpenAI verified the exact reviewed organization/project scope and returned ${Math.max(0, result.candidates.length - 1)} redacted key metadata record${result.candidates.length === 2 ? "" : "s"}.`,
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

export const openAISetupConnector = createOpenAISetupConnector();
