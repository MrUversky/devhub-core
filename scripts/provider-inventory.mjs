import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { stringify } from "yaml";

import { validateConnectorInventoryExecution } from "../lib/connector-conformance.mjs";
import { CONNECTOR_CONTRACTS } from "../lib/connector-contracts.mjs";
import {
  runInventoryAdapter,
  validateNormalizedInventoryResult,
} from "../lib/inventory-adapters.mjs";
import { inventoryAdapterRegistry } from "../lib/inventory-adapters/registry.mjs";
import { validateProjectDocument } from "./catalog-validation.mjs";
import { createCredentialResolver } from "./setup-session.mjs";

const MAX_DOCUMENT_BYTES = 256 * 1024;
const stableIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const secretNamePattern = /^(?:api[-_]?key|access[-_]?token|auth(?:orization)?|client[-_]?secret|password|passwd|secret|signature|token)$/i;
const secretAssignmentPattern = /\b(?:api[-_]?key|access[-_]?token|client[-_]?secret|password|passwd|secret|token)\s*[:=]\s*["']?(?!\$|\$\{|<|example\b|redacted\b)[A-Za-z0-9_./+=-]{8,}/i;
const documentFields = new Set(["version", "binding", "decisions"]);
const decisionFields = new Set([
  "resourceType",
  "resourceId",
  "disposition",
  "projectId",
  "serviceId",
  "note",
]);
const dispositions = new Set(["catalog", "external"]);
const statusOrder = Object.freeze({ matched: 0, "possible-match": 1, unregistered: 2, "reviewed-external": 3, unknown: 4 });

export class ProviderInventoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProviderInventoryError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProviderInventoryError(code, message);
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactFields(value, fields, label) {
  for (const field of Object.keys(value)) {
    if (!fields.has(field)) fail("invalid-inventory-document", `${label}.${field} is not supported`);
  }
}

function requiredString(value, label, maximum = 300) {
  if (typeof value !== "string" || !value.trim()) fail("invalid-inventory-document", `${label} must be a non-empty string`);
  if (value.length > maximum) fail("invalid-inventory-document", `${label} must contain at most ${maximum} characters`);
  return value.trim();
}

function safeNote(value, label) {
  const note = requiredString(value, label, 500);
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(note) || secretAssignmentPattern.test(note)) {
    fail("unsafe-inventory-decision", `${label} must not contain secret material`);
  }
  const urls = note.match(/https?:\/\/[^\s"']+/gi) ?? [];
  for (const candidate of urls) {
    let parsed;
    try {
      parsed = new URL(candidate);
    } catch {
      continue;
    }
    if (parsed.username || parsed.password || [...parsed.searchParams.keys()].some((key) => secretNamePattern.test(key))) {
      fail("unsafe-inventory-decision", `${label} must not contain a credential or secret-bearing URL`);
    }
  }
  return note;
}

function stableId(value, label) {
  const id = requiredString(value, label, 100);
  if (!stableIdPattern.test(id)) fail("invalid-inventory-document", `${label} must use lowercase kebab-case`);
  return id;
}

function parseDecision(value, index) {
  const label = `decisions[${index}]`;
  if (!plainObject(value)) fail("invalid-inventory-document", `${label} must be an object`);
  exactFields(value, decisionFields, label);
  const disposition = requiredString(value.disposition, `${label}.disposition`, 30);
  if (!dispositions.has(disposition)) fail("invalid-inventory-document", `${label}.disposition must be catalog or external`);
  const decision = {
    resourceType: requiredString(value.resourceType, `${label}.resourceType`, 100),
    resourceId: requiredString(value.resourceId, `${label}.resourceId`, 300),
    disposition,
  };
  if (value.note !== undefined) decision.note = safeNote(value.note, `${label}.note`);
  if (disposition === "catalog") {
    decision.projectId = stableId(value.projectId, `${label}.projectId`);
    if (value.serviceId !== undefined) decision.serviceId = stableId(value.serviceId, `${label}.serviceId`);
  } else {
    if (value.projectId !== undefined || value.serviceId !== undefined) {
      fail("invalid-inventory-document", `${label} external decisions must not name a catalog project or service`);
    }
    if (!decision.note) fail("invalid-inventory-document", `${label}.note is required for an external decision`);
  }
  return decision;
}

export function parseProviderInventoryDocument(value) {
  if (!plainObject(value)) fail("invalid-inventory-document", "inventory binding document must be an object");
  if (!Object.hasOwn(value, "binding") && (Object.hasOwn(value, "formatVersion") || Object.hasOwn(value, "candidates") || Object.hasOwn(value, "execution"))) {
    fail("unsupported-inventory-input", "normalized inventory results are not accepted by the production workflow; provide a reviewed binding document");
  }
  if (!Object.hasOwn(value, "binding")) return { version: 1, binding: structuredClone(value), decisions: [] };
  exactFields(value, documentFields, "document");
  if (value.version !== 1) fail("invalid-inventory-document", "inventory document version must be 1");
  if (!plainObject(value.binding)) fail("invalid-inventory-document", "document.binding must be an object");
  if (!Array.isArray(value.decisions ?? [])) fail("invalid-inventory-document", "document.decisions must be an array");
  if ((value.decisions ?? []).length > 500) fail("invalid-inventory-document", "document.decisions must contain at most 500 items");
  const decisions = (value.decisions ?? []).map(parseDecision);
  const keys = new Set();
  for (const [index, decision] of decisions.entries()) {
    const key = resourceKey(decision);
    if (keys.has(key)) fail("duplicate-inventory-decision", `decisions[${index}] duplicates ${decision.resourceType}/${decision.resourceId}`);
    keys.add(key);
  }
  return { version: 1, binding: structuredClone(value.binding), decisions };
}

export async function readProviderInventoryDocument(filename) {
  const details = await stat(filename);
  if (!details.isFile()) fail("invalid-inventory-document", `${filename} must be a file`);
  if (details.size > MAX_DOCUMENT_BYTES) fail("invalid-inventory-document", `${filename} exceeds the ${MAX_DOCUMENT_BYTES}-byte limit`);
  let value;
  try {
    value = JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) fail("invalid-inventory-document", `${filename} must contain valid JSON`);
    throw error;
  }
  return parseProviderInventoryDocument(value);
}

function resourceKey(resource) {
  return `${resource.resourceType}\u0000${resource.resourceId}`;
}

function scopeKey(scope) {
  return JSON.stringify({
    kind: scope.kind,
    id: scope.id,
    ...(scope.parent ? { parent: { kind: scope.parent.kind, id: scope.parent.id } } : {}),
  });
}

function preflightDecisions(sourceCatalog, decisions) {
  const projects = new Map(sourceCatalog.projects.map(({ manifest }) => [manifest.id, manifest]));
  for (const [index, decision] of decisions.entries()) {
    if (decision.disposition !== "catalog") continue;
    const project = projects.get(decision.projectId);
    if (!project) fail("catalog-inventory-mismatch", `decisions[${index}] references missing project ${decision.projectId}`);
    if (decision.serviceId && !(project.services ?? []).some((service) => service.id === decision.serviceId)) {
      fail("catalog-inventory-mismatch", `decisions[${index}] references missing service ${decision.projectId}/${decision.serviceId}`);
    }
  }
}

function normalizedRepository(repository) {
  if (!repository || typeof repository !== "object") return null;
  const owner = typeof repository.owner === "string" ? repository.owner.trim() : "";
  const name = typeof repository.name === "string" ? repository.name.trim().replace(/\.git$/i, "") : "";
  if (!owner || !name || owner.includes("/") || name.includes("/") || /\s/.test(`${owner}${name}`)) return null;
  return `${owner}/${name}`.toLowerCase();
}

function catalogRepository(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const raw = value.trim().replace(/\.git$/i, "");
  if (/^[^/\s]+\/[^/\s]+$/.test(raw)) return raw.toLowerCase();
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    const parts = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").split("/");
    return parts.length === 2 && parts.every(Boolean) ? parts.join("/").toLowerCase() : null;
  } catch {
    return null;
  }
}

function domain(value) {
  try {
    const parsed = new URL(value);
    return new Set(["http:", "https:"]).has(parsed.protocol) ? parsed.hostname.toLowerCase().replace(/^www\./, "") : null;
  } catch {
    return null;
  }
}

function catalogServiceUrls(service) {
  return [
    service.url,
    service.endpoint?.canonical,
    ...(service.links ?? []).filter((link) => link.type === "primary").map((link) => link.url),
  ].filter(Boolean);
}

function normalizedName(value) {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "");
  return normalized || null;
}

function containsReviewedNameHint(observedName, reviewedName) {
  return Boolean(observedName && reviewedName && reviewedName.length >= 4 && observedName.includes(reviewedName));
}

function possibleCatalogMatches(sourceCatalog, candidate) {
  const candidates = new Map();
  const add = (project, service, signal, observed) => {
    const key = `${project.id}\u0000${service?.id ?? ""}`;
    const current = candidates.get(key) ?? {
      projectId: project.id,
      serviceId: service?.id ?? null,
      signals: [],
    };
    if (!current.signals.some((item) => item.type === signal && item.observed === observed)) {
      current.signals.push({ type: signal, observed });
    }
    candidates.set(key, current);
  };

  const observedRepository = normalizedRepository(candidate.repository);
  const observedDomains = new Set((candidate.urls ?? [])
    .filter((item) => item.kind === "service")
    .map((item) => domain(item.url))
    .filter(Boolean));
  const observedName = normalizedName(candidate.name);
  const allowNameFragment = candidate.provider === "openai" && candidate.resourceType === "api-key";

  for (const { manifest: project } of sourceCatalog.projects) {
    if (observedRepository && catalogRepository(project.repository) === observedRepository) {
      add(project, null, "repository", observedRepository);
    }
    const projectNames = [project.id, project.title, ...(project.aliases ?? [])].map(normalizedName).filter(Boolean);
    if (observedName && projectNames.includes(observedName)) add(project, null, "name", candidate.name);
    else if (allowNameFragment && projectNames.some((name) => containsReviewedNameHint(observedName, name))) {
      add(project, null, "name-fragment", candidate.name);
    }

    for (const service of project.services ?? []) {
      const repositories = (service.links ?? []).filter((link) => link.type === "repository").map((link) => catalogRepository(link.url));
      if (observedRepository && repositories.includes(observedRepository)) add(project, service, "repository", observedRepository);
      const serviceDomains = catalogServiceUrls(service).map(domain).filter(Boolean);
      for (const observedDomain of observedDomains) {
        if (serviceDomains.includes(observedDomain)) add(project, service, "domain", observedDomain);
      }
      const serviceNames = [service.id, service.name].map(normalizedName).filter(Boolean);
      if (observedName && serviceNames.includes(observedName)) add(project, service, "name", candidate.name);
      else if (allowNameFragment && serviceNames.some((name) => containsReviewedNameHint(observedName, name))) {
        add(project, service, "name-fragment", candidate.name);
      }
    }
  }

  return [...candidates.values()]
    .map((item) => ({ ...item, signals: item.signals.sort((left, right) => left.type.localeCompare(right.type) || left.observed.localeCompare(right.observed)) }))
    .sort((left, right) => left.projectId.localeCompare(right.projectId) || (left.serviceId ?? "").localeCompare(right.serviceId ?? ""));
}

function providerProvenance(observation, candidate = null) {
  return {
    source: "normalized-provider-inventory",
    adapterId: observation.source.adapterId,
    provider: observation.source.provider,
    scope: structuredClone(observation.source.scope),
    freshness: observation.freshness.state,
    observedAt: observation.freshness.observedAt,
    validUntil: observation.freshness.validUntil,
    evaluatedAt: observation.freshness.evaluatedAt,
    candidate: candidate ? {
      freshness: candidate.freshness,
      observedAt: candidate.observedAt,
      validUntil: candidate.validUntil,
    } : null,
  };
}

function proposalId(candidate, sourceCatalog, { duplicateNames, proposalSalt, reservedProposalIds }) {
  const source = candidate.repository?.name ?? candidate.name;
  const base = source.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "remote-project";
  const unavailable = new Set([
    ...sourceCatalog.projects.map(({ manifest }) => manifest.id),
    ...reservedProposalIds,
  ]);
  if (!unavailable.has(base) && !duplicateNames.has(base)) {
    reservedProposalIds.add(base);
    return base;
  }
  const digest = createHash("sha256").update(`${proposalSalt}\u0000${resourceKey(candidate)}`).digest("hex");
  for (let length = 8; length <= digest.length; length += 8) {
    const id = `${base}-${digest.slice(0, length)}`;
    if (!unavailable.has(id)) {
      reservedProposalIds.add(id);
      return id;
    }
  }
  fail("inventory-proposal-id-conflict", `Could not derive a unique stable ID for ${candidate.resourceType}/${candidate.resourceId}`);
}

function proposalRepository(candidate) {
  const repository = normalizedRepository(candidate.repository);
  return candidate.repository?.provider === "github" ? repository : null;
}

function overlayProposal(sourceCatalog, candidate, options) {
  const { projectDirectory } = options;
  const id = proposalId(candidate, sourceCatalog, options);
  const repository = proposalRepository(candidate);
  const cloudHost = sourceCatalog.hosts.find((host) => host.id === candidate.provider && host.kind === "cloud") ?? null;
  const manifest = {
    version: 1,
    id,
    title: candidate.name,
    registration: "overlay",
    description: `Review-only overlay candidate for ${candidate.name}.`,
    lifecycle: "discovery",
    kind: "project",
    ...(repository ? { repository } : {}),
    services: [],
  };
  validateProjectDocument(manifest, {
    source: `provider inventory proposal ${id}`,
    hostIds: sourceCatalog.hostIds,
    expectedId: id,
  });
  return {
    transport: "stdout",
    writes: false,
    reviewDestination: projectDirectory ? path.join(projectDirectory, `${id}.yaml`) : null,
    manifest,
    yaml: stringify(manifest, { lineWidth: 0 }),
    evidence: {
      repository: repository ?? null,
      workspaces: null,
      reviewedCloudHost: cloudHost ? { id: cloudHost.id, name: cloudHost.name } : null,
    },
    defaults: [
      { field: "lifecycle", value: "discovery", reason: "Provider inventory does not establish operating intent." },
      { field: "kind", value: "project", reason: "Generic review scaffolding; replace with reviewed product context." },
    ],
    unknowns: [
      { field: "workspaces", reason: "A remote provider observation does not establish a local checkout path." },
      {
        field: "services",
        reason: cloudHost
          ? `The reviewed ${cloudHost.id} cloud host is available, but service environment, visibility and lifecycle still require review.`
          : `No reviewed ${candidate.provider} cloud host exists; no service host or service definition was invented.`,
      },
      { field: "commands/probes", reason: "Inventory metadata cannot establish safe commands or health probes." },
    ],
  };
}

function reviewedDecisionRef(decision) {
  return {
    source: "reviewed-inventory-decision",
    disposition: decision.disposition,
    ...(decision.projectId ? { projectId: decision.projectId } : {}),
    ...(decision.serviceId ? { serviceId: decision.serviceId } : {}),
    note: decision.note ?? null,
  };
}

function classificationForCandidate(sourceCatalog, observation, candidate, decision, options) {
  const provenance = providerProvenance(observation, candidate);
  const identity = { provider: candidate.provider, scope: structuredClone(observation.source.scope), resourceType: candidate.resourceType, resourceId: candidate.resourceId };
  if (observation.execution.state !== "succeeded" || observation.freshness.state !== "fresh" || candidate.freshness !== "fresh") {
    const freshness = candidate.freshness === "stale" ? "stale" : observation.freshness.state;
    return {
      status: "unknown",
      identity,
      candidate,
      catalogMatch: null,
      possibleMatches: [],
      reviewedDecision: decision ? reviewedDecisionRef(decision) : null,
      provenance,
      reason: `The exact inventory observation is ${freshness}; historical candidates cannot establish current catalog membership.`,
      recommendedNextAction: "Refresh this exact inventory binding before making a catalog decision.",
      proposal: null,
    };
  }
  if (decision?.disposition === "catalog") {
    return {
      status: "matched",
      identity,
      candidate,
      catalogMatch: { projectId: decision.projectId, serviceId: decision.serviceId ?? null, tier: "exact-provider-identity" },
      possibleMatches: [],
      reviewedDecision: reviewedDecisionRef(decision),
      provenance,
      reason: "The fresh candidate matches an explicit reviewed provider-scope/resource decision.",
      recommendedNextAction: "Keep the reviewed mapping unless an owner confirms that the provider identity changed.",
      proposal: null,
    };
  }
  if (decision?.disposition === "external") {
    return {
      status: "reviewed-external",
      identity,
      candidate,
      catalogMatch: null,
      possibleMatches: [],
      reviewedDecision: reviewedDecisionRef(decision),
      provenance,
      reason: `This exact provider resource is intentionally outside the DevHub catalog: ${decision.note}`,
      recommendedNextAction: "Revisit the reviewed external decision only if ownership or operating intent changes.",
      proposal: null,
    };
  }

  const possibleMatches = possibleCatalogMatches(sourceCatalog, candidate);
  if (possibleMatches.length) {
    return {
      status: "possible-match",
      identity,
      candidate,
      catalogMatch: null,
      possibleMatches,
      ambiguous: possibleMatches.length > 1,
      reviewedDecision: null,
      provenance,
      reason: possibleMatches.length > 1
        ? "Several catalog records share supporting repository, domain or name evidence; none is treated as a match."
        : "Supporting repository, domain or name evidence agrees, but no exact reviewed provider identity is registered.",
      recommendedNextAction: "Review the candidates and record one exact provider-resource decision before changing the catalog.",
      proposal: null,
    };
  }

  return {
    status: "unregistered",
    identity,
    candidate,
    catalogMatch: null,
    possibleMatches: [],
    reviewedDecision: null,
    provenance,
    reason: "No exact reviewed identity or supporting catalog evidence matches this fresh provider candidate.",
    recommendedNextAction: candidate.resourceType === "project"
      ? "Review this overlay proposal in Git before adding any provider fact to the catalog."
      : "Review the provider parent project before proposing a catalog service.",
    proposal: candidate.resourceType === "project" ? overlayProposal(sourceCatalog, candidate, options) : null,
  };
}

function compareItems(left, right) {
  return statusOrder[left.status] - statusOrder[right.status]
    || left.identity.provider.localeCompare(right.identity.provider)
    || left.identity.resourceType.localeCompare(right.identity.resourceType)
    || left.identity.resourceId.localeCompare(right.identity.resourceId);
}

function duplicateProposalNames(candidates) {
  const counts = new Map();
  for (const candidate of candidates.filter((item) => item.resourceType === "project")) {
    const source = candidate.repository?.name ?? candidate.name;
    const base = source.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "remote-project";
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
}

/**
 * Build the existing minimal overlay proposal for one explicitly reviewed new
 * project candidate. This is a pure review seam for Connected Setup: it does
 * not run an adapter, write a catalog file, or relax inventory matching.
 */
export function createReviewedProviderOverlayProposal(sourceCatalog, normalizedInput, resourceIdentity, options = {}) {
  const observation = validateNormalizedInventoryResult(normalizedInput);
  if (!plainObject(resourceIdentity)) fail("invalid-reviewed-resource", "reviewed resource identity must be an object");
  exactFields(resourceIdentity, new Set(["resourceType", "resourceId"]), "resourceIdentity");
  const resourceType = requiredString(resourceIdentity.resourceType, "resourceIdentity.resourceType", 100);
  const resourceId = requiredString(resourceIdentity.resourceId, "resourceIdentity.resourceId", 300);
  if (observation.execution.state !== "succeeded" || observation.freshness.state !== "fresh") {
    fail("stale-reviewed-resource", "reviewed overlay proposals require a fresh successful inventory observation");
  }
  const candidate = observation.candidates.find((item) => item.resourceType === resourceType && item.resourceId === resourceId);
  if (!candidate) fail("reviewed-resource-missing", `the reviewed resource ${resourceType}/${resourceId} is not present in this exact observation`);
  if (candidate.freshness !== "fresh") fail("stale-reviewed-resource", "reviewed overlay proposals require a fresh candidate observation");
  if (candidate.resourceType !== "project") fail("unsupported-reviewed-resource", "only a reviewed provider project can create an overlay project proposal");
  const duplicateNames = duplicateProposalNames(observation.candidates);
  return overlayProposal(sourceCatalog, candidate, {
    projectDirectory: options.projectDirectory ?? null,
    duplicateNames,
    proposalSalt: `${observation.source.provider}\u0000${scopeKey(observation.source.scope)}`,
    reservedProposalIds: new Set(),
  });
}

export function reconcileProviderInventory(sourceCatalog, normalizedInput, decisions = [], options = {}) {
  const observation = validateNormalizedInventoryResult(normalizedInput);
  preflightDecisions(sourceCatalog, decisions);
  const decisionsByResource = new Map(decisions.map((decision) => [resourceKey(decision), decision]));
  const seen = new Set();
  const duplicateNames = duplicateProposalNames(observation.candidates);
  const classificationOptions = {
    projectDirectory: options.projectDirectory ?? null,
    duplicateNames,
    proposalSalt: `${observation.source.provider}\u0000${scopeKey(observation.source.scope)}`,
    reservedProposalIds: new Set(),
  };
  const items = [...observation.candidates]
    .sort((left, right) => resourceKey(left).localeCompare(resourceKey(right)))
    .map((candidate) => {
      const key = resourceKey(candidate);
      seen.add(key);
      return classificationForCandidate(sourceCatalog, observation, candidate, decisionsByResource.get(key), classificationOptions);
    });

  if (observation.execution.state === "succeeded" && observation.freshness.state === "fresh") {
    for (const decision of decisions) {
      if (seen.has(resourceKey(decision))) continue;
      items.push({
        status: "unknown",
        identity: {
          provider: observation.source.provider,
          scope: structuredClone(observation.source.scope),
          resourceType: decision.resourceType,
          resourceId: decision.resourceId,
        },
        candidate: null,
        catalogMatch: decision.disposition === "catalog"
          ? { projectId: decision.projectId, serviceId: decision.serviceId ?? null, tier: "exact-provider-identity" }
          : null,
        possibleMatches: [],
        reviewedDecision: reviewedDecisionRef(decision),
        provenance: providerProvenance(observation),
        reason: "The fresh bounded inventory did not return this reviewed resource; absence does not prove deletion or non-use.",
        recommendedNextAction: "Review the exact provider resource and scope before changing its catalog or external decision.",
        proposal: null,
      });
    }
  }

  if (items.length === 0 && observation.execution.state === "failed") {
    items.push({
      status: "unknown",
      identity: { provider: observation.source.provider, scope: structuredClone(observation.source.scope), resourceType: "scope", resourceId: observation.source.scope.id },
      candidate: null,
      catalogMatch: null,
      possibleMatches: [],
      reviewedDecision: null,
      provenance: providerProvenance(observation),
      reason: `Provider inventory is unavailable: ${observation.execution.reason}.`,
      recommendedNextAction: "Restore read-only access to this exact scope and rerun inventory.",
      proposal: null,
    });
  }

  items.sort(compareItems);
  const statuses = Object.fromEntries(Object.keys(statusOrder).map((status) => [status, items.filter((item) => item.status === status).length]));
  return {
    version: 1,
    command: "inventory",
    readOnly: true,
    generatedAt: observation.freshness.evaluatedAt,
    source: {
      adapterId: observation.source.adapterId,
      provider: observation.source.provider,
      scope: structuredClone(observation.source.scope),
      scopeKey: scopeKey(observation.source.scope),
    },
    freshness: structuredClone(observation.freshness),
    summary: { candidates: observation.candidates.length, items: items.length, statuses },
    items,
  };
}

export async function runProviderInventory(sourceCatalog, documentInput, options = {}) {
  const document = parseProviderInventoryDocument(documentInput);
  const registry = options.registry ?? inventoryAdapterRegistry;
  const adapter = registry.get(document.binding.adapterId);
  if (!adapter) fail("unknown-inventory-adapter", `adapterId is not registered: ${document.binding.adapterId}`);
  let binding;
  try {
    ({ binding } = validateConnectorInventoryExecution({
      contracts: options.contracts ?? CONNECTOR_CONTRACTS,
      binding: document.binding,
      adapter,
    }));
  } catch (error) {
    fail(error?.code ?? "invalid-inventory-binding", error instanceof Error ? error.message : String(error));
  }
  preflightDecisions(sourceCatalog, document.decisions);
  const environment = options.environment ?? process.env;
  const resolveCredential = options.resolveCredential ?? createCredentialResolver({
    environment,
    run: options.runCredentialCommand,
  });
  const observation = await runInventoryAdapter({
    binding,
    adapter,
    environment,
    resolveCredential,
    now: options.now,
  });
  return reconcileProviderInventory(sourceCatalog, observation, document.decisions, {
    projectDirectory: options.projectDirectory,
  });
}

export function formatProviderInventory(result) {
  const counts = Object.entries(result.summary.statuses).map(([status, count]) => `${count} ${status}`).join(", ");
  const lines = [`DevHub provider inventory: ${counts}.`, `Scope: ${result.source.provider}/${result.source.scope.kind}/${result.source.scope.id} · ${result.freshness.state}.`];
  for (const item of result.items) {
    lines.push(`${item.status.toUpperCase()} ${item.identity.resourceType}/${item.identity.resourceId}: ${item.reason}`);
    if (item.catalogMatch) lines.push(`  Catalog: ${item.catalogMatch.projectId}${item.catalogMatch.serviceId ? `/${item.catalogMatch.serviceId}` : ""}`);
    if (item.possibleMatches.length) {
      lines.push(`  Possible: ${item.possibleMatches.map((match) => `${match.projectId}${match.serviceId ? `/${match.serviceId}` : ""}`).join(", ")}`);
    }
    lines.push(`  Next: ${item.recommendedNextAction}`);
    if (item.proposal) {
      lines.push("  Candidate YAML (review only; writes none):");
      lines.push(item.proposal.yaml.trimEnd());
    }
  }
  return lines.join("\n");
}
