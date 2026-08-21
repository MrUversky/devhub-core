import type { ConnectorAuth } from "./connectors.mjs";
import type { ConnectionOnboarding } from "./connection-onboarding.mjs";
import type { TaskObservationBridge } from "./task-observations.mjs";

export type SetupState = "detected" | "authorization-required" | "connected" | "unavailable" | "stale" | "unknown";
export type CredentialReference = Readonly<{ kind: "environment" | "keychain" | "secret-manager"; locator: string }>;
export function parseCredentialReference(value: unknown, label?: string): CredentialReference;
export type ConnectionProfile = Readonly<{
  version: 1;
  id: string;
  connectorId: string;
  authorization: Readonly<{ method: ConnectorAuth; credentialRef?: CredentialReference }>;
  scope: Readonly<Record<string, unknown>>;
  owner: string;
  state: Exclude<SetupState, "detected" | "stale">;
  lastObservedAt: string | null;
  freshForSeconds: number;
}>;
export type SetupConnectorResult = Readonly<{
  state: "authorization-required" | "connected" | "unavailable" | "unknown";
  observedAt?: string;
  message?: string;
  observations?: readonly Readonly<Record<string, unknown>>[];
}>;
export type SetupConnector = Readonly<{
  connectorId: string;
  onboarding?: ConnectionOnboarding;
  taskObservationBridge?: TaskObservationBridge;
  awaitAbortCleanup?: boolean;
  validateProfile?: (profile: ConnectionProfile) => void | Promise<void>;
  collect: (input: { profile: ConnectionProfile; credential?: unknown; now: string; signal?: AbortSignal }) => SetupConnectorResult | Promise<SetupConnectorResult>;
}>;
export class SetupSessionError extends Error { code: string; }
export function validateConnectionProfile(value: unknown, options?: { label?: string }): ConnectionProfile;
export function parseConnectionProfileDocument(value: unknown): readonly ConnectionProfile[];
export function validateSetupConnector(value: unknown): SetupConnector;
export function runSetupSession(input: unknown, options?: {
  now?: string | number | Date;
  sessionId?: string;
  connectors?: ReadonlyMap<string, SetupConnector> | Record<string, SetupConnector>;
  resolveCredential?: (reference: CredentialReference, context: { profile: ConnectionProfile; signal?: AbortSignal }) => unknown | Promise<unknown>;
  signal?: AbortSignal;
}): Promise<Readonly<Record<string, unknown>>>;
export const createSetupSession: typeof runSetupSession;
