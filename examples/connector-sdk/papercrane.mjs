// Paper Crane is fictional. It demonstrates a third-party inventory shape that
// does not resemble DevHub's catalog or any supported provider API.
import { defineConnectorContract } from "../../lib/connector-conformance.mjs";

export const PAPERCRANE_CONNECTOR_DEFINITION = Object.freeze({
  id: "papercrane",
  name: "Paper Crane (fictional)",
  priority: 1,
  category: "runtime",
  stage: "available",
  summary: "Fictional edge cells grouped into provider-owned folios and lanes.",
  capabilities: Object.freeze(["inventory", "runtimes", "environments"]),
  auth: Object.freeze(["secret-reference"]),
  detection: Object.freeze({ commands: Object.freeze([]), markers: Object.freeze([]) }),
});

export const PAPERCRANE_INVENTORY_ADAPTER_ID = "papercrane-inventory-v1";

export const PAPERCRANE_CONNECTOR_CONTRACT = defineConnectorContract({
  formatVersion: 1,
  connectorId: "papercrane",
  provider: "papercrane",
  compatibility: {
    status: "experimental",
    since: "0.10.0",
    deprecatedSince: null,
    replacementConnectorId: null,
  },
  capabilities: {
    profiles: [],
    setup: [],
    inventory: [{ id: PAPERCRANE_INVENTORY_ADAPTER_ID, formatVersion: 1 }],
    evidence: [],
  },
  limits: {
    deadlineMs: 10_000,
    maxPages: 20,
    maxResponseBytes: 1024 * 1024,
    maxCandidates: 200,
  },
  boundaries: {
    exactScope: true,
    credentialIsolation: true,
    readOnly: true,
    hardDeadline: true,
    boundedPagination: true,
    boundedResponses: true,
    boundedCandidates: true,
    freshnessRequired: true,
    secretsRejected: true,
    normalizedOnly: true,
    providerMutations: false,
    catalogWrites: false,
    catalogMatching: false,
    ownershipDecisions: false,
  },
});

const WORKSPACE_REF = /^[a-z][a-z0-9-]{2,63}$/;
const REASON = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PHASES = new Map([
  ["warm", "running"],
  ["cold", "stopped"],
  ["folding", "deploying"],
  ["torn", "failed"],
]);

function unavailable(reason) {
  return { status: "unavailable", reason: REASON.test(reason) ? reason : "provider-invalid-response" };
}

function exactScope(scope) {
  return Boolean(scope
    && typeof scope === "object"
    && !Array.isArray(scope)
    && Object.keys(scope).length === 2
    && scope.kind === "workspace"
    && typeof scope.id === "string"
    && WORKSPACE_REF.test(scope.id));
}

function parsePage(value, { workspaceId, cursor, maxResponseBytes }) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maxResponseBytes) {
    return { ok: false, reason: "provider-response-too-large" };
  }
  let page;
  try {
    page = JSON.parse(value);
  } catch {
    return { ok: false, reason: "provider-invalid-json" };
  }
  if (!page || typeof page !== "object" || Array.isArray(page)
      || page.workspaceRef !== workspaceId || page.requestCursor !== cursor
      || typeof page.capturedAt !== "string" || !Number.isFinite(Date.parse(page.capturedAt))
      || !Array.isArray(page.folios)
      || (page.nextCursor !== null && (typeof page.nextCursor !== "string" || !WORKSPACE_REF.test(page.nextCursor)))) {
    return { ok: false, reason: "provider-scope-mismatch" };
  }
  return { ok: true, value: page };
}

function normalizeCell(folio, lane, cell, observedAt) {
  if (!folio || typeof folio !== "object" || !lane || typeof lane !== "object" || !cell || typeof cell !== "object") return null;
  if (![folio.folioRef, folio.caption, lane.laneRef, lane.label, cell.cellRef, cell.caption, cell.region]
    .every((value) => typeof value === "string" && value.length > 0)) return null;
  if (!Array.isArray(cell.entrypoints) || cell.entrypoints.some((url) => typeof url !== "string")) return null;
  return {
    provider: "papercrane",
    resourceType: "edge-cell",
    resourceId: cell.cellRef,
    parentResourceId: folio.folioRef,
    name: cell.caption,
    environment: lane.label,
    runtime: "edge",
    status: PHASES.get(cell.phase) ?? "unknown",
    urls: cell.entrypoints.map((url) => ({ kind: "service", url })),
    observedAt,
    metadata: {
      region: cell.region,
      projectId: folio.folioRef,
      environmentId: lane.laneRef,
      serviceId: cell.cellRef,
    },
  };
}

export function createPaperCraneInventoryAdapter({
  readPage,
  maxResponseBytes = PAPERCRANE_CONNECTOR_CONTRACT.limits.maxResponseBytes,
} = {}) {
  if (typeof readPage !== "function") throw new TypeError("Paper Crane example requires an injected readPage transport");
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1
      || maxResponseBytes > PAPERCRANE_CONNECTOR_CONTRACT.limits.maxResponseBytes) {
    throw new TypeError("Paper Crane maxResponseBytes exceeds its reviewed connector contract");
  }
  return Object.freeze({
    id: PAPERCRANE_INVENTORY_ADAPTER_ID,
    provider: "papercrane",
    validateScope: exactScope,
    async collect(request) {
      if (request?.provider !== "papercrane" || !exactScope(request?.scope)) return unavailable("binding-not-applicable");
      if (typeof request.credential !== "string" || request.credential.length === 0) return unavailable("credential-unavailable");
      if (!request.limits || !Number.isSafeInteger(request.limits.maxPages)
          || !Number.isSafeInteger(request.limits.maxResources)
          || !Number.isSafeInteger(request.limits.deadlineMs)
          || !Number.isSafeInteger(request.limits.maxResponseBytes)
          || !request.signal || typeof request.signal.addEventListener !== "function") {
        return unavailable("invalid-adapter-request");
      }
      const responseLimit = Math.min(maxResponseBytes, request.limits.maxResponseBytes);
      const candidates = [];
      let observedAt = request.now;
      let cursor = null;
      let pagesRead = 0;
      try {
        do {
          if (request.signal.aborted) return unavailable("provider-timeout");
          if (pagesRead >= request.limits.maxPages) return unavailable("provider-page-limit-exceeded");
          const raw = await readPage({
            workspaceId: request.scope.id,
            cursor,
            credential: request.credential,
            signal: request.signal,
          });
          const parsed = parsePage(raw, { workspaceId: request.scope.id, cursor, maxResponseBytes: responseLimit });
          if (!parsed.ok) return unavailable(parsed.reason);
          pagesRead += 1;
          observedAt = new Date(parsed.value.capturedAt).toISOString();
          for (const folio of parsed.value.folios) {
            if (!Array.isArray(folio?.lanes)) return unavailable("provider-invalid-response");
            for (const lane of folio.lanes) {
              if (!Array.isArray(lane?.cells)) return unavailable("provider-invalid-response");
              for (const cell of lane.cells) {
                const candidate = normalizeCell(folio, lane, cell, observedAt);
                if (!candidate) return unavailable("provider-invalid-response");
                candidates.push(candidate);
                if (candidates.length > request.limits.maxResources) {
                  return unavailable("provider-resource-limit-exceeded");
                }
              }
            }
          }
          cursor = parsed.value.nextCursor;
        } while (cursor !== null);
      } catch {
        return unavailable(request.signal.aborted ? "provider-timeout" : "provider-unavailable");
      }
      return { status: "success", observedAt, pagesRead, candidates };
    },
  });
}
