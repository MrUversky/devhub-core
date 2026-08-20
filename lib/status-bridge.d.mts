export type StatusBridgeStatus = {
  key: string;
  state: "up" | "down" | "stopped" | "degraded" | "registered" | "protected" | "unknown";
  source: "probe" | "reported" | "catalog";
  reason: "live-probe" | "reported" | "catalog-only" | "remote-loopback" | "probe-timeout" | "probe-failed";
  checkedAt: string;
  observedAt?: string;
  latencyMs?: number;
  httpStatus?: number;
  note?: string;
  ageMs?: number;
  freshness?: "fresh" | "stale";
  refreshAfter?: string;
};

export type StatusBridgeSnapshot = {
  observedAt: string;
  statuses: StatusBridgeStatus[];
  freshness: {
    mode: "cache" | "refresh" | "mixed" | "shared";
    newestCheckedAt: string | null;
    maxAgeMs: number;
  };
};

export function parseStatusCorsOrigins(value?: string): string[];
export function isAllowedStatusCorsOrigin(origin: string | null, allowedOrigins: readonly string[]): boolean;
export function resolveStatusApiEndpoint(value?: string): string;
export function selectReviewedStatusSnapshot(value: unknown, reviewedKeys: ReadonlySet<string> | readonly string[]): StatusBridgeSnapshot | null;
export const SAME_ORIGIN_STATUS_API_ENDPOINT: "/api/status";
