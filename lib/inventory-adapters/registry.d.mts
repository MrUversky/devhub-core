import type { InventoryAdapter } from "../inventory-adapters.mjs";
import type { OpenAIAdminFetch } from "../openai-admin-api.mjs";
import type { VercelFetch } from "./providers/vercel.mjs";

export function createInventoryAdapterRegistry(options?: { fetch?: VercelFetch | OpenAIAdminFetch }): Map<string, InventoryAdapter>;
export const inventoryAdapterRegistry: Map<string, InventoryAdapter>;
