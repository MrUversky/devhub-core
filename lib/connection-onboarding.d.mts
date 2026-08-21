import type { ConnectorAuth } from "./connectors.mjs";
import type { ConnectionAcquisition, GuidedConnectionCard } from "./connection-onboarding-presentation.mjs";
export type { ConnectionAcquisition, GuidedConnectionAction, GuidedConnectionCard } from "./connection-onboarding-presentation.mjs";
export { validateGuidedConnectionCard } from "./connection-onboarding-presentation.mjs";

export class ConnectionOnboardingError extends Error {
  constructor(code: "answer-invalid" | "scope-invalid", message: string);
  code: "answer-invalid" | "scope-invalid";
}
export type ConnectionOnboarding = Readonly<{
  formatVersion: 1;
  connectorId: string;
  acquisition: ConnectionAcquisition;
  guidedCard: GuidedConnectionCard;
  answerSchema: Readonly<Record<string, unknown>>;
  validateAnswer(value: unknown): Readonly<Record<string, unknown>>;
  createProfileInput(answer: Readonly<Record<string, unknown>>): Readonly<{
    authorization: Readonly<{ method: ConnectorAuth; credentialRef?: Readonly<Record<string, unknown>> }>;
    scope: Readonly<Record<string, unknown>>;
    owner: string;
  }>;
}>;
export function validateConnectionOnboarding(value: unknown): ConnectionOnboarding;
export function createScopedConnectionOnboarding(options: {
  connectorId: string;
  acquisition: ConnectionAcquisition;
  authorizationMethod: ConnectorAuth;
  scopeSchema: Readonly<Record<string, unknown>>;
  validateScope(scope: unknown): boolean;
  guidedCard: GuidedConnectionCard;
}): ConnectionOnboarding;
