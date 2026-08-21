const DISPLAY_STATES = new Set([
  "connected",
  "stale",
  "authorization-required",
  "unavailable",
  "unknown",
  "not-configured",
]);

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

export function resolveConnectorConnection(snapshot, connectorId, options = {}) {
  if (!snapshot || snapshot.version !== 1 || !["reviewed-profiles", "not-configured"].includes(snapshot.source) || !Array.isArray(snapshot.profiles)) {
    throw new TypeError("connection snapshot must be a reviewed redacted v1 snapshot");
  }
  if (typeof connectorId !== "string" || !connectorId) throw new TypeError("connector id is required");
  const now = new Date(options.now ?? new Date().toISOString());
  if (Number.isNaN(now.getTime())) throw new TypeError("connection status clock must be an ISO timestamp");

  const profiles = snapshot.profiles.filter((profile) => profile.connectorId === connectorId);
  if (!profiles.length) {
    return freeze({ state: "not-configured", profileCount: 0, attentionCount: 0, lastObservedAt: null, validUntil: null });
  }

  const fresh = profiles.filter((profile) => profile.state === "connected" && profile.validUntil && new Date(profile.validUntil) > now);
  const stale = profiles.filter((profile) => profile.state === "connected" && (!profile.validUntil || new Date(profile.validUntil) <= now));
  const orderedStates = ["authorization-required", "unavailable", "unknown"];
  let state;
  let selected;
  if (fresh.length) {
    state = "connected";
    selected = fresh;
  } else if (stale.length) {
    state = "stale";
    selected = stale;
  } else {
    state = orderedStates.find((candidate) => profiles.some((profile) => profile.state === candidate)) ?? "unknown";
    selected = profiles.filter((profile) => profile.state === state);
  }
  if (!DISPLAY_STATES.has(state)) state = "unknown";

  const latest = [...selected].sort((left, right) => String(right.lastObservedAt).localeCompare(String(left.lastObservedAt)))[0];
  const attentionCount = profiles.filter((profile) => profile.state !== "connected" || !profile.validUntil || new Date(profile.validUntil) <= now).length;
  return freeze({
    state,
    profileCount: profiles.length,
    attentionCount,
    lastObservedAt: latest?.lastObservedAt ?? null,
    validUntil: latest?.validUntil ?? null,
  });
}
