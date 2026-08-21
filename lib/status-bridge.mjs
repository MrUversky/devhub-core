const STATUS_PATH = "/api/status";
const STATUS_STATES = new Set(["up", "down", "stopped", "degraded", "registered", "protected", "unknown"]);
const STATUS_SOURCES = new Set(["probe", "reported", "catalog"]);
const STATUS_REASONS = new Set(["live-probe", "reported", "catalog-only", "remote-loopback", "probe-timeout", "probe-failed"]);
const REFRESH_MODES = new Set(["cache", "refresh", "mixed", "shared"]);
const STATUS_FIELDS = new Set([
  "key", "state", "source", "reason", "checkedAt", "observedAt", "latencyMs", "httpStatus",
  "note", "ageMs", "freshness", "refreshAfter",
]);
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

function parseHttpsOrigin(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must contain absolute HTTPS origins.`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password
      || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.origin === "null") {
    throw new Error(`${label} must contain origin-only HTTPS URLs without credentials, paths, query strings, or fragments.`);
  }
  return parsed.origin;
}

export function parseStatusCorsOrigins(value) {
  if (typeof value !== "string" || !value.trim()) return [];
  const origins = value.split(",").map((entry) => entry.trim());
  if (origins.some((origin) => !origin || origin === "*")) {
    throw new Error("DEVHUB_STATUS_CORS_ORIGINS must be a comma-separated list of exact HTTPS origins; wildcard and empty entries are not allowed.");
  }
  return [...new Set(origins.map((origin) => parseHttpsOrigin(origin, "DEVHUB_STATUS_CORS_ORIGINS")))];
}

export function isAllowedStatusCorsOrigin(origin, allowedOrigins) {
  return typeof origin === "string" && allowedOrigins.includes(origin);
}

export function resolveStatusApiEndpoint(value) {
  if (typeof value !== "string" || !value.trim()) return STATUS_PATH;
  const origin = parseHttpsOrigin(value.trim(), "DEVHUB_STATUS_API_BASE_URL");
  return `${origin}${STATUS_PATH}`;
}

function timestampMs(value) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

function hasExactFields(value, allowed) {
  return Object.keys(value).every((field) => allowed.has(field));
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function hasConsistentStatusSemantics(value) {
  if (value.source === "probe") {
    if (value.reason === "live-probe") return value.state === "up" || value.state === "protected" || value.state === "down";
    return (value.reason === "probe-timeout" || value.reason === "probe-failed") && value.state === "down";
  }
  if (value.source === "reported") {
    return (value.reason === "reported" || value.reason === "remote-loopback") && value.state !== "protected";
  }
  return value.source === "catalog"
    && (value.reason === "catalog-only" || value.reason === "remote-loopback")
    && (value.state === "registered" || value.state === "unknown");
}

function normalizeStatus(value, snapshotObservedAtMs) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !hasExactFields(value, STATUS_FIELDS)
      || typeof value.key !== "string" || !value.key || /[\r\n\t]/.test(value.key)
      || !STATUS_STATES.has(value.state) || !STATUS_SOURCES.has(value.source) || !STATUS_REASONS.has(value.reason)
      || (value.freshness !== "fresh" && value.freshness !== "stale")
      || !isNonNegativeInteger(value.ageMs) || timestampMs(value.refreshAfter) === null
      || !hasConsistentStatusSemantics(value)) {
    return null;
  }
  const checkedAtMs = timestampMs(value.checkedAt);
  const refreshAfterMs = timestampMs(value.refreshAfter);
  const statusObservedAtMs = Object.hasOwn(value, "observedAt") ? timestampMs(value.observedAt) : null;
  if (checkedAtMs === null || checkedAtMs > snapshotObservedAtMs || refreshAfterMs <= checkedAtMs
      || (Object.hasOwn(value, "observedAt") && (statusObservedAtMs === null || statusObservedAtMs > checkedAtMs))
      || value.ageMs !== Math.max(0, snapshotObservedAtMs - checkedAtMs)
      || (value.freshness === "fresh" ? snapshotObservedAtMs >= refreshAfterMs : snapshotObservedAtMs < refreshAfterMs)
      || (value.source === "probe" && statusObservedAtMs !== checkedAtMs)
      || (Object.hasOwn(value, "latencyMs") && (!isNonNegativeInteger(value.latencyMs) || value.source !== "probe"))
      || (Object.hasOwn(value, "httpStatus")
        && (!Number.isInteger(value.httpStatus) || value.httpStatus < 100 || value.httpStatus > 599
          || value.source !== "probe" || value.reason !== "live-probe"))
      || (Object.hasOwn(value, "note") && typeof value.note !== "string")) {
    return null;
  }
  const normalized = {
    key: value.key,
    state: value.state,
    source: value.source,
    reason: value.reason,
    checkedAt: value.checkedAt,
    ageMs: value.ageMs,
    freshness: value.freshness,
    refreshAfter: value.refreshAfter,
  };
  for (const optional of ["observedAt", "latencyMs", "httpStatus", "note"]) {
    if (Object.hasOwn(value, optional)) normalized[optional] = value[optional];
  }
  return normalized;
}

export function selectReviewedStatusSnapshot(value, reviewedKeys) {
  const snapshotObservedAtMs = timestampMs(value?.observedAt);
  const newestCheckedAtMs = value?.freshness?.newestCheckedAt === null ? null : timestampMs(value?.freshness?.newestCheckedAt);
  if (!value || typeof value !== "object" || Array.isArray(value) || snapshotObservedAtMs === null
      || snapshotObservedAtMs > Date.now() + MAX_CLOCK_SKEW_MS
      || !Array.isArray(value.statuses)
      || !value.freshness || typeof value.freshness !== "object"
      || !REFRESH_MODES.has(value.freshness.mode)
      || !(newestCheckedAtMs !== null || value.freshness.newestCheckedAt === null)
      || (newestCheckedAtMs !== null && newestCheckedAtMs > snapshotObservedAtMs)
      || !isNonNegativeInteger(value.freshness.maxAgeMs)) {
    return null;
  }
  const statuses = value.statuses.map((status) => normalizeStatus(status, snapshotObservedAtMs));
  if (statuses.some((status) => status === null)
      || new Set(statuses.map((status) => status.key)).size !== statuses.length
      || (statuses.length === 0 ? newestCheckedAtMs !== null || value.freshness.maxAgeMs !== 0
        : newestCheckedAtMs !== Math.max(...statuses.map((status) => timestampMs(status.checkedAt)))
          || value.freshness.maxAgeMs !== Math.max(...statuses.map((status) => status.ageMs)))) {
    return null;
  }
  const allowedKeys = reviewedKeys instanceof Set ? reviewedKeys : new Set(reviewedKeys);
  return {
    observedAt: value.observedAt,
    statuses: statuses.filter((status) => allowedKeys.has(status.key)),
    freshness: {
      mode: value.freshness.mode,
      newestCheckedAt: value.freshness.newestCheckedAt,
      maxAgeMs: value.freshness.maxAgeMs,
    },
  };
}

export function isFreshLiveStatus(status) {
  return Boolean(status && status.source === "probe" && status.reason === "live-probe" && status.freshness === "fresh"
    && (status.state === "up" || status.state === "protected"));
}

export function statusBridgePresentation(status) {
  if (status?.source === "probe" && status.freshness !== "fresh" && status.freshness !== "stale") {
    return Object.freeze({ state: "unknown", label: "NOT CHECKED" });
  }
  if (status?.source === "probe" && status.freshness === "stale") {
    return Object.freeze({ state: "stale", label: "STALE" });
  }
  const state = status?.state || "unknown";
  if (status?.source === "reported" && state === "up") {
    return Object.freeze({ state: "reported", label: "REPORTED UP" });
  }
  if ((state === "up" || state === "protected") && !isFreshLiveStatus(status)) {
    return Object.freeze({ state: "unknown", label: "NOT CHECKED" });
  }
  const labels = {
    up: "LIVE",
    down: "UNREACHABLE",
    stopped: "STOPPED",
    degraded: "DEGRADED",
    registered: "NOT CHECKED",
    protected: "LOGIN",
    unknown: "NOT CHECKED",
    checking: "CHECKING",
  };
  return Object.freeze({ state, label: labels[state] ?? String(state).toUpperCase() });
}

export const SAME_ORIGIN_STATUS_API_ENDPOINT = STATUS_PATH;
