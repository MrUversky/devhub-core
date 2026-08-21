import type { ConnectionOnboarding } from "../connection-onboarding.mjs";
export const defaultConnectionOnboardings: readonly ConnectionOnboarding[];
export function createConnectionOnboardingRegistry(
  connectors?: ReadonlyMap<string, unknown> | Record<string, unknown> | readonly unknown[],
): Map<string, ConnectionOnboarding>;
