import { validateConnectionOnboarding } from "../connection-onboarding.mjs";
import { githubConnectionOnboarding } from "./github.mjs";
import { localHostConnectionOnboarding } from "./local-host.mjs";
import { openAIConnectionOnboarding } from "./openai.mjs";
import { railwayConnectionOnboarding } from "./railway.mjs";
import { vercelConnectionOnboarding } from "./vercel.mjs";

export const defaultConnectionOnboardings = Object.freeze([
  githubConnectionOnboarding,
  localHostConnectionOnboarding,
  vercelConnectionOnboarding,
  railwayConnectionOnboarding,
  openAIConnectionOnboarding,
]);

/** Canonical defaults may be overridden only by the actual registered connector implementation. */
export function createConnectionOnboardingRegistry(connectors = []) {
  const registry = new Map(defaultConnectionOnboardings.map((entry) => [entry.connectorId, entry]));
  const values = connectors instanceof Map ? [...connectors.values()] : Array.isArray(connectors) ? connectors : Object.values(connectors ?? {});
  for (const connector of values) {
    if (connector?.onboarding === undefined) continue;
    const onboarding = validateConnectionOnboarding(connector.onboarding);
    if (connector.connectorId !== onboarding.connectorId) throw new TypeError("setup connector onboarding must match connectorId");
    registry.set(onboarding.connectorId, onboarding);
  }
  return registry;
}
