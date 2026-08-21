import { resolveConnectorConnection } from "./connection-status.mjs";
import { listConnectors } from "./connectors.mjs";

const PRESENTATION_STATES = Object.freeze([
  "ready",
  "needs-scope",
  "reconnect",
  "retry",
  "reviewed-binding-required",
]);

// Browser-safe projection of the canonical server contracts. The server-side
// preflight asserts parity before any setup session can run.
export const SETUP_RUN_CONNECTOR_SUPPORT = Object.freeze({
  github: Object.freeze({ setup: true, inventory: false, evidence: true }),
  "local-host": Object.freeze({ setup: true, inventory: false, evidence: false }),
  vercel: Object.freeze({ setup: true, inventory: true, evidence: true }),
  railway: Object.freeze({ setup: true, inventory: true, evidence: false }),
  sentry: Object.freeze({ setup: false, inventory: false, evidence: true }),
  openai: Object.freeze({ setup: true, inventory: true, evidence: true }),
});

export class SetupRunError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SetupRunError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new SetupRunError(code, message);
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function timestamp(value, label) {
  const date = new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) fail("setup-run-invalid", `${label} must be a valid timestamp`);
  return date;
}

function selectedDefinitions(selectedConnectorIds) {
  if (!Array.isArray(selectedConnectorIds) || !selectedConnectorIds.length) {
    fail("setup-run-sources-required", "setup-run requires at least one selected source");
  }
  if (selectedConnectorIds.some((id) => typeof id !== "string" || !id.trim())) {
    fail("setup-run-source-invalid", "setup-run source IDs must be non-empty strings");
  }
  const requested = new Set(selectedConnectorIds);
  if (requested.size !== selectedConnectorIds.length) fail("setup-run-source-invalid", "setup-run source IDs must be unique");
  const selected = listConnectors().filter((definition) => requested.has(definition.id));
  if (selected.length !== requested.size || selected.some((definition) => definition.stage !== "available" || !SETUP_RUN_CONNECTOR_SUPPORT[definition.id])) {
    fail("setup-run-source-unsupported", "setup-run accepts only available canonical source IDs");
  }
  return selected;
}

function presentationState(connection, support) {
  if (!support.setup) return { status: "reviewed-binding-required", reason: "This source is supported through reviewed inventory or evidence bindings, not an on-demand setup profile.", nextAction: { id: "review-binding", label: "Review an exact binding" } };
  if (connection.state === "connected") return { status: "ready", reason: "A fresh reviewed connection is ready for one bounded read-only check.", nextAction: { id: "run-check", label: "Run bounded check" } };
  if (connection.state === "stale" || connection.state === "authorization-required") return { status: "reconnect", reason: connection.state === "stale" ? "The reviewed connection is stale and must be rechecked before provider discovery." : "The reviewed connection needs authorization before provider discovery.", nextAction: { id: "reconnect", label: "Reconnect safely" } };
  if (connection.state === "not-configured") return { status: "needs-scope", reason: "Choose and review an exact account, project, workspace, repository, or host scope first.", nextAction: { id: "review-scope", label: "Review exact scope" } };
  return { status: "retry", reason: "The reviewed connection could not be verified; detection alone cannot make it ready.", nextAction: { id: "retry", label: "Retry connection check" } };
}

function planningDetection(planning, connectorId) {
  const connector = planning?.connectors?.find?.((item) => item?.id === connectorId);
  if (!connector || !["detected", "not-detected", "not-detectable", "unknown"].includes(connector.detection?.state)) return freeze({ state: "unknown", informationalOnly: true });
  return freeze({ state: connector.detection.state, informationalOnly: true });
}

export function createSetupRunPresentationPreflight({ selectedConnectorIds, connections, now, planning = null }) {
  const evaluatedAt = timestamp(now, "setup-run preflight clock").toISOString();
  const selected = selectedDefinitions(selectedConnectorIds).map((definition) => {
    const support = SETUP_RUN_CONNECTOR_SUPPORT[definition.id];
    const connection = resolveConnectorConnection(connections, definition.id, { now: evaluatedAt });
    const presentation = presentationState(connection, support);
    if (!PRESENTATION_STATES.includes(presentation.status)) fail("setup-run-invalid", "unsupported setup presentation state");
    return freeze({ connectorId: definition.id, name: definition.name, support, status: presentation.status, reason: presentation.reason, nextAction: presentation.nextAction, connection: { state: connection.state, profileCount: connection.profileCount, attentionCount: connection.attentionCount, lastObservedAt: connection.lastObservedAt, validUntil: connection.validUntil }, detection: planningDetection(planning, definition.id) });
  });
  const count = (status) => selected.filter((source) => source.status === status).length;
  return freeze({ version: 1, evaluatedAt, selected, summary: { selected: selected.length, ready: count("ready"), needsScope: count("needs-scope"), reconnect: count("reconnect"), retry: count("retry"), reviewedBindingRequired: count("reviewed-binding-required"), needsAttention: selected.filter((source) => source.status !== "ready").length } });
}
