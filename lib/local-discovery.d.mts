export type LocalDiscoveryLimits = Readonly<{
  maxDepth: number;
  maxEntries: number;
  maxBytes: number;
  deadlineMs: number;
}>;

export type LocalDiscoveryDocument = Readonly<{
  version: 1;
  command: "discover-local";
  readOnly: true;
  persistent: false;
  catalogWrites: false;
  repositoryWrites: false;
  host: Readonly<{ id: string; kind: "mac" | "linux" }>;
  identity: Readonly<{ source: "explicit-argument"; verified: false }>;
  status: "complete" | "unknown";
  observedAt: string;
  validUntil: string;
  scope: Readonly<{ rootCount: number; rootIds: readonly string[] }>;
  limits: LocalDiscoveryLimits & Readonly<{
    entriesVisited: number;
    bytesRead: number;
    depthLimited: boolean;
    symlinksSkipped: number;
  }>;
  reason: string | null;
  candidates: readonly Readonly<Record<string, unknown>>[];
}>;

export const LOCAL_DISCOVERY_DEFAULT_LIMITS: LocalDiscoveryLimits;
export class LocalDiscoveryError extends Error { code: string; }
export function normalizeLocalDiscoveryLimits(value?: Partial<LocalDiscoveryLimits>): LocalDiscoveryLimits;
export function validateExplicitLocalRoots(roots: readonly string[]): readonly string[];
export function localWorkspaceId(hostId: string, absolutePath: string): string;
export function localRootId(absolutePath: string): string;
export function createUnknownLocalDiscoveryDocument(options: {
  host: Readonly<{ id: string; kind: "mac" | "linux" }>;
  roots: readonly string[];
  observedAt?: string | number | Date;
  limits?: Partial<LocalDiscoveryLimits>;
  reason: string;
}): LocalDiscoveryDocument;
export function validateLocalDiscoveryDocument(value: unknown, options?: {
  expectedHost?: Readonly<{ id: string; kind: "mac" | "linux" }>;
  now?: string | number | Date;
}): LocalDiscoveryDocument;
export function discoverLocalCandidates(options: {
  host: Readonly<{ id: string; kind: "mac" | "linux" }>;
  roots: readonly string[];
  observedAt?: string | number | Date;
  limits?: Partial<LocalDiscoveryLimits>;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  signal?: AbortSignal;
  clock?: () => number;
}): Promise<LocalDiscoveryDocument>;
