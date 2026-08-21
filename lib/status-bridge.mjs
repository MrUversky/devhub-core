const STATUS_PATH = "/api/status";
const STATUS_STATES = new Set(["up", "down", "stopped", "degraded", "registered", "protected", "unknown"]);
const STATUS_SOURCES = new Set(["probe", "reported", "catalog"]);
const STATUS_REASONS = new Set(["live-probe", "reported", "catalog-only", "remote-loopback", "probe-timeout", "probe-failed"]);
const REFRESH_MODES = new Set(["cache", "refresh", "mixed", "shared"]);

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

function isTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isStatus(value) {
  return Boolean(value && typeof value === "object"
    && typeof value.key === "string"
    && STATUS_STATES.has(value.state)
    && STATUS_SOURCES.has(value.source)
    && STATUS_REASONS.has(value.reason)
    && isTimestamp(value.checkedAt)
    && (!Object.hasOwn(value, "observedAt") || isTimestamp(value.observedAt))
    && (!Object.hasOwn(value, "refreshAfter") || isTimestamp(value.refreshAfter))
    && (!Object.hasOwn(value, "freshness") || value.freshness === "fresh" || value.freshness === "stale"));
}

export function selectReviewedStatusSnapshot(value, reviewedKeys) {
  if (!value || typeof value !== "object" || !isTimestamp(value.observedAt)
      || !Array.isArray(value.statuses) || !value.statuses.every(isStatus)
      || !value.freshness || typeof value.freshness !== "object"
      || !REFRESH_MODES.has(value.freshness.mode)
      || !(isTimestamp(value.freshness.newestCheckedAt) || value.freshness.newestCheckedAt === null)
      || typeof value.freshness.maxAgeMs !== "number") {
    return null;
  }
  const allowedKeys = reviewedKeys instanceof Set ? reviewedKeys : new Set(reviewedKeys);
  return {
    observedAt: value.observedAt,
    statuses: value.statuses.filter((status) => allowedKeys.has(status.key)),
    freshness: {
      mode: value.freshness.mode,
      newestCheckedAt: value.freshness.newestCheckedAt,
      maxAgeMs: value.freshness.maxAgeMs,
    },
  };
}

export const SAME_ORIGIN_STATUS_API_ENDPOINT = STATUS_PATH;
