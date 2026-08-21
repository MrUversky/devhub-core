import type { ConnectionOnboarding } from "../connection-onboarding.mjs";
export function validateLocalHostSetupScope(value: unknown): value is Readonly<{ hostId: string }>;
export const localHostConnectionOnboarding: ConnectionOnboarding;
