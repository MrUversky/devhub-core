import type {
  InventoryAdapter,
  InventoryAdapterBinding,
  InventoryScope,
  NormalizedInventoryResult,
} from "../inventory-adapters.mjs";
import type { ConnectionProfile, SetupConnector } from "../setup-session.mjs";
import type { ConnectionOnboarding } from "../connection-onboarding.mjs";
import type { TaskObservationBridge } from "../task-observations.mjs";

export type RailwayCredentialReference =
  { kind: "environment" | "keychain" | "secret-manager"; locator: string };

export type RailwayConnectionProfile = ConnectionProfile & {
  connectorId: "railway";
  scope: InventoryScope;
  authorization: {
    method: "secret-reference";
    credentialRef: RailwayCredentialReference;
  };
};

export type RailwayRefreshKind = "added" | "changed" | "stale" | "unclear";
export type RailwayRefreshResult = Readonly<{
  version: 1;
  provider: "railway";
  scope: InventoryScope;
  freshness: NormalizedInventoryResult["freshness"];
  summary: Record<RailwayRefreshKind | "unchanged", number>;
  items: ReadonlyArray<{
    kind: RailwayRefreshKind;
    identity: { provider: "railway"; resourceType: string; resourceId: string };
    candidate: NormalizedInventoryResult["candidates"][number] | null;
    reason: string;
  }>;
}>;

export function railwayBindingFromConnectionProfile(
  profile: RailwayConnectionProfile,
  adapter?: InventoryAdapter,
): Readonly<Required<InventoryAdapterBinding>>;

export function collectRailwaySetupInventory(options: {
  profile: RailwayConnectionProfile;
  credential: string;
  now?: Date | string | number;
  adapter?: InventoryAdapter;
}): Promise<NormalizedInventoryResult>;

export function validateRailwaySetupProfile(profile: RailwayConnectionProfile, adapter?: InventoryAdapter): void;
export function createRailwaySetupConnector(options?: { adapter?: InventoryAdapter }): SetupConnector;

export function compareRailwaySetupRefresh(
  previous: NormalizedInventoryResult | null | undefined,
  current: NormalizedInventoryResult,
): RailwayRefreshResult;

export const railwaySetupConnector: SetupConnector;
export const railwayConnectionOnboarding: ConnectionOnboarding;
export const railwayTaskObservationBridge: TaskObservationBridge;
