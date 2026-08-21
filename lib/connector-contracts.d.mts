import type { ConnectorContract } from "./connector-conformance.mjs";

export const GITHUB_CONNECTOR_CONTRACT: ConnectorContract;
export const LOCAL_HOST_CONNECTOR_CONTRACT: ConnectorContract;
export const OPENAI_CONNECTOR_CONTRACT: ConnectorContract;
export const RAILWAY_CONNECTOR_CONTRACT: ConnectorContract;
export const SENTRY_CONNECTOR_CONTRACT: ConnectorContract;
export const VERCEL_CONNECTOR_CONTRACT: ConnectorContract;
export const CONNECTOR_CONTRACTS: readonly ConnectorContract[];
export const connectorContractRegistry: Readonly<{
  formatVersion: 1;
  ids: readonly string[];
  get(connectorId: string): Readonly<{ definition: unknown; contract: ConnectorContract }> | null;
  list(): readonly Readonly<{ definition: unknown; contract: ConnectorContract }>[];
}>;
