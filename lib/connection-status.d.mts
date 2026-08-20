export type ConnectionProfileSummary = Readonly<{
  connectorId: string;
  state: "authorization-required" | "connected" | "unavailable" | "unknown";
  lastObservedAt: string | null;
  validUntil: string | null;
}>;

export type ConnectionSnapshot = Readonly<{
  version: 1;
  source: "reviewed-profiles" | "not-configured";
  profiles: readonly ConnectionProfileSummary[];
}>;

export type ConnectorConnection = Readonly<{
  state: "connected" | "stale" | "authorization-required" | "unavailable" | "unknown" | "not-configured";
  profileCount: number;
  attentionCount: number;
  lastObservedAt: string | null;
  validUntil: string | null;
}>;

export function resolveConnectorConnection(snapshot: ConnectionSnapshot, connectorId: string, options?: { now?: string }): ConnectorConnection;
