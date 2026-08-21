import type {
  InventoryAdapter,
  InventoryAdapterBinding,
  InventoryScope,
  NormalizedInventoryResult,
} from "../inventory-adapters.mjs";
import type { ConnectionProfile, SetupConnector } from "../setup-session.mjs";
import type { ConnectionOnboarding } from "../connection-onboarding.mjs";
import type { TaskObservationBridge } from "../task-observations.mjs";

export type VercelCredentialReference =
  { kind: "environment" | "keychain" | "secret-manager"; locator: string };

export type VercelConnectionProfile = ConnectionProfile & {
  connectorId: "vercel";
  scope: InventoryScope;
  authorization: {
    method: "secret-reference";
    credentialRef: VercelCredentialReference;
  };
};

export function vercelBindingFromConnectionProfile(
  profile: VercelConnectionProfile,
  adapter?: InventoryAdapter,
): Readonly<Required<InventoryAdapterBinding>>;

export function collectVercelSetupInventory(options: {
  profile: VercelConnectionProfile;
  credential: string;
  now?: Date | string | number;
  signal?: AbortSignal;
  adapter?: InventoryAdapter;
}): Promise<NormalizedInventoryResult>;

export function validateVercelSetupProfile(profile: VercelConnectionProfile, adapter?: InventoryAdapter): void;
export function createVercelSetupConnector(options?: { adapter?: InventoryAdapter }): SetupConnector;
export const vercelSetupConnector: SetupConnector;
export const vercelConnectionOnboarding: ConnectionOnboarding;
export const vercelTaskObservationBridge: TaskObservationBridge;
