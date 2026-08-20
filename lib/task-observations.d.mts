export type TaskObservationTrust = "untrusted-transient-review-only";
export type TaskObservationAcquisition = "provider-plugin-session";
export type TaskObservationBridge = Readonly<{
  formatVersion: 1;
  id: string;
  connectorId: string;
  acquisition: TaskObservationAcquisition;
  maxResources: number;
  normalize: (observation: Readonly<Record<string, unknown>>, context: Readonly<{
    selectedConnectorIds: readonly string[];
    now: string;
    maxResources: number;
  }>) => BoundTaskObservation;
}>;
export type BoundTaskObservation = Readonly<{
  version: 1;
  connectorId: string;
  bridgeId: string;
  acquisition: TaskObservationAcquisition;
  trust: TaskObservationTrust;
  observedAt: string;
  validUntil: string;
  scope: Readonly<{ kind: string; label: string }>;
  resourceCount: number;
  normalizedInventory: Readonly<Record<string, unknown>>;
}>;
export type RawTaskObservation = Readonly<{
  connectorId: string;
  bridgeId: string;
  observedAt: string;
  scope: Readonly<Record<string, unknown>>;
  resources: readonly Readonly<Record<string, unknown>>[];
}>;
export type TaskObservationInputDocument = Readonly<{
  version: 1;
  selectedConnectorIds: readonly string[];
  observations: readonly RawTaskObservation[];
}>;
export type TaskObservationDocument = Readonly<{
  version: 1;
  selectedConnectorIds: readonly string[];
  observations: readonly BoundTaskObservation[];
}>;
export class TaskObservationError extends Error { code: string; }
export function taskObservationDigest(value: unknown, length?: number): string;
export function normalizeTaskObservationLabel(value: unknown, label?: string, maximum?: number): string;
export function validateTaskObservationBridge(value: unknown): TaskObservationBridge;
export function createTaskObservationBridgeRegistry(connectors?: unknown): ReadonlyMap<string, TaskObservationBridge>;
export function parseTaskObservationDocument(value: unknown, options: {
  selectedConnectorIds: readonly string[];
  connectors?: unknown;
  bridges?: ReadonlyMap<string, TaskObservationBridge>;
  now?: string | number | Date;
}): TaskObservationDocument;
