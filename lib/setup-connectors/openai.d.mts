import type { InventoryAdapter, InventoryAdapterBinding } from "../inventory-adapters.mjs";
import type { ConnectionProfile, SetupConnector } from "../setup-session.mjs";
import type { ConnectionOnboarding } from "../connection-onboarding.mjs";

export type OpenAIConnectionProfile = ConnectionProfile & {
  connectorId: "openai";
  scope: { kind: "project"; id: string; parent: { kind: "workspace"; id: string } };
  authorization: {
    method: "secret-reference";
    credentialRef: { kind: "environment" | "keychain" | "secret-manager"; locator: string };
  };
};

export function openAIProjectBindingFromConnectionProfile(
  profile: OpenAIConnectionProfile,
  adapter?: InventoryAdapter,
): Readonly<Required<InventoryAdapterBinding>>;
export function createOpenAISetupConnector(options?: { adapter?: InventoryAdapter }): SetupConnector;
export const openAIConnectionOnboarding: ConnectionOnboarding;
export const openAISetupConnector: SetupConnector;
