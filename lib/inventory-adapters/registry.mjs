import { createOpenAIProjectInventoryAdapter, openAIProjectInventoryAdapter } from "./providers/openai.mjs";
import { createRailwayInventoryAdapter, railwayInventoryAdapter } from "./providers/railway.mjs";
import { createVercelInventoryAdapter, vercelInventoryAdapter } from "./providers/vercel.mjs";

export function createInventoryAdapterRegistry({ fetch } = {}) {
  const railway = fetch === undefined
    ? railwayInventoryAdapter
    : createRailwayInventoryAdapter({ fetch });
  const openai = fetch === undefined
    ? openAIProjectInventoryAdapter
    : createOpenAIProjectInventoryAdapter({ fetch });
  const vercel = fetch === undefined
    ? vercelInventoryAdapter
    : createVercelInventoryAdapter({ fetch });
  return new Map([
    [openai.id, openai],
    [railway.id, railway],
    [vercel.id, vercel],
  ]);
}

export const inventoryAdapterRegistry = createInventoryAdapterRegistry();
