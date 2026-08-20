import { createScopedConnectionOnboarding } from "../connection-onboarding.mjs";
import { getConnectionOnboardingPresentation } from "../connection-onboarding-presentation.mjs";

const hostId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const localHostOnboardingPresentation = getConnectionOnboardingPresentation("local-host");

export function validateLocalHostSetupScope(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 1 && typeof value.hostId === "string" && hostId.test(value.hostId));
}

export const localHostConnectionOnboarding = createScopedConnectionOnboarding({
  connectorId: "local-host",
  acquisition: localHostOnboardingPresentation.acquisition,
  authorizationMethod: "local-session",
  scopeSchema: {
    type: "object",
    additionalProperties: false,
    required: ["hostId"],
    properties: { hostId: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" } },
  },
  validateScope: validateLocalHostSetupScope,
  guidedCard: localHostOnboardingPresentation.guidedCard,
});
