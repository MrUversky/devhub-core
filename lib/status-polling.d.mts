export type StatusPollingConfig = Readonly<{
  ordinaryIntervalMs: number;
  onDemandIntervalMs: number;
  maxConcurrency: number;
  jitterPercent: number;
}>;

export type StatusPollingCadence = "ordinary" | "on-demand";

export type StatusPollingEntry<TInput = unknown> = {
  key: string;
  cadence: StatusPollingCadence;
  input: TInput;
};

export type PolledStatus = {
  key: string;
  checkedAt: string;
  [key: string]: unknown;
};

export type StatusFreshness = {
  mode: "cache" | "refresh" | "mixed" | "shared";
  cacheHits: number;
  refreshed: number;
  shared: number;
  ordinaryIntervalMs: number;
  onDemandIntervalMs: number;
  maxConcurrency: number;
  oldestCheckedAt: string | null;
  newestCheckedAt: string | null;
  nextRefreshAt: string | null;
  maxAgeMs: number;
};

export type StatusSnapshot<TStatus extends PolledStatus> = {
  observedAt: string;
  statuses: Array<TStatus & {
    ageMs: number;
    freshness: "fresh" | "stale";
    refreshAfter: string;
  }>;
  freshness: StatusFreshness;
};

export type StatusPollingRuntime<TEntry extends StatusPollingEntry, TStatus extends PolledStatus> = Readonly<{
  getSnapshot(entries: TEntry[]): Promise<StatusSnapshot<TStatus>>;
  clear(): void;
}>;

export function parseStatusPollingConfig(env?: Record<string, string | undefined>): StatusPollingConfig;

export function statusCadenceForService(
  service: { mode: string },
  host?: { kind?: string } | null,
): StatusPollingCadence;

export function createStatusPollingRuntime<TEntry extends StatusPollingEntry, TStatus extends PolledStatus>(options: {
  config: StatusPollingConfig;
  clock?: () => number;
  load: (entry: TEntry) => Promise<TStatus> | TStatus;
  onLoadError: (entry: TEntry, error: unknown, checkedAt: string) => Promise<TStatus> | TStatus;
  logger?: (summary: Readonly<{
    event: "status-refresh";
    requested: number;
    cacheHits: number;
    refreshed: number;
    shared: number;
    durationMs: number;
  }>) => void;
}): StatusPollingRuntime<TEntry, TStatus>;
