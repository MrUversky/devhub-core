import { createHash } from "node:crypto";
import path from "node:path";

import { connectorContractRegistry } from "./connector-contracts.mjs";
import { validateNormalizedInventoryResult } from "./inventory-adapters.mjs";
import { localWorkspaceId, validateLocalDiscoveryDocument } from "./local-discovery.mjs";
import { validateOpenAIKeyId, validateOpenAIProjectScope } from "./openai-admin-api.mjs";
import { validateSetupSessionArtifact } from "./setup-state.mjs";
import {
  createReviewedProviderOverlayProposal,
  reconcileProviderInventory,
} from "../scripts/provider-inventory.mjs";

const stableIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const candidateStates = new Set(["exact-match", "possible-match", "new", "reviewed-external", "unknown", "ignored"]);
const reviewDispositions = new Set(["catalog", "new", "external", "ignore"]);
const answerFields = new Set(["productIdentity", "environment", "owner", "payer", "operatingIntent"]);
const questionGroupSize = 50;
const sensitiveKeyPattern = /(?:^|[-_.])(?:api[-_.]?key|authorization|credential|password|passwd|private[-_.]?key|secret|signature|token)(?:$|[-_.])/i;
const secretAssignmentPattern = /\b(?:api[-_]?key|access[-_]?token|authorization|client[-_]?secret|password|passwd|private[-_]?key|secret|token)\s*[:=]\s*["']?(?!\$|\$\{|<|example\b|redacted\b)[A-Za-z0-9_./+=-]{8,}/i;
const secretValuePattern = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bbearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:github_pat_|gh[oprsu]_|sk-(?:proj-)?)[A-Za-z0-9_-]{8,})/i;

export class DiscoveryInboxError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DiscoveryInboxError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new DiscoveryInboxError(code, message);
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactFields(value, allowed, label, code = "invalid-discovery-input") {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) fail(code, `${label}.${field} is not supported`);
  }
}

function safeString(value, label, maximum = 500) {
  if (typeof value !== "string" || !value.trim()) fail("invalid-discovery-input", `${label} must be a non-empty string`);
  if (value.length > maximum) fail("invalid-discovery-input", `${label} must contain at most ${maximum} characters`);
  if (secretAssignmentPattern.test(value) || secretValuePattern.test(value)) fail("unsafe-discovery-input", `${label} appears to contain secret material`);
  const urls = value.match(/https?:\/\/[^\s"']+/gi) ?? [];
  for (const candidate of urls) {
    let parsed;
    try { parsed = new URL(candidate); } catch { continue; }
    if (parsed.username || parsed.password || [...parsed.searchParams.keys()].some((key) => sensitiveKeyPattern.test(key))) {
      fail("unsafe-discovery-input", `${label} contains credentials or a secret-bearing URL`);
    }
  }
  return value.trim();
}

function stableId(value, label) {
  const result = safeString(value, label, 100);
  if (!stableIdPattern.test(result)) fail("invalid-discovery-input", `${label} must use lowercase kebab-case`);
  return result;
}

function isoTimestamp(value, label, nullable = false) {
  if (nullable && value === null) return null;
  const result = safeString(value, label, 50);
  const parsed = new Date(result);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) fail("invalid-discovery-input", `${label} must be an ISO 8601 UTC timestamp`);
  return result;
}

function safeValue(value, label, depth = 0) {
  if (depth > 8) fail("invalid-discovery-input", `${label} exceeds the maximum metadata depth`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("invalid-discovery-input", `${label} must contain finite numbers only`);
    return value;
  }
  if (typeof value === "string") return safeString(value, label, 2_000);
  if (Array.isArray(value)) {
    if (value.length > 1_000) fail("invalid-discovery-input", `${label} contains too many items`);
    return value.map((item, index) => safeValue(item, `${label}[${index}]`, depth + 1));
  }
  if (!plainObject(value)) fail("invalid-discovery-input", `${label} must contain JSON metadata only`);
  if (Object.keys(value).length > 100) fail("invalid-discovery-input", `${label} contains too many fields`);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (!key || key.length > 100 || sensitiveKeyPattern.test(key)) fail("unsafe-discovery-input", `${label}.${key || "<empty>"} is not allowed`);
    return [key, safeValue(item, `${label}.${key}`, depth + 1)];
  }));
}

function safeUrl(value, label, expectedHost = null) {
  const result = safeString(value, label, 2_048);
  let parsed;
  try { parsed = new URL(result); } catch { fail("invalid-discovery-input", `${label} must be an absolute HTTP(S) URL`); }
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password) {
    fail("invalid-discovery-input", `${label} must be a credential-free HTTP(S) URL`);
  }
  if ([...parsed.searchParams.keys()].some((key) => sensitiveKeyPattern.test(key))) fail("unsafe-discovery-input", `${label} contains a secret-bearing query parameter`);
  if (expectedHost && parsed.hostname.toLowerCase() !== expectedHost) fail("invalid-discovery-input", `${label} must use ${expectedHost}`);
  return parsed.toString();
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function digest(value, length = 24) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex").slice(0, length);
}

function validateGitHubRepository(value, label) {
  if (!plainObject(value)) fail("invalid-discovery-input", `${label} must be an object`);
  exactFields(value, new Set([
    "kind", "provider", "providerId", "owner", "name", "fullName", "url", "visibility", "archived", "disabled", "access", "ownership", "identity",
  ]), label);
  if (value.kind !== "repository-candidate" || value.provider !== "github") fail("invalid-discovery-input", `${label} must be a GitHub repository candidate`);
  const providerId = safeString(value.providerId, `${label}.providerId`, 50);
  if (!/^[1-9][0-9]{0,19}$/.test(providerId)) fail("invalid-discovery-input", `${label}.providerId is invalid`);
  const owner = safeString(value.owner, `${label}.owner`, 100);
  const name = safeString(value.name, `${label}.name`, 100);
  const fullName = safeString(value.fullName, `${label}.fullName`, 201);
  if (fullName.toLowerCase() !== `${owner}/${name}`.toLowerCase()) fail("invalid-discovery-input", `${label}.fullName does not match owner/name`);
  const url = safeUrl(value.url, `${label}.url`, "github.com");
  if (new URL(url).pathname.toLowerCase() !== `/${fullName}`.toLowerCase()) fail("invalid-discovery-input", `${label}.url does not match fullName`);
  if (!new Set(["public", "private", "internal"]).has(value.visibility)) fail("invalid-discovery-input", `${label}.visibility is invalid`);
  if (typeof value.archived !== "boolean" || typeof value.disabled !== "boolean") fail("invalid-discovery-input", `${label} archive flags must be booleans`);
  if (!new Set(["read", "write", "admin", "unknown"]).has(value.access) || value.ownership !== "unknown") fail("invalid-discovery-input", `${label} access or ownership is invalid`);
  if (!plainObject(value.identity)) fail("invalid-discovery-input", `${label}.identity must be an object`);
  exactFields(value.identity, new Set(["provider", "owner", "name"]), `${label}.identity`);
  if (value.identity.provider !== "github" || value.identity.owner !== owner || value.identity.name !== name) fail("invalid-discovery-input", `${label}.identity does not match the repository`);
  return { provider: "github", resourceType: "repository", resourceId: providerId, name: fullName, repository: { provider: "github", owner, name }, url, visibility: value.visibility, archived: value.archived, disabled: value.disabled, access: value.access };
}

function validateLocalObservation(value, label) {
  if (!plainObject(value)) fail("invalid-discovery-input", `${label} must be an object`);
  const common = new Set(["kind", "projectId", "projectTitle", "serviceId", "serviceName", "runtime", "mode"]);
  if (value.kind === "service-runtime") {
    exactFields(value, new Set([...common, "source", "identifier", "state", "definition", "activeState", "subState", "unitFileState", "definitionPresent", "loaded", "containersObserved"]), label);
  } else {
    exactFields(value, new Set([...common, "reason", "message"]), label);
  }
  const projectId = stableId(value.projectId, `${label}.projectId`);
  const serviceId = stableId(value.serviceId, `${label}.serviceId`);
  const normalized = { provider: "local-host", resourceType: "service", resourceId: `${projectId}/${serviceId}`, projectId, serviceId, projectTitle: safeString(value.projectTitle, `${label}.projectTitle`, 300), serviceName: safeString(value.serviceName, `${label}.serviceName`, 300), runtime: safeString(value.runtime, `${label}.runtime`, 100), mode: stableId(value.mode, `${label}.mode`) };
  if (value.kind === "service-runtime-unknown") {
    return { ...normalized, uncertain: true, reason: stableId(value.reason, `${label}.reason`), message: safeString(value.message, `${label}.message`, 500) };
  }
  return { ...normalized, uncertain: value.state === "unknown", source: stableId(value.source, `${label}.source`), identifier: safeString(value.identifier, `${label}.identifier`, 300), runtimeState: stableId(value.state, `${label}.state`) };
}

function validateLocalRepositoryObservation(value, label, reviewedScope) {
  if (!plainObject(value)) fail("invalid-discovery-input", `${label} must be an object`);
  exactFields(value, new Set(["kind", "projectId", "hostId", "source", "repository"]), label);
  const projectId = stableId(value.projectId, `${label}.projectId`);
  const hostId = stableId(value.hostId, `${label}.hostId`);
  if (hostId !== reviewedScope?.hostId || value.source !== "git-origin") fail("connection-profile-drift", `${label} does not match the exact reviewed local host`);
  if (!plainObject(value.repository)) fail("invalid-discovery-input", `${label}.repository must be an object`);
  exactFields(value.repository, new Set(["provider", "owner", "name"]), `${label}.repository`);
  const owner = safeString(value.repository.owner, `${label}.repository.owner`, 39);
  const name = safeString(value.repository.name, `${label}.repository.name`, 100);
  if (value.repository.provider !== "github"
      || !/^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(owner)
      || !/^[a-z0-9._-]{1,100}$/.test(name)) {
    fail("invalid-discovery-input", `${label}.repository must be a canonical GitHub repository identity`);
  }
  return { projectId, hostId, source: "git-origin", repository: { provider: "github", owner, name } };
}

const ignoredObservationFields = Object.freeze({
  "account-identity": new Set(["kind", "provider", "providerId", "login", "accountKind"]),
  "reviewed-scope": new Set(["kind", "provider", "providerId", "login", "scopeKind"]),
  "provider-limitation": new Set(["kind", "provider", "code", "state", "summary", "nextActionId"]),
  "exact-evidence-capability": new Set(["kind", "provider", "adapterId", "check", "state"]),
  "inspection-source": new Set(["kind", "type", "available", "timedOut", "observations"]),
  "host-identity": new Set(["kind", "id", "name", "hostKind", "location", "identitySource", "identityVerified"]),
});

function parseObservations(observations, result, label) {
  if (!Array.isArray(observations) || observations.length > 1_000) fail("invalid-discovery-input", `${label} must contain at most 1000 observations`);
  const parsed = [];
  for (const [index, value] of observations.entries()) {
    const itemLabel = `${label}[${index}]`;
    if (!plainObject(value) || typeof value.kind !== "string") fail("invalid-discovery-input", `${itemLabel} must have an allowlisted kind`);
    if (value.kind === "normalized-provider-inventory") {
      exactFields(value, new Set(["kind", "formatVersion", "source", "execution", "freshness", "candidates"]), itemLabel);
      const normalized = validateNormalizedInventoryResult({ formatVersion: value.formatVersion, source: value.source, execution: value.execution, freshness: value.freshness, candidates: value.candidates });
      if (normalized.source.provider !== result.connectorId) fail("invalid-discovery-input", `${itemLabel} provider does not match the setup connector`);
      const contract = connectorContractRegistry.get(result.connectorId)?.contract;
      if (!contract?.capabilities.inventory.some((capability) => capability.id === normalized.source.adapterId && capability.formatVersion === 1)) {
        fail("invalid-discovery-input", `${itemLabel} adapter is not declared by the canonical ${result.connectorId} connector contract`);
      }
      validateProviderInventoryIdentity(normalized, result.connectorId, itemLabel);
      parsed.push({ kind: value.kind, normalized });
    } else if (value.kind === "repository-candidate") {
      if (result.connectorId !== "github") fail("invalid-discovery-input", `${itemLabel} is not valid for ${result.connectorId}`);
      parsed.push({ kind: value.kind, candidate: validateGitHubRepository(value, itemLabel) });
    } else if (value.kind === "project-repository") {
      if (result.connectorId !== "local-host") fail("invalid-discovery-input", `${itemLabel} is not valid for ${result.connectorId}`);
      parsed.push({ kind: value.kind, evidence: validateLocalRepositoryObservation(value, itemLabel, result.reviewedScope) });
    } else if (new Set(["service-runtime", "service-runtime-unknown"]).has(value.kind)) {
      if (result.connectorId !== "local-host") fail("invalid-discovery-input", `${itemLabel} is not valid for ${result.connectorId}`);
      parsed.push({ kind: value.kind, candidate: validateLocalObservation(value, itemLabel) });
    } else if (ignoredObservationFields[value.kind]) {
      exactFields(value, ignoredObservationFields[value.kind], itemLabel);
      safeValue(value, itemLabel);
    } else {
      fail("unsupported-setup-observation", `${itemLabel}.kind is not allowlisted: ${value.kind}`);
    }
  }
  return parsed;
}

function validateProviderInventoryIdentity(normalized, connectorId, label) {
  if (connectorId !== "openai") return;
  const { scope } = normalized.source;
  if (!validateOpenAIProjectScope(scope)
      || normalized.execution.state !== "succeeded"
      || normalized.candidates.length < 1
      || normalized.candidates.length > 50) {
    fail("invalid-discovery-input", `${label} must contain one exact OpenAI project and bounded redacted key metadata`);
  }
  const projectCandidates = normalized.candidates.filter((candidate) => candidate.resourceType === "project");
  if (projectCandidates.length !== 1) {
    fail("invalid-discovery-input", `${label} must contain exactly one reviewed OpenAI project identity`);
  }
  const candidate = projectCandidates[0];
  const candidateFields = new Set([
    "provider", "resourceType", "resourceId", "parentResourceId", "name", "urls",
    "observedAt", "validUntil", "freshness", "metadata",
  ]);
  if (Object.keys(candidate).some((field) => !candidateFields.has(field))
      || candidate.provider !== "openai"
      || candidate.resourceType !== "project"
      || candidate.resourceId !== scope.id
      || candidate.parentResourceId !== scope.parent.id
      || candidate.observedAt !== normalized.freshness.observedAt
      || candidate.validUntil !== normalized.freshness.validUntil
      || candidate.freshness !== "fresh"
      || candidate.urls.length !== 1
      || candidate.urls[0].kind !== "console"
      || candidate.urls[0].url !== "https://platform.openai.com/settings/organization/projects"
      || !plainObject(candidate.metadata)
      || Object.keys(candidate.metadata).sort().join(",") !== "projectId,version,workspaceId"
      || candidate.metadata.projectId !== scope.id
      || candidate.metadata.workspaceId !== scope.parent.id
      || !new Set(["active", "archived"]).has(candidate.metadata.version)) {
    fail("invalid-discovery-input", `${label} candidate does not match the exact reviewed OpenAI organization/project identity`);
  }
  for (const key of normalized.candidates.filter((entry) => entry.resourceType !== "project")) {
    const metadataFields = Object.keys(key.metadata ?? {}).sort().join(",");
    const createdAt = Date.parse(key.metadata?.createdAt);
    const lastUsedAt = key.metadata?.lastUsedAt === undefined ? null : Date.parse(key.metadata.lastUsedAt);
    if (Object.keys(key).some((field) => !candidateFields.has(field))
        || key.provider !== "openai"
        || key.resourceType !== "api-key"
        || !validateOpenAIKeyId(key.resourceId)
        || key.parentResourceId !== scope.id
        || key.observedAt !== normalized.freshness.observedAt
        || key.validUntil !== normalized.freshness.validUntil
        || key.freshness !== "fresh"
        || key.urls.length !== 1
        || key.urls[0].kind !== "console"
        || key.urls[0].url !== "https://platform.openai.com/api-keys"
        || !plainObject(key.metadata)
        || !new Set(["createdAt,ownerId,ownerType", "createdAt,lastUsedAt,ownerId,ownerType"]).has(metadataFields)
        || !new Set(["user", "service_account"]).has(key.metadata.ownerType)
        || typeof key.metadata.ownerId !== "string"
        || !/^[A-Za-z0-9_-]{3,150}$/.test(key.metadata.ownerId)
        || !Number.isFinite(createdAt)
        || (lastUsedAt !== null && !Number.isFinite(lastUsedAt))) {
      fail("invalid-discovery-input", `${label} key candidate is not bounded redacted OpenAI project metadata`);
    }
  }
}

function validatedSetupSession(sessionInput, profileInput, now) {
  let validated;
  try {
    validated = validateSetupSessionArtifact(sessionInput, profileInput, { now });
  } catch (error) {
    fail(error?.code ?? "invalid-discovery-input", error instanceof Error ? error.message : String(error));
  }
  return deepFreeze({
    version: 1,
    completedAt: validated.completedAt,
    status: validated.status,
    results: validated.results.map((result, index) => ({
      profileId: result.profileId,
      connectorId: result.connectorId,
      state: result.state,
      observedAt: result.observedAt,
      freshUntil: result.freshUntil,
      reviewedConnection: { scope: structuredClone(result.profile.scope), owner: result.profile.owner },
      evidenceSource: "validated-setup-session",
      parsed: parseObservations(result.observations, { connectorId: result.connectorId, reviewedScope: result.profile.scope }, `session.results[${index}].observations`),
      message: result.message,
    })),
  });
}

function validatedTaskObservationSession(input, now) {
  if (input === undefined || input === null) return null;
  if (!plainObject(input)) fail("invalid-discovery-input", "task observation document must be an object");
  exactFields(input, new Set(["version", "selectedConnectorIds", "observations"]), "taskObservation");
  if (input.version !== 1 || !Array.isArray(input.selectedConnectorIds) || !Array.isArray(input.observations) || input.observations.length < 1) {
    fail("invalid-discovery-input", "task observation document is invalid");
  }
  const selectedConnectorIds = input.selectedConnectorIds.map((connectorId, index) => stableId(connectorId, `taskObservation.selectedConnectorIds[${index}]`));
  if (new Set(selectedConnectorIds).size !== selectedConnectorIds.length) fail("invalid-discovery-input", "task observation selected sources must be unique");
  const selectedOrder = new Map(selectedConnectorIds.map((connectorId, index) => [connectorId, index]));
  const seen = new Set();
  let priorIndex = -1;
  const results = input.observations.map((observation, index) => {
    const label = `taskObservation.observations[${index}]`;
    if (!plainObject(observation)) fail("invalid-discovery-input", `${label} must be an object`);
    exactFields(observation, new Set([
      "version", "connectorId", "bridgeId", "acquisition", "trust", "observedAt", "validUntil",
      "scope", "resourceCount", "normalizedInventory",
    ]), label);
    const connectorId = stableId(observation.connectorId, `${label}.connectorId`);
    const bridgeId = stableId(observation.bridgeId, `${label}.bridgeId`);
    const order = selectedOrder.get(connectorId);
    if (order === undefined || seen.has(connectorId) || order <= priorIndex) {
      fail("invalid-discovery-input", "task observations must be unique selected sources in canonical order");
    }
    priorIndex = order;
    seen.add(connectorId);
    if (observation.version !== 1
        || observation.acquisition !== "provider-plugin-session"
        || observation.trust !== "untrusted-transient-review-only") {
      fail("invalid-discovery-input", `${label} is not untrusted transient review-only evidence`);
    }
    const observedAt = isoTimestamp(observation.observedAt, `${label}.observedAt`);
    const validUntil = isoTimestamp(observation.validUntil, `${label}.validUntil`);
    if (Date.parse(validUntil) <= now.getTime() || Date.parse(observedAt) > now.getTime() || Date.parse(validUntil) - Date.parse(observedAt) > 5 * 60 * 1_000) {
      fail("stale-setup-artifact", `${label} must be a current task observation with at most five minutes freshness`);
    }
    if (!plainObject(observation.scope)) fail("invalid-discovery-input", `${label}.scope must be an object`);
    exactFields(observation.scope, new Set(["kind", "label"]), `${label}.scope`);
    const scope = {
      kind: stableId(observation.scope.kind, `${label}.scope.kind`),
      label: safeString(observation.scope.label, `${label}.scope.label`, 200),
    };
    let normalized;
    try {
      normalized = validateNormalizedInventoryResult(observation.normalizedInventory);
    } catch (error) {
      fail(error?.code ?? "invalid-discovery-input", error instanceof Error ? error.message : String(error));
    }
    const taskCandidateFields = new Set([
      "provider", "resourceType", "resourceId", "name", "urls", "observedAt", "validUntil", "freshness",
    ]);
    if (normalized.source.provider !== connectorId
        || normalized.source.adapterId !== bridgeId
        || normalized.source.scope.kind !== scope.kind
        || !/^task-scope-[a-f0-9]{24}$/.test(normalized.source.scope.id)
        || normalized.execution.state !== "succeeded"
        || normalized.execution.reason !== "task-plugin-observation"
        || normalized.execution.pagesRead !== 1
        || normalized.freshness.state !== "fresh"
        || normalized.freshness.observedAt !== observedAt
        || normalized.freshness.validUntil !== validUntil
        || !Number.isInteger(observation.resourceCount)
        || observation.resourceCount !== normalized.candidates.length
        || normalized.candidates.some((candidate) => Object.keys(candidate).some((field) => !taskCandidateFields.has(field))
          || candidate.provider !== connectorId
          || candidate.resourceType !== "project"
          || !/^task-resource-[a-f0-9]{24}$/.test(candidate.resourceId)
          || candidate.observedAt !== observedAt
          || candidate.validUntil !== validUntil
          || candidate.freshness !== "fresh"
          || candidate.urls.length !== 0)) {
      fail("invalid-discovery-input", `${label} normalized inventory is not task-local review-only evidence`);
    }
    return {
      profileId: `task-${connectorId}-${digest({ bridgeId, scope }, 12)}`,
      connectorId,
      state: "checked-this-task",
      observedAt,
      freshUntil: validUntil,
      reviewedConnection: { scope },
      evidenceSource: "task-scoped-plugin-observation",
      parsed: [{ kind: "normalized-provider-inventory", normalized }],
      message: `${observation.resourceCount} resources were checked for this task.`,
      trust: "untrusted-transient-review-only",
    };
  });
  return deepFreeze({
    version: 1,
    completedAt: results.map((result) => result.observedAt).sort().at(-1),
    status: "complete",
    results,
  });
}

function validatedLocalDiscoverySession(input, sourceCatalog, now) {
  if (input === undefined || input === null) return null;
  const requestedHostId = plainObject(input?.host) ? input.host.id : null;
  const reviewedHost = sourceCatalog.hosts.find((host) => host.id === requestedHostId);
  if (!reviewedHost) fail("unknown-local-host", "local discovery must name one reviewed catalog host");
  let document;
  try {
    document = validateLocalDiscoveryDocument(input, {
      expectedHost: { id: reviewedHost.id, kind: reviewedHost.kind },
      now,
    });
  } catch (error) {
    fail(error?.code ?? "invalid-local-discovery-document", error instanceof Error ? error.message : String(error));
  }
  const profileId = `local-discovery-${document.host.id}-${digest({ hostId: document.host.id, rootIds: document.scope.rootIds }, 12)}`;
  return deepFreeze({
    version: 1,
    completedAt: document.observedAt,
    status: document.status === "complete" ? "complete" : "review-required",
    results: [{
      profileId,
      connectorId: "local-host",
      state: document.status === "complete" ? "connected" : "unknown",
      observedAt: document.observedAt,
      freshUntil: document.validUntil,
      reviewedConnection: { scope: { hostId: document.host.id, rootIds: structuredClone(document.scope.rootIds) } },
      evidenceSource: "bounded-local-discovery",
      parsed: document.candidates.map((candidate) => ({ kind: candidate.kind, candidate: structuredClone(candidate) })),
      message: document.status === "complete"
        ? `${document.candidates.length} bounded local review candidates were observed.`
        : `The bounded local discovery did not return current candidate evidence (${document.reason}).`,
      discoveryBounds: structuredClone(document.limits),
    }],
  });
}

function validateCatalog(sourceCatalog) {
  if (!plainObject(sourceCatalog) || !Array.isArray(sourceCatalog.projects) || !Array.isArray(sourceCatalog.hosts) || !(sourceCatalog.hostIds instanceof Set)) fail("invalid-catalog", "source catalog must be a validated source catalog");
  const projects = new Map();
  for (const entry of sourceCatalog.projects) {
    const manifest = entry?.manifest;
    if (!plainObject(manifest) || typeof manifest.id !== "string" || !stableIdPattern.test(manifest.id) || !Array.isArray(manifest.services)) fail("invalid-catalog", "source catalog contains an invalid project entry");
    if (projects.has(manifest.id)) fail("invalid-catalog", `source catalog duplicates project ${manifest.id}`);
    projects.set(manifest.id, manifest);
  }
  return projects;
}

function catalogRepository(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\.git$/i, "");
  if (/^[^/\s]+\/[^/\s]+$/.test(trimmed)) return trimmed.toLowerCase();
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.search || url.hash) return null;
    const parts = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").split("/");
    return parts.length === 2 && parts.every(Boolean) ? parts.join("/").toLowerCase() : null;
  } catch {
    return null;
  }
}

function normalizedName(value) {
  if (typeof value !== "string") return null;
  return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "") || null;
}

function catalogTargets(sourceCatalog, candidate) {
  const matches = [];
  for (const { manifest: project } of sourceCatalog.projects) {
    const observedRepository = candidate.repository ? `${candidate.repository.owner}/${candidate.repository.name}`.toLowerCase() : null;
    if (observedRepository && catalogRepository(project.repository) === observedRepository) matches.push({ projectId: project.id, serviceId: null, signal: "repository" });
    for (const service of project.services) {
      if (observedRepository && (service.links ?? []).some((link) => link.type === "repository" && catalogRepository(link.url) === observedRepository)) {
        matches.push({ projectId: project.id, serviceId: service.id, signal: "repository" });
      }
    }
    if (normalizedName(candidate.name) && [project.id, project.title, ...(project.aliases ?? [])].map(normalizedName).includes(normalizedName(candidate.name))) {
      matches.push({ projectId: project.id, serviceId: null, signal: "name" });
    }
  }
  return [...new Map(matches.map((match) => [`${match.projectId}\u0000${match.serviceId ?? ""}\u0000${match.signal}`, match])).values()]
    .sort((left, right) => left.projectId.localeCompare(right.projectId) || (left.serviceId ?? "").localeCompare(right.serviceId ?? "") || left.signal.localeCompare(right.signal));
}

function identity(profileId, provider, resourceType, resourceId) {
  const base = { profileId, provider, resourceType, resourceId };
  return { ...base, candidateId: `candidate-${digest(base, 20)}` };
}

function provenance(result, uncertainty, candidate = null) {
  return {
    source: result.evidenceSource,
    profileId: result.profileId,
    connectorId: result.connectorId,
    scope: structuredClone(result.reviewedConnection.scope),
    observedAt: candidate?.observedAt ?? result.observedAt,
    validUntil: candidate?.validUntil ?? result.freshUntil,
    freshness: resultIsCurrent(result) ? "fresh" : result.state === "stale" ? "stale" : "unknown",
    uncertainty,
    ...(result.trust ? { trust: result.trust } : {}),
    ...(result.discoveryBounds ? {
      bounds: structuredClone(result.discoveryBounds),
      completeness: result.discoveryBounds.depthLimited || result.discoveryBounds.symlinksSkipped
        ? "bounded-partial"
        : "bounded-complete",
    } : {}),
  };
}

function resultIsCurrent(result) {
  return result.state === "connected" || result.state === "checked-this-task";
}

function baseItem({ itemIdentity, state, candidate, matches = [], exactMatch = null, result, uncertainty, reason, inventory = null }) {
  return {
    candidateId: itemIdentity.candidateId,
    identity: { profileId: itemIdentity.profileId, provider: itemIdentity.provider, resourceType: itemIdentity.resourceType, resourceId: itemIdentity.resourceId },
    state,
    candidate,
    exactMatch,
    possibleMatches: matches,
    provenance: provenance(result, uncertainty, candidate),
    reason,
    reviewRequired: new Set(["possible-match", "new"]).has(state),
    reviewedDecision: null,
    proposal: null,
    ...(inventory ? { inventory } : {}),
  };
}

function repositoryIdentityKey(repository) {
  if (!repository || repository.provider !== "github" || typeof repository.owner !== "string" || typeof repository.name !== "string") return null;
  return `${repository.owner.toLowerCase()}/${repository.name.toLowerCase().replace(/\.git$/i, "")}`;
}

function localCandidateMatches(sourceCatalog, candidate, hostId) {
  const matches = new Map();
  const add = (projectId, serviceId, signal) => {
    const key = `${projectId}\0${serviceId ?? ""}\0${signal}`;
    if (!matches.has(key)) matches.set(key, { projectId, serviceId: serviceId ?? null, signal });
  };
  if (candidate.resourceType === "project") {
    for (const { manifest: project } of sourceCatalog.projects) {
      if ((project.workspaces ?? []).some((workspace) => workspace.host === hostId
          && localWorkspaceId(hostId, path.resolve(workspace.path)) === candidate.workspaceId)) {
        add(project.id, null, "reviewed-workspace");
      }
      if (candidate.manifestId === project.id) add(project.id, null, "manifest-id");
    }
    for (const match of catalogTargets(sourceCatalog, candidate)) add(match.projectId, match.serviceId, match.signal);
  } else {
    const parentProjects = new Set();
    if (candidate.parentResourceId) {
      for (const { manifest: project } of sourceCatalog.projects) {
        if ((project.workspaces ?? []).some((workspace) => workspace.host === hostId
            && localWorkspaceId(hostId, path.resolve(workspace.path)) === candidate.parentResourceId)) parentProjects.add(project.id);
      }
    }
    for (const { manifest: project } of sourceCatalog.projects) {
      if (parentProjects.size && !parentProjects.has(project.id)) continue;
      for (const service of project.services) {
        if (candidate.declaredServiceId && candidate.declaredServiceId === service.id) {
          add(project.id, service.id, parentProjects.has(project.id) ? "declared-service-id" : "service-id");
        }
        const candidateName = normalizedName(candidate.name);
        if (candidateName && [service.id, service.name, service.runtimeIdentifier].map(normalizedName).filter(Boolean).includes(candidateName)) {
          add(project.id, service.id, "service-name");
        }
      }
    }
  }
  return [...matches.values()].sort((left, right) => left.projectId.localeCompare(right.projectId)
    || (left.serviceId ?? "").localeCompare(right.serviceId ?? "") || left.signal.localeCompare(right.signal));
}

function classifyLocalCandidate(sourceCatalog, result, candidate) {
  const matches = localCandidateMatches(sourceCatalog, candidate, result.reviewedConnection.scope.hostId);
  const exactSignals = candidate.resourceType === "project"
    ? new Set(["reviewed-workspace", "repository"])
    : new Set(["declared-service-id"]);
  const exactTargets = new Map(matches.filter((match) => exactSignals.has(match.signal))
    .map((match) => [`${match.projectId}\0${match.serviceId ?? ""}`, match]));
  const exact = exactTargets.size === 1 ? [...exactTargets.values()][0] : null;
  const itemIdentity = identity(result.profileId, "local-host", candidate.resourceType, candidate.resourceId);
  if (exact) {
    return baseItem({
      itemIdentity,
      state: "exact-match",
      candidate,
      exactMatch: { projectId: exact.projectId, serviceId: exact.serviceId, tier: `exact-${exact.signal}` },
      result,
      uncertainty: result.discoveryBounds.depthLimited || result.discoveryBounds.symlinksSkipped ? "bounded-scan-incomplete" : "none",
      reason: "The bounded local candidate matches one exact reviewed catalog identity.",
    });
  }
  const targetMatches = [...new Map(matches.map((match) => [`${match.projectId}\0${match.serviceId ?? ""}`, match])).values()];
  const state = targetMatches.length ? "possible-match" : "new";
  return baseItem({
    itemIdentity,
    state,
    candidate,
    matches: targetMatches,
    result,
    uncertainty: targetMatches.length > 1 ? "ambiguous"
      : state === "possible-match" ? "supporting-evidence-only"
        : result.discoveryBounds.depthLimited || result.discoveryBounds.symlinksSkipped ? "bounded-scan-incomplete" : "unreviewed-product-identity",
    reason: state === "possible-match"
      ? "Allowlisted local metadata provides supporting catalog evidence, but review is required before binding."
      : "No reviewed workspace, repository, manifest or service identity matches this bounded local candidate.",
  });
}

function applyLocalRepositorySuggestions(sourceCatalog, items, evidence) {
  if (!evidence.length) return items;
  return items.map((item) => {
    if (item.identity.provider !== "github" || !new Set(["exact-match", "new", "possible-match"]).has(item.state) || item.provenance.freshness !== "fresh") return item;
    const candidateRepository = repositoryIdentityKey(item.candidate?.repository);
    if (!candidateRepository) return item;
    const localTargets = evidence.flatMap((entry) => {
      if (entry.state !== "connected" || repositoryIdentityKey(entry.repository) !== candidateRepository) return [];
      const project = sourceCatalog.projects.find(({ manifest }) => manifest.id === entry.projectId)?.manifest;
      if (!project || !(project.workspaces ?? []).some((workspace) => workspace.host === entry.hostId)) return [];
      return [{ projectId: project.id, serviceId: null, signal: "artifact-reviewed-workspace-repository", hostId: entry.hostId }];
    });
    if (!localTargets.length) return item;
    if (item.state === "exact-match" && localTargets.every((match) => match.projectId === item.exactMatch?.projectId)) return item;
    const startingMatches = item.state === "exact-match"
      ? [{ projectId: item.exactMatch.projectId, serviceId: item.exactMatch.serviceId, signal: "reviewed-catalog-repository" }]
      : item.possibleMatches;
    const matches = new Map(startingMatches.map((match) => [`${match.projectId}\u0000${match.serviceId ?? ""}`, match]));
    for (const match of localTargets) {
      const key = `${match.projectId}\u0000${match.serviceId ?? ""}`;
      if (!matches.has(key)) matches.set(key, match);
    }
    const possibleMatches = [...matches.values()].sort((left, right) => left.projectId.localeCompare(right.projectId) || (left.serviceId ?? "").localeCompare(right.serviceId ?? ""));
    return {
      ...item,
      state: "possible-match",
      exactMatch: null,
      possibleMatches,
      provenance: { ...item.provenance, uncertainty: possibleMatches.length > 1 ? "ambiguous" : "supporting-evidence-only" },
      reason: item.state === "exact-match"
        ? "Reviewed catalog repository identity and artifact-bound local workspace evidence point to different projects; review is required before catalog binding."
        : "A canonical GitHub repository identity from this artifact agrees with a reviewed local project workspace; review is required before catalog binding.",
      reviewRequired: true,
    };
  });
}

function collectBaseItems(sourceCatalog, session) {
  const items = [];
  const localRepositoryEvidence = [];
  for (const result of session.results) {
    if (!resultIsCurrent(result) && result.parsed.length === 0) {
      const itemIdentity = identity(result.profileId, result.connectorId, "scope", result.profileId);
      items.push(baseItem({ itemIdentity, state: "unknown", candidate: null, result, uncertainty: result.state, reason: result.message ?? "This reviewed connection did not produce current evidence." }));
      continue;
    }
    for (const parsed of result.parsed) {
      if (parsed.kind === "project-repository") {
        localRepositoryEvidence.push({ ...parsed.evidence, state: result.state });
      } else if (parsed.kind === "normalized-provider-inventory") {
        const review = reconcileProviderInventory(sourceCatalog, parsed.normalized);
        for (const reviewed of review.items) {
          const itemIdentity = identity(result.profileId, reviewed.identity.provider, reviewed.identity.resourceType, reviewed.identity.resourceId);
          const taskScoped = result.trust === "untrusted-transient-review-only";
          const classified = reviewed.status === "matched" ? "exact-match" : reviewed.status === "possible-match" ? "possible-match" : reviewed.status === "unregistered" ? "new" : reviewed.status === "reviewed-external" ? "reviewed-external" : "unknown";
          const state = taskScoped && new Set(["exact-match", "reviewed-external"]).has(classified) ? "possible-match" : classified;
          const exactMatch = taskScoped ? null : reviewed.catalogMatch;
          const matches = taskScoped && reviewed.catalogMatch
            ? [{ ...reviewed.catalogMatch, signal: "task-observation-supporting-evidence" }]
            : reviewed.possibleMatches;
          items.push(baseItem({ itemIdentity, state: resultIsCurrent(result) ? state : "unknown", candidate: reviewed.candidate ? structuredClone(reviewed.candidate) : null, matches, exactMatch, result, uncertainty: taskScoped ? (matches.length > 1 ? "ambiguous" : "supporting-evidence-only") : reviewed.status === "matched" ? "none" : reviewed.status === "possible-match" ? (reviewed.ambiguous ? "ambiguous" : "supporting-evidence-only") : reviewed.status, reason: taskScoped ? (matches.length ? "Task-scoped provider evidence suggests a possible catalog relationship; review is required." : "This task-scoped provider resource is a review-only candidate and has not been saved.") : reviewed.reason, inventory: parsed.normalized }));
        }
      } else if (parsed.kind === "repository-candidate") {
        const candidate = parsed.candidate;
        const itemIdentity = identity(result.profileId, candidate.provider, candidate.resourceType, candidate.resourceId);
        const matches = catalogTargets(sourceCatalog, candidate);
        const repositoryMatches = matches.filter((match) => match.signal === "repository");
        const exactMatch = repositoryMatches.length === 1 ? { projectId: repositoryMatches[0].projectId, serviceId: repositoryMatches[0].serviceId, tier: "exact-reviewed-repository" } : null;
        const state = result.state !== "connected" ? "unknown" : exactMatch ? "exact-match" : matches.length ? "possible-match" : "new";
        items.push(baseItem({ itemIdentity, state, candidate, matches: exactMatch ? [] : matches, exactMatch, result, uncertainty: state === "exact-match" ? "none" : matches.length > 1 ? "ambiguous" : state === "possible-match" ? "supporting-evidence-only" : "unreviewed-product-identity", reason: state === "exact-match" ? "The provider repository identity matches one reviewed catalog repository exactly." : state === "possible-match" ? "Supporting name or duplicate repository evidence requires review." : state === "new" ? "No reviewed catalog repository or product identity matches this repository." : "The repository observation is not current." }));
      } else if (new Set(["local-project-candidate", "local-service-candidate"]).has(parsed.kind)) {
        items.push(classifyLocalCandidate(sourceCatalog, result, parsed.candidate));
      } else {
        const candidate = parsed.candidate;
        const itemIdentity = identity(result.profileId, candidate.provider, candidate.resourceType, candidate.resourceId);
        const project = sourceCatalog.projects.find(({ manifest }) => manifest.id === candidate.projectId)?.manifest;
        const service = project?.services.find((entry) => entry.id === candidate.serviceId);
        const scopedHost = result.reviewedConnection.scope.hostId;
        const exact = Boolean(project && service && service.host === scopedHost);
        items.push(baseItem({ itemIdentity, state: exact && result.state === "connected" ? "exact-match" : "unknown", candidate, exactMatch: exact ? { projectId: project.id, serviceId: service.id, tier: "exact-reviewed-service-host" } : null, result, uncertainty: exact ? (candidate.uncertain ? candidate.reason ?? "runtime-state-unknown" : "none") : candidate.reason ?? "runtime-unknown", reason: exact ? (candidate.uncertain ? "The reviewed service identity is exact, while its current runtime state remains unknown." : "One-shot inspection matched this exact reviewed project, service and host identity.") : candidate.message ?? "Local runtime evidence is unknown." }));
      }
    }
  }
  return applyLocalRepositorySuggestions(sourceCatalog, items, localRepositoryEvidence)
    .sort((left, right) => left.candidateId.localeCompare(right.candidateId));
}

function artifactId(items) {
  const material = items.map((item) => {
    const artifactProvenance = item.provenance.source === "bounded-local-discovery"
      ? { ...item.provenance, observedAt: null, validUntil: null }
      : item.provenance;
    return { candidateId: item.candidateId, identity: item.identity, state: item.state, candidate: item.candidate, exactMatch: item.exactMatch, possibleMatches: item.possibleMatches, provenance: artifactProvenance, reason: item.reason };
  });
  return `sha256:${digest(material, 64)}`;
}

export function parseDiscoveryReviewDocument(value, expectedArtifactId = null) {
  if (value === undefined || value === null) return { version: 1, artifactId: expectedArtifactId, decisions: [] };
  if (!plainObject(value)) fail("invalid-discovery-review", "review document must be an object");
  exactFields(value, new Set(["version", "artifactId", "decisions"]), "review", "invalid-discovery-review");
  if (value.version !== 1) fail("invalid-discovery-review", "review.version must be 1");
  const reviewedArtifactId = safeString(value.artifactId, "review.artifactId", 80);
  if (!/^sha256:[a-f0-9]{64}$/.test(reviewedArtifactId)) fail("invalid-discovery-review", "review.artifactId must be a Discovery Inbox SHA-256 identifier");
  if (expectedArtifactId && reviewedArtifactId !== expectedArtifactId) fail("stale-discovery-review", "review.artifactId does not match this Discovery Inbox artifact");
  if (!Array.isArray(value.decisions) || value.decisions.length > 1_000) fail("invalid-discovery-review", "review.decisions must contain at most 1000 items");
  const seen = new Set();
  const decisions = value.decisions.map((decision, index) => {
    const label = `review.decisions[${index}]`;
    if (!plainObject(decision)) fail("invalid-discovery-review", `${label} must be an object`);
    exactFields(decision, new Set(["candidateId", "reviewedAt", "reviewedBy", "disposition", "projectId", "serviceId", "reason", "answers"]), label, "invalid-discovery-review");
    const candidateId = safeString(decision.candidateId, `${label}.candidateId`, 100);
    if (!/^candidate-[a-f0-9]{20}$/.test(candidateId) || seen.has(candidateId)) fail("invalid-discovery-review", `${label}.candidateId is invalid or duplicated`);
    seen.add(candidateId);
    if (!reviewDispositions.has(decision.disposition)) fail("invalid-discovery-review", `${label}.disposition is invalid`);
    const parsed = { candidateId, reviewedAt: isoTimestamp(decision.reviewedAt, `${label}.reviewedAt`), reviewedBy: safeString(decision.reviewedBy, `${label}.reviewedBy`, 200), disposition: decision.disposition };
    if (decision.disposition === "catalog") {
      parsed.projectId = stableId(decision.projectId, `${label}.projectId`);
      if (decision.serviceId !== undefined) parsed.serviceId = stableId(decision.serviceId, `${label}.serviceId`);
      if (decision.reason !== undefined) parsed.reason = safeString(decision.reason, `${label}.reason`, 500);
    } else if (decision.disposition === "external" || decision.disposition === "ignore") {
      if (decision.projectId !== undefined || decision.serviceId !== undefined) fail("invalid-discovery-review", `${label} must not name a catalog target`);
      parsed.reason = safeString(decision.reason, `${label}.reason`, 500);
    } else if (decision.projectId !== undefined || decision.serviceId !== undefined || decision.reason !== undefined) {
      fail("invalid-discovery-review", `${label} new decisions use reviewed answers rather than a catalog target or reason`);
    }
    if (decision.answers !== undefined) {
      if (!plainObject(decision.answers)) fail("invalid-discovery-review", `${label}.answers must be an object`);
      exactFields(decision.answers, answerFields, `${label}.answers`, "invalid-discovery-review");
      parsed.answers = Object.fromEntries(Object.entries(decision.answers).sort().map(([key, answer]) => [key, safeString(answer, `${label}.answers.${key}`, 300)]));
    }
    return parsed;
  });
  return deepFreeze({ version: 1, artifactId: reviewedArtifactId, decisions });
}

function requireCatalogTarget(projects, decision) {
  const project = projects.get(decision.projectId);
  if (!project) fail("invalid-discovery-review", `reviewed catalog project does not exist: ${decision.projectId}`);
  if (decision.serviceId && !project.services.some((service) => service.id === decision.serviceId)) fail("invalid-discovery-review", `reviewed catalog service does not exist: ${decision.projectId}/${decision.serviceId}`);
}

function syntheticInventory(item) {
  const candidate = item.candidate;
  return validateNormalizedInventoryResult({
    formatVersion: 1,
    source: { adapterId: `${item.identity.provider}-setup-inventory-v1`, provider: item.identity.provider, scope: { kind: "account", id: item.identity.profileId } },
    execution: { state: "succeeded", reason: "adapter-observation", pagesRead: 1 },
    freshness: { state: "fresh", observedAt: item.provenance.observedAt, validUntil: item.provenance.validUntil, evaluatedAt: item.provenance.observedAt },
    candidates: [{ provider: candidate.provider, resourceType: "project", resourceId: candidate.resourceId, name: candidate.name, urls: [], repository: candidate.repository, observedAt: item.provenance.observedAt, validUntil: item.provenance.validUntil, freshness: "fresh" }],
  });
}

function applyDecision(sourceCatalog, projects, item, decision, options) {
  if (!decision) return item;
  if (item.state === "unknown" || item.provenance.freshness !== "fresh") fail("unsafe-discovery-review", `candidate ${item.candidateId} is unknown or stale and cannot be unlocked by review`);
  const earliestReview = item.provenance.source === "bounded-local-discovery"
    ? 0
    : Math.max(Date.parse(options.completedAt), Date.parse(item.provenance.observedAt ?? options.completedAt));
  if (Date.parse(decision.reviewedAt) < earliestReview || Date.parse(decision.reviewedAt) > options.now.getTime()) {
    const message = item.provenance.source === "bounded-local-discovery"
      ? `candidate ${item.candidateId} review time must not be in the future`
      : `candidate ${item.candidateId} must be reviewed after observation/session completion and not in the future`;
    fail("invalid-discovery-review-time", message);
  }
  const reviewedDecision = { source: "reviewed-discovery-decision", artifactId: options.artifactId, candidateId: item.candidateId, reviewedAt: decision.reviewedAt, reviewedBy: decision.reviewedBy, disposition: decision.disposition, ...(decision.projectId ? { projectId: decision.projectId } : {}), ...(decision.serviceId ? { serviceId: decision.serviceId } : {}), ...(decision.reason ? { reason: decision.reason } : {}), ...(decision.answers ? { answers: decision.answers } : {}) };
  if (decision.disposition === "ignore") return { ...item, state: "ignored", reviewRequired: false, reviewedDecision, proposal: null, reason: `This exact candidate was explicitly ignored: ${decision.reason}` };
  if (decision.disposition === "external") return { ...item, state: "reviewed-external", reviewRequired: false, reviewedDecision, proposal: null, reason: `This exact candidate is intentionally outside the DevHub catalog: ${decision.reason}` };
  if (decision.disposition === "catalog") {
    requireCatalogTarget(projects, decision);
    const compatible = item.exactMatch?.projectId === decision.projectId
      && (decision.serviceId === undefined || item.exactMatch.serviceId === decision.serviceId)
      || item.possibleMatches.some((match) => match.projectId === decision.projectId && (decision.serviceId === undefined || match.serviceId === decision.serviceId));
    if (!compatible && (!decision.reason || !decision.answers?.productIdentity)) fail("incompatible-discovery-match", `candidate ${item.candidateId} requires an explicit override reason and productIdentity answer to bind an unrelated catalog target`);
    if (item.provenance.trust === "untrusted-transient-review-only") {
      const selectedMatch = {
        projectId: decision.projectId,
        serviceId: decision.serviceId ?? null,
        signal: "reviewed-task-observation",
      };
      return {
        ...item,
        state: "possible-match",
        exactMatch: null,
        possibleMatches: [selectedMatch],
        reviewRequired: false,
        reviewedDecision,
        proposal: null,
        reason: "A reviewer confirmed the likely catalog relationship, but task-only evidence cannot establish a durable exact provider identity.",
      };
    }
    return { ...item, state: "exact-match", exactMatch: { projectId: decision.projectId, serviceId: decision.serviceId ?? null, tier: "exact-reviewed-discovery-decision" }, possibleMatches: [], reviewRequired: false, reviewedDecision, proposal: null, reason: "This exact candidate is bound to an explicit reviewed catalog identity." };
  }
  if (!decision.answers?.productIdentity || !decision.answers?.operatingIntent) fail("incomplete-discovery-review", `candidate ${item.candidateId} requires productIdentity and operatingIntent answers before a new overlay proposal`);
  if (item.identity.resourceType !== "project" && item.identity.resourceType !== "repository") fail("unsupported-discovery-proposal", `candidate ${item.candidateId} cannot create an overlay project proposal`);
  const normalized = item.inventory ?? syntheticInventory(item);
  const resourceIdentity = item.inventory ? { resourceType: item.identity.resourceType, resourceId: item.identity.resourceId } : { resourceType: "project", resourceId: item.identity.resourceId };
  const proposal = createReviewedProviderOverlayProposal(sourceCatalog, normalized, resourceIdentity, { projectDirectory: options.projectDirectory });
  return { ...item, state: "new", reviewRequired: false, reviewedDecision, proposal, reason: "A reviewer explicitly confirmed that this fresh candidate represents a new DevHub project." };
}

function questionsFor(item) {
  if (item.state === "ignored" || item.state === "reviewed-external" || item.state === "unknown") return [];
  const types = [];
  if (item.state === "possible-match" || item.state === "new") types.push("product-identity");
  if (item.candidate?.environment === undefined && !new Set(["repository", "project"]).has(item.identity.resourceType)) types.push("environment");
  if (item.state === "possible-match" || item.state === "new") types.push("owner", "payer", "operating-intent");
  const prompts = {
    "product-identity": "Which reviewed product does this resource belong to?",
    environment: "Is this production, staging, preview, local, or another environment?",
    owner: "Who is accountable for this resource?",
    payer: "Who owns the bill or usage budget for this resource?",
    "operating-intent": "Should DevHub track this as active, discovery, paused, archived, external, or ignored?",
  };
  const answers = item.reviewedDecision?.answers ?? {};
  const answerKeys = { "product-identity": "productIdentity", environment: "environment", owner: "owner", payer: "payer", "operating-intent": "operatingIntent" };
  return types.map((type) => {
    const selectedDisposition = item.reviewedDecision?.disposition ?? null;
    const afterTriage = type === "product-identity";
    const required = selectedDisposition === null
      ? type === "operating-intent"
      : afterTriage && new Set(["catalog", "new"]).has(selectedDisposition);
    const answer = type === "product-identity" && selectedDisposition === "catalog"
      ? item.reviewedDecision.projectId
      : answers[answerKeys[type]] ?? null;
    return {
      id: `question-${digest({ candidateId: item.candidateId, type }, 20)}`,
      candidateId: item.candidateId,
      type,
      phase: afterTriage ? "after-triage" : type === "operating-intent" ? "triage" : "optional-context",
      prompt: prompts[type],
      required,
      actionable: !afterTriage || selectedDisposition !== null,
      answer,
      evidence: { source: item.provenance.source, observedAt: item.provenance.observedAt, validUntil: item.provenance.validUntil, freshness: item.provenance.freshness, uncertainty: item.provenance.uncertainty },
    };
  });
}

function candidateLabel(item) {
  return item.candidate?.fullName
    ?? item.candidate?.name
    ?? item.candidate?.serviceName
    ?? `${item.identity.resourceType}/${item.identity.resourceId}`;
}

function range(values) {
  const sorted = [...new Set(values.filter(Boolean))].sort();
  return sorted.length ? { earliest: sorted[0], latest: sorted.at(-1) } : { earliest: null, latest: null };
}

function groupEvidence(items) {
  return {
    sources: [...new Set(items.map((item) => item.provenance.source))].sort(),
    observedAt: range(items.map((item) => item.provenance.observedAt)),
    validUntil: range(items.map((item) => item.provenance.validUntil)),
    freshness: [...new Set(items.map((item) => item.provenance.freshness))].sort(),
    uncertainties: [...new Set(items.map((item) => item.provenance.uncertainty))].sort(),
  };
}

function questionGroupsFor(items, questions) {
  const itemByCandidate = new Map(items.map((item) => [item.candidateId, item]));
  const pending = questions.filter((question) => question.required && question.actionable && question.answer === null);
  const buckets = new Map();
  for (const question of pending) {
    const item = itemByCandidate.get(question.candidateId);
    if (!item) continue;
    const key = `${question.type}\u0000${item.identity.profileId}\u0000${item.identity.provider}\u0000${item.identity.resourceType}\u0000${item.state}`;
    const bucket = buckets.get(key) ?? { type: question.type, profileId: item.identity.profileId, provider: item.identity.provider, resourceType: item.identity.resourceType, state: item.state, prompt: question.prompt, items: [] };
    bucket.items.push(item);
    buckets.set(key, bucket);
  }
  const groups = [];
  for (const bucket of [...buckets.values()].sort((left, right) => `${left.type}\u0000${left.profileId}\u0000${left.provider}\u0000${left.state}`.localeCompare(`${right.type}\u0000${right.profileId}\u0000${right.provider}\u0000${right.state}`))) {
    const sorted = bucket.items.sort((left, right) => left.candidateId.localeCompare(right.candidateId));
    for (let offset = 0; offset < sorted.length; offset += questionGroupSize) {
      const chunk = sorted.slice(offset, offset + questionGroupSize);
      const candidateIds = chunk.map((item) => item.candidateId);
      const choices = bucket.type === "operating-intent"
        ? [
            { id: "catalog", label: "Map to existing product", followUp: ["product-identity"] },
            ...(new Set(["project", "repository"]).has(bucket.resourceType)
              ? [{ id: "new", label: "Create a DevHub project", followUp: ["product-identity"] }]
              : []),
            { id: "external", label: "Keep outside DevHub", followUp: ["reason"] },
            { id: "ignore", label: "Ignore intentionally", followUp: ["reason"] },
          ]
        : [];
      groups.push({
        id: `question-group-${digest({ type: bucket.type, profileId: bucket.profileId, provider: bucket.provider, state: bucket.state, candidateIds }, 20)}`,
        type: bucket.type,
        phase: "triage",
        prompt: bucket.type === "operating-intent"
          ? `Choose what DevHub should do with each of these ${chunk.length} ${bucket.provider} ${bucket.state} resources.`
          : bucket.prompt,
        required: true,
        answerMode: "per-candidate",
        profileId: bucket.profileId,
        provider: bucket.provider,
        state: bucket.state,
        candidateCount: chunk.length,
        candidateIds,
        candidates: chunk.map((item) => ({ candidateId: item.candidateId, label: candidateLabel(item), state: item.state })),
        choices,
        evidence: groupEvidence(chunk),
      });
    }
  }
  return groups;
}

function summary(items, questions, questionGroups) {
  const unansweredCandidateQuestions = questions.filter((question) => question.required && question.answer === null).length;
  return {
    items: items.length,
    states: Object.fromEntries([...candidateStates].map((state) => [state, items.filter((item) => item.state === state).length])),
    questions: questionGroups.length,
    candidateQuestions: questions.length,
    unansweredRequiredQuestions: questionGroups.filter((group) => group.required).length,
    unansweredRequiredCandidateQuestions: unansweredCandidateQuestions,
    proposals: items.filter((item) => item.proposal).length,
  };
}

export function buildDiscoveryInbox(sourceCatalog, setupSessionInput, profileInput, reviewInput = null, options = {}) {
  const projects = validateCatalog(sourceCatalog);
  const now = new Date(options.now ?? Date.now());
  if (!Number.isFinite(now.getTime())) fail("invalid-now", "Discovery Inbox requires a valid now value");
  const setupSession = setupSessionInput === undefined || setupSessionInput === null
    ? null
    : validatedSetupSession(setupSessionInput, profileInput, now);
  const taskSession = validatedTaskObservationSession(options.taskObservationDocument ?? null, now);
  const localSession = validatedLocalDiscoverySession(options.localDiscoveryDocument ?? null, sourceCatalog, now);
  if (!setupSession && !taskSession && !localSession) fail("invalid-discovery-input", "Discovery Inbox requires a setup session, task observation or local discovery artifact");
  const completedAt = [setupSession?.completedAt, taskSession?.completedAt, localSession?.completedAt].filter(Boolean).sort().at(-1);
  const session = deepFreeze({
    version: 1,
    completedAt,
    status: setupSession?.status === "review-required" || localSession?.status === "review-required" ? "review-required" : "complete",
    results: [...(setupSession?.results ?? []), ...(taskSession?.results ?? []), ...(localSession?.results ?? [])],
  });
  const baseItems = collectBaseItems(sourceCatalog, session);
  const id = artifactId(baseItems);
  const review = parseDiscoveryReviewDocument(reviewInput, id);
  const decisions = new Map(review.decisions.map((decision) => [decision.candidateId, decision]));
  for (const decision of review.decisions) if (!baseItems.some((item) => item.candidateId === decision.candidateId)) fail("stale-discovery-review", `review decision references a candidate outside artifact ${id}: ${decision.candidateId}`);
  const items = baseItems.map((item) => applyDecision(sourceCatalog, projects, item, decisions.get(item.candidateId), { artifactId: id, completedAt: session.completedAt, now, projectDirectory: options.projectDirectory ?? null }));
  const questions = items.flatMap(questionsFor).sort((left, right) => left.id.localeCompare(right.id));
  const questionGroups = questionGroupsFor(items, questions);
  const proposals = items.filter((item) => item.proposal).map((item) => ({ candidateId: item.candidateId, transport: "stdout", writes: false, reviewDestination: item.proposal.reviewDestination, manifest: item.proposal.manifest, yaml: item.proposal.yaml }));
  const generatedFrom = setupSession && taskSession && localSession ? "validated-setup-session-task-observations-and-local-discovery"
    : setupSession && taskSession ? "validated-setup-session-and-task-observations"
      : setupSession && localSession ? "validated-setup-session-and-local-discovery"
        : taskSession && localSession ? "validated-task-observations-and-local-discovery"
          : taskSession ? "validated-task-observations"
            : localSession ? "validated-local-discovery"
              : "validated-setup-session";
  const result = { version: 1, command: "discovery-inbox", artifactId: id, readOnly: true, persistent: false, catalogWrites: false, dashboardMutation: false, generatedFrom, summary: summary(items, questions, questionGroups), items, questions, questionGroups, proposals };
  safeValue(result, "discoveryInbox");
  return deepFreeze(result);
}
