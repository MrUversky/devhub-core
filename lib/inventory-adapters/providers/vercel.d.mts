import type {
  InventoryAdapter,
  InventoryAdapterObservation,
  InventoryAdapterRequest,
} from "../../inventory-adapters.mjs";

export type VercelFetch = (input: string, init: RequestInit) => Promise<Response>;
export type VercelInventoryAdapter = InventoryAdapter & {
  collect(request: Readonly<InventoryAdapterRequest>): Promise<InventoryAdapterObservation>;
};

export const VERCEL_INVENTORY_ADAPTER_ID: "vercel-inventory-v1";
export function createVercelInventoryAdapter(options?: {
  fetch?: VercelFetch;
  maxResponseBytes?: number;
}): VercelInventoryAdapter;
export const vercelInventoryAdapter: VercelInventoryAdapter;
