const DEFAULT_ORDINARY_INTERVAL_SECONDS = 300;
const DEFAULT_ON_DEMAND_INTERVAL_SECONDS = 900;
const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_JITTER_PERCENT = 10;

const MIN_ORDINARY_INTERVAL_SECONDS = 60;
const MAX_INTERVAL_SECONDS = 86_400;
const MAX_CONCURRENCY = 16;
const MAX_JITTER_PERCENT = 25;

function boundedInteger(env, name, fallback, minimum, maximum) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function parseStatusPollingConfig(env = {}) {
  const ordinaryIntervalSeconds = boundedInteger(
    env,
    "DEVHUB_STATUS_PROBE_INTERVAL_SECONDS",
    DEFAULT_ORDINARY_INTERVAL_SECONDS,
    MIN_ORDINARY_INTERVAL_SECONDS,
    MAX_INTERVAL_SECONDS,
  );
  const onDemandIntervalSeconds = boundedInteger(
    env,
    "DEVHUB_STATUS_ON_DEMAND_INTERVAL_SECONDS",
    DEFAULT_ON_DEMAND_INTERVAL_SECONDS,
    MIN_ORDINARY_INTERVAL_SECONDS,
    MAX_INTERVAL_SECONDS,
  );
  if (onDemandIntervalSeconds < ordinaryIntervalSeconds) {
    throw new TypeError("DEVHUB_STATUS_ON_DEMAND_INTERVAL_SECONDS must be greater than or equal to DEVHUB_STATUS_PROBE_INTERVAL_SECONDS");
  }

  return Object.freeze({
    ordinaryIntervalMs: ordinaryIntervalSeconds * 1000,
    onDemandIntervalMs: onDemandIntervalSeconds * 1000,
    maxConcurrency: boundedInteger(env, "DEVHUB_STATUS_MAX_CONCURRENCY", DEFAULT_MAX_CONCURRENCY, 1, MAX_CONCURRENCY),
    jitterPercent: boundedInteger(env, "DEVHUB_STATUS_JITTER_PERCENT", DEFAULT_JITTER_PERCENT, 0, MAX_JITTER_PERCENT),
  });
}

export function statusCadenceForService(service, host) {
  return service.mode === "on-demand" && new Set(["mac", "windows", "linux"]).has(host?.kind) ? "on-demand" : "ordinary";
}

function jitteredInterval(key, cadence, config) {
  const base = cadence === "on-demand" ? config.onDemandIntervalMs : config.ordinaryIntervalMs;
  if (config.jitterPercent === 0) return base;

  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const ratio = (hash >>> 0) / 0xffffffff;
  return Math.round(base * (1 + ratio * config.jitterPercent / 100));
}

function validateEntry(entry) {
  if (!entry || typeof entry !== "object" || typeof entry.key !== "string" || entry.key.length === 0) {
    throw new TypeError("Status polling entries require a non-empty key");
  }
  if (entry.cadence !== "ordinary" && entry.cadence !== "on-demand") {
    throw new TypeError(`Unsupported status polling cadence for ${entry.key}`);
  }
}

function validateStatus(entry, value) {
  if (!value || typeof value !== "object" || value.key !== entry.key) {
    throw new TypeError(`Status loader returned the wrong key for ${entry.key}`);
  }
  if (typeof value.checkedAt !== "string" || !Number.isFinite(Date.parse(value.checkedAt))) {
    throw new TypeError(`Status loader returned an invalid checkedAt for ${entry.key}`);
  }
  return value;
}

export function createStatusPollingRuntime({ config, clock = Date.now, load, onLoadError, logger = () => {} }) {
  if (!config || typeof config !== "object") throw new TypeError("Status polling config is required");
  if (!Number.isSafeInteger(config.ordinaryIntervalMs) || config.ordinaryIntervalMs < 1
    || !Number.isSafeInteger(config.onDemandIntervalMs) || config.onDemandIntervalMs < config.ordinaryIntervalMs
    || !Number.isSafeInteger(config.maxConcurrency) || config.maxConcurrency < 1 || config.maxConcurrency > MAX_CONCURRENCY
    || !Number.isSafeInteger(config.jitterPercent) || config.jitterPercent < 0 || config.jitterPercent > MAX_JITTER_PERCENT) {
    throw new TypeError("Status polling config is invalid");
  }
  if (typeof clock !== "function" || typeof load !== "function" || typeof onLoadError !== "function" || typeof logger !== "function") {
    throw new TypeError("Status polling runtime dependencies must be functions");
  }

  const cache = new Map();
  const inFlight = new Map();
  const queue = [];
  let active = 0;

  function drain() {
    while (active < config.maxConcurrency && queue.length > 0) {
      const queued = queue.shift();
      active += 1;
      Promise.resolve()
        .then(queued.task)
        .then(queued.resolve, queued.reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  }

  function schedule(task) {
    return new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      drain();
    });
  }

  function loadEntry(entry) {
    let pending;
    pending = schedule(async () => {
      let value;
      try {
        value = validateStatus(entry, await load(entry));
      } catch (error) {
        value = validateStatus(entry, await onLoadError(entry, error, new Date(clock()).toISOString()));
      }
      const storedAt = clock();
      const record = Object.freeze({
        value: Object.freeze({ ...value }),
        expiresAt: storedAt + jitteredInterval(entry.key, entry.cadence, config),
      });
      cache.set(entry.key, record);
      return record;
    }).finally(() => {
      if (inFlight.get(entry.key) === pending) inFlight.delete(entry.key);
    });
    inFlight.set(entry.key, pending);
    return pending;
  }

  async function getSnapshot(entries) {
    if (!Array.isArray(entries)) throw new TypeError("Status polling entries must be an array");
    const keys = new Set();
    for (const entry of entries) {
      validateEntry(entry);
      if (keys.has(entry.key)) throw new TypeError(`Duplicate status polling key: ${entry.key}`);
      keys.add(entry.key);
    }

    const startedAt = clock();
    const stats = { cacheHits: 0, refreshed: 0, shared: 0 };
    const records = await Promise.all(entries.map((entry) => {
      const cached = cache.get(entry.key);
      if (cached && cached.expiresAt > startedAt) {
        stats.cacheHits += 1;
        return cached;
      }
      const shared = inFlight.get(entry.key);
      if (shared) {
        stats.shared += 1;
        return shared;
      }
      stats.refreshed += 1;
      return loadEntry(entry);
    }));

    const respondedAt = clock();
    const statuses = records.map((record) => {
      const checkedAtMs = Date.parse(record.value.checkedAt);
      return {
        ...record.value,
        ageMs: Math.max(0, respondedAt - checkedAtMs),
        freshness: respondedAt < record.expiresAt ? "fresh" : "stale",
        refreshAfter: new Date(record.expiresAt).toISOString(),
      };
    });
    const checkedTimes = statuses.map((status) => Date.parse(status.checkedAt));
    const mode = stats.refreshed > 0
      ? stats.cacheHits > 0 || stats.shared > 0 ? "mixed" : "refresh"
      : stats.shared > 0 ? "shared" : "cache";
    const freshness = {
      mode,
      cacheHits: stats.cacheHits,
      refreshed: stats.refreshed,
      shared: stats.shared,
      ordinaryIntervalMs: config.ordinaryIntervalMs,
      onDemandIntervalMs: config.onDemandIntervalMs,
      maxConcurrency: config.maxConcurrency,
      oldestCheckedAt: checkedTimes.length > 0 ? new Date(Math.min(...checkedTimes)).toISOString() : null,
      newestCheckedAt: checkedTimes.length > 0 ? new Date(Math.max(...checkedTimes)).toISOString() : null,
      nextRefreshAt: records.length > 0 ? new Date(Math.min(...records.map((record) => record.expiresAt))).toISOString() : null,
      maxAgeMs: checkedTimes.length > 0 ? Math.max(...checkedTimes.map((checkedAt) => Math.max(0, respondedAt - checkedAt))) : 0,
    };

    if (stats.refreshed > 0) {
      logger(Object.freeze({
        event: "status-refresh",
        requested: entries.length,
        ...stats,
        durationMs: Math.max(0, respondedAt - startedAt),
      }));
    }

    return { observedAt: new Date(respondedAt).toISOString(), statuses, freshness };
  }

  return Object.freeze({
    getSnapshot,
    clear() {
      cache.clear();
    },
  });
}
