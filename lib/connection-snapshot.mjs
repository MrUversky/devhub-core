import { parseConnectionProfileDocument } from "./setup-session.mjs";

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function validUntil(profile) {
  if (!profile.lastObservedAt) return null;
  return new Date(new Date(profile.lastObservedAt).getTime() + (profile.freshForSeconds * 1000)).toISOString();
}

export function createConnectionSnapshot(document) {
  if (document === undefined || document === null) {
    return freeze({ version: 1, source: "not-configured", profiles: [] });
  }

  const profiles = parseConnectionProfileDocument(document).map((profile) => ({
    connectorId: profile.connectorId,
    state: profile.state,
    lastObservedAt: profile.lastObservedAt,
    validUntil: validUntil(profile),
  }));

  profiles.sort((left, right) => left.connectorId.localeCompare(right.connectorId)
    || String(left.lastObservedAt).localeCompare(String(right.lastObservedAt)));
  return freeze({ version: 1, source: "reviewed-profiles", profiles });
}
