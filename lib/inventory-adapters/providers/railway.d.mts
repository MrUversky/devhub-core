import type {
  InventoryAdapter,
  InventoryAdapterObservation,
  InventoryAdapterRequest,
} from "../../inventory-adapters.mjs";

export type RailwayFetch = (input: string, init: RequestInit) => Promise<Response>;
export type RailwayInventoryAdapter = InventoryAdapter & {
  collect(request: Readonly<InventoryAdapterRequest>): Promise<InventoryAdapterObservation>;
};

export const RAILWAY_INVENTORY_ADAPTER_ID: "railway-inventory-v1";
export function createRailwayInventoryAdapter(options?: {
  fetch?: RailwayFetch;
  maxResponseBytes?: number;
}): RailwayInventoryAdapter;
export const railwayInventoryAdapter: RailwayInventoryAdapter;
