import type { ConnectionSnapshot } from "./connection-status.mjs";

export type SetupRunPresentationStatus = "ready" | "needs-scope" | "reconnect" | "retry" | "reviewed-binding-required";
export type SetupRunPresentationSource = Readonly<{
  connectorId: string;
  name: string;
  support: Readonly<{ setup: boolean; inventory: boolean; evidence: boolean }>;
  status: SetupRunPresentationStatus;
  reason: string;
  nextAction: Readonly<{ id: string; label: string }>;
  connection: Readonly<{ state: "connected" | "stale" | "authorization-required" | "unavailable" | "unknown" | "not-configured"; profileCount: number; attentionCount: number; lastObservedAt: string | null; validUntil: string | null }>;
  detection: Readonly<{ state: "detected" | "not-detected" | "not-detectable" | "unknown"; informationalOnly: true }>;
}>;
export type SetupRunPresentationPreflight = Readonly<{
  version: 1;
  evaluatedAt: string;
  selected: readonly SetupRunPresentationSource[];
  summary: Readonly<{ selected: number; ready: number; needsScope: number; reconnect: number; retry: number; reviewedBindingRequired: number; needsAttention: number }>;
}>;
export const SETUP_RUN_CONNECTOR_SUPPORT: Readonly<Record<string, Readonly<{ setup: boolean; inventory: boolean; evidence: boolean }>>>;
export class SetupRunError extends Error { code: string; }
export function createSetupRunPresentationPreflight(input: { selectedConnectorIds: readonly string[]; connections: ConnectionSnapshot; now?: string | number | Date; planning?: Readonly<Record<string, unknown>> | null }): SetupRunPresentationPreflight;
