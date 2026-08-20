export type ConnectionAcquisition = "existing-session" | "local-session" | "secure-stored-access";
export type GuidedConnectionAction = Readonly<{
  id: string;
  label: string;
  description: string;
  approval: "required";
}>;
export type GuidedConnectionCard = Readonly<{
  version: 1;
  title: string;
  description: string;
  actions: readonly [GuidedConnectionAction, GuidedConnectionAction] | readonly [GuidedConnectionAction, GuidedConnectionAction, GuidedConnectionAction];
}>;
export type ConnectionOnboardingPresentation = Readonly<{
  formatVersion: 1;
  connectorId: string;
  acquisition: ConnectionAcquisition;
  guidedCard: GuidedConnectionCard;
}>;
export const CONNECTION_ONBOARDING_PRESENTATIONS: readonly ConnectionOnboardingPresentation[];
export function getConnectionOnboardingPresentation(connectorId: string): ConnectionOnboardingPresentation | null;
export function validateGuidedConnectionCard(value: unknown, connectorId?: string): GuidedConnectionCard;
