import type { InventoryAdapter, InventoryAdapterObservation, InventoryAdapterRequest } from "../../inventory-adapters.mjs";
import type { OpenAIAdminFetch } from "../../openai-admin-api.mjs";

export type OpenAIProjectInventoryAdapter = InventoryAdapter & {
  collect(request: Readonly<InventoryAdapterRequest>): Promise<InventoryAdapterObservation>;
};

export const OPENAI_PROJECT_INVENTORY_ADAPTER_ID: "openai-project-inventory-v1";
export function createOpenAIProjectInventoryAdapter(options?: {
  fetch?: OpenAIAdminFetch;
  maxResponseBytes?: number;
}): OpenAIProjectInventoryAdapter;
export const openAIProjectInventoryAdapter: OpenAIProjectInventoryAdapter;
