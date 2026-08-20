import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { isMap, isSeq, parseDocument } from "yaml";

const stableIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const packageScriptPattern = /^[A-Za-z0-9_.:-]{1,100}$/;
const composeServicePattern = /^[A-Za-z0-9_.-]{1,100}$/;
const systemdUnitPattern = /^[A-Za-z0-9_.@:-]+\.service$/;
const launchdLabelPattern = /^[A-Za-z0-9_.-]{1,200}$/;
const githubOwnerPattern = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
const githubRepositoryPattern = /^[a-z0-9._-]{1,100}$/;
const secretAssignmentPattern = /\b(?:api[-_]?key|access[-_]?token|authorization|client[-_]?secret|password|passwd|private[-_]?key|secret|token)\s*[:=]\s*["']?(?!\$|\$\{|<|example\b|redacted\b)[A-Za-z0-9_./+=-]{8,}/i;
const secretValuePattern = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bbearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:github_pat_|gh[oprsu]_|sk-(?:proj-)?)[A-Za-z0-9_-]{8,})/i;
const skippedDirectoryNames = new Set([
  ".git", ".devhub", ".next", ".vinext", ".wrangler", "build", "coverage", "dist", "node_modules", "target", "vendor",
]);
const composeFilenames = new Set(["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"]);
const perEvidenceFileBytes = 256 * 1024;
const maximumRoots = 16;
const maximumCandidates = 500;
const freshnessMs = 5 * 60 * 1_000;

export const LOCAL_DISCOVERY_DEFAULT_LIMITS = Object.freeze({
  maxDepth: 4,
  maxEntries: 10_000,
  maxBytes: 1024 * 1024,
  deadlineMs: 10_000,
});

const LOCAL_DISCOVERY_MAX_LIMITS = Object.freeze({
  maxDepth: 12,
  maxEntries: 100_000,
  maxBytes: 8 * 1024 * 1024,
  deadlineMs: 30_000,
});

export class LocalDiscoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LocalDiscoveryError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new LocalDiscoveryError(code, message);
}

function digest(value, length = 24) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function compareCodepoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeString(value, maximum = 300) {
  if (typeof value !== "string") return null;
  const result = value.trim();
  if (!result || result.length > maximum || [...result].some((character) => {
    const code = character.codePointAt(0);
    return code < 32 || code === 127;
  })) return null;
  if (/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(result) || /^file:/i.test(result)) return null;
  if (secretAssignmentPattern.test(result) || secretValuePattern.test(result)) return null;
  return result;
}

function requiredSafeString(value, label, maximum = 300) {
  const result = safeString(value, maximum);
  if (!result || result !== value) fail("invalid-local-discovery-document", `${label} must be a safe non-empty string`);
  return result;
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactFields(value, fields, label) {
  if (!plainObject(value) || Object.keys(value).some((key) => !fields.has(key))) {
    fail("invalid-local-discovery-document", `${label} contains unsupported fields`);
  }
}

function safeStableId(value) {
  const result = safeString(value, 100);
  return result && stableIdPattern.test(result) ? result : null;
}

function boundedInteger(value, fallback, maximum, label, minimum = 1) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    fail("invalid-local-discovery-limits", `${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return result;
}

export function normalizeLocalDiscoveryLimits(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid-local-discovery-limits", "local discovery limits must be an object");
  for (const key of Object.keys(value)) if (!Object.hasOwn(LOCAL_DISCOVERY_DEFAULT_LIMITS, key)) fail("invalid-local-discovery-limits", `unsupported local discovery limit: ${key}`);
  return Object.freeze({
    maxDepth: boundedInteger(value.maxDepth, LOCAL_DISCOVERY_DEFAULT_LIMITS.maxDepth, LOCAL_DISCOVERY_MAX_LIMITS.maxDepth, "maxDepth", 0),
    maxEntries: boundedInteger(value.maxEntries, LOCAL_DISCOVERY_DEFAULT_LIMITS.maxEntries, LOCAL_DISCOVERY_MAX_LIMITS.maxEntries, "maxEntries"),
    maxBytes: boundedInteger(value.maxBytes, LOCAL_DISCOVERY_DEFAULT_LIMITS.maxBytes, LOCAL_DISCOVERY_MAX_LIMITS.maxBytes, "maxBytes"),
    deadlineMs: boundedInteger(value.deadlineMs, LOCAL_DISCOVERY_DEFAULT_LIMITS.deadlineMs, LOCAL_DISCOVERY_MAX_LIMITS.deadlineMs, "deadlineMs", 100),
  });
}

export function validateExplicitLocalRoots(roots) {
  if (!Array.isArray(roots) || roots.length < 1 || roots.length > maximumRoots) {
    fail("invalid-local-roots", `local discovery requires 1 to ${maximumRoots} explicit roots`);
  }
  const normalized = roots.map((root, index) => {
    if (typeof root !== "string" || !path.isAbsolute(root) || root.includes("\0")) {
      fail("invalid-local-root", `selected root ${index + 1} must be an absolute path`);
    }
    return path.resolve(root);
  });
  if (new Set(normalized).size !== normalized.length) fail("duplicate-local-root", "selected local roots must be unique");
  return Object.freeze(normalized);
}

export function localWorkspaceId(hostId, absolutePath) {
  return `local-workspace-${digest(`${hostId}\0${path.resolve(absolutePath)}`)}`;
}

export function localRootId(absolutePath) {
  return `root-${digest(path.resolve(absolutePath), 16)}`;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function preflightRoots(roots) {
  const checked = [];
  for (const [index, selected] of roots.entries()) {
    let details;
    let canonical;
    try {
      details = await lstat(selected);
      if (details.isSymbolicLink() || !details.isDirectory()) fail("unknown-local-root", `selected root ${index + 1} is not a readable directory`);
      canonical = await realpath(selected);
    } catch (error) {
      if (error instanceof LocalDiscoveryError) throw error;
      fail("unknown-local-root", `selected root ${index + 1} is not a readable directory`);
    }
    checked.push({ selected, canonical: path.resolve(canonical), rootId: localRootId(canonical) });
  }
  checked.sort((left, right) => compareCodepoints(left.canonical, right.canonical));
  for (let index = 0; index < checked.length; index += 1) {
    for (let other = index + 1; other < checked.length; other += 1) {
      if (inside(checked[index].canonical, checked[other].canonical) || inside(checked[other].canonical, checked[index].canonical)) {
        fail("duplicate-local-root", "selected local roots must not duplicate or overlap");
      }
    }
  }
  return checked;
}

function canonicalGitHubRepository(raw) {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1 || lines[0].includes("%")) return null;
  const remote = lines[0];
  let owner;
  let name;
  const shorthand = remote.match(/^([^/\s]+)\/([^/\s]+)$/);
  const scp = remote.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (shorthand) {
    [, owner, name] = shorthand;
  } else if (scp) {
    [, owner, name] = scp;
  } else {
    let parsed;
    try { parsed = new URL(remote); } catch { return null; }
    const https = parsed.protocol === "https:" && !parsed.username && !parsed.password;
    const ssh = parsed.protocol === "ssh:" && parsed.username === "git" && !parsed.password;
    if ((!https && !ssh) || parsed.hostname.toLowerCase() !== "github.com" || parsed.port || parsed.search || parsed.hash) return null;
    const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (parts.length !== 2) return null;
    [owner, name] = parts;
  }
  owner = owner.toLowerCase();
  name = name.toLowerCase().replace(/\.git$/i, "");
  if (!githubOwnerPattern.test(owner) || !githubRepositoryPattern.test(name) || name.endsWith(".git")) return null;
  return { provider: "github", owner, name };
}

function gitOriginFromConfig(contents) {
  let inOrigin = false;
  const urls = [];
  for (const line of contents.split(/\r?\n/)) {
    const section = line.match(/^\s*\[remote\s+"([^"]+)"\]\s*$/i);
    if (section) {
      inOrigin = section[1] === "origin";
      continue;
    }
    if (/^\s*\[/.test(line)) {
      inOrigin = false;
      continue;
    }
    if (!inOrigin) continue;
    const match = line.match(/^\s*url\s*=\s*(.*?)\s*$/i);
    if (match) urls.push(match[1]);
  }
  return urls.length === 1 ? canonicalGitHubRepository(urls[0]) : null;
}

function yamlDocument(contents) {
  const document = parseDocument(contents, { prettyErrors: false, strict: true, uniqueKeys: true });
  if (document.errors.length) return null;
  return document;
}

function mapScalar(map, key, maximum = 300) {
  if (!isMap(map)) return null;
  const node = map.get(key, true);
  return node && Object.hasOwn(node, "value") ? safeString(node.value, maximum) : null;
}

function packageEvidence(contents) {
  let value;
  try { value = JSON.parse(contents); } catch { return { valid: false, name: null, scripts: [] }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, name: null, scripts: [] };
  const scripts = value.scripts && typeof value.scripts === "object" && !Array.isArray(value.scripts)
    ? Object.keys(value.scripts).filter((name) => packageScriptPattern.test(name)).sort(compareCodepoints).slice(0, 100)
    : [];
  return { valid: true, name: safeString(value.name, 214), scripts };
}

function manifestEvidence(contents) {
  const document = yamlDocument(contents);
  if (!document || !isMap(document.contents)) return { valid: false, id: null, title: null, repository: null, services: [] };
  const root = document.contents;
  const id = safeStableId(mapScalar(root, "id", 100));
  const title = mapScalar(root, "title", 300);
  const repository = canonicalGitHubRepository(mapScalar(root, "repository", 500) ?? "");
  const servicesNode = root.get("services", true);
  const services = isSeq(servicesNode) ? servicesNode.items.flatMap((item) => {
    if (!isMap(item)) return [];
    const serviceId = safeStableId(mapScalar(item, "id", 100));
    const name = mapScalar(item, "name", 300);
    const runtime = mapScalar(item, "runtime", 100);
    return serviceId && name && runtime ? [{ serviceId, name, runtime }] : [];
  }).slice(0, 200) : [];
  return { valid: Boolean(id && title), id, title, repository, services };
}

function composeEvidence(contents) {
  const document = yamlDocument(contents);
  if (!document || !isMap(document.contents)) return { valid: false, services: [] };
  const services = document.contents.get("services", true);
  if (!isMap(services)) return { valid: false, services: [] };
  const names = services.items.flatMap((pair) => {
    const name = safeString(pair.key?.value, 100);
    return name && composeServicePattern.test(name) ? [name] : [];
  });
  return { valid: true, services: [...new Set(names)].sort(compareCodepoints).slice(0, 200) };
}

function systemdEvidence(contents, filename) {
  if (!systemdUnitPattern.test(filename) || !/^\s*\[Service\]\s*$/m.test(contents) || !/^\s*ExecStart\s*=/m.test(contents)) return null;
  return { name: filename, runtime: "systemd", evidenceKind: "systemd-service" };
}

function launchdEvidence(contents) {
  if (/<!DOCTYPE|<!ENTITY/i.test(contents) || !/<plist\b/i.test(contents)
      || !/<key>\s*(?:Program|ProgramArguments)\s*<\/key>/i.test(contents)) return null;
  const labels = [...contents.matchAll(/<key>\s*Label\s*<\/key>\s*<string>\s*([^<]+?)\s*<\/string>/gi)]
    .map((match) => safeString(match[1], 200)).filter(Boolean);
  if (labels.length !== 1 || !launchdLabelPattern.test(labels[0])) return null;
  return { name: labels[0], runtime: "launchd", evidenceKind: "launchd-service" };
}

function allowedServiceManifestKind(directory, hostKind, homeDirectory) {
  const resolved = path.resolve(directory);
  if (hostKind === "mac") {
    const allowed = [
      path.join(path.resolve(homeDirectory), "Library/LaunchAgents"),
      "/Library/LaunchAgents",
      "/Library/LaunchDaemons",
    ].map((item) => path.resolve(item));
    return allowed.includes(resolved) ? "launchd" : null;
  }
  if (hostKind === "linux") {
    const allowed = [
      path.join(path.resolve(homeDirectory), ".config/systemd/user"),
      "/etc/systemd/system",
      "/usr/lib/systemd/system",
      "/lib/systemd/system",
    ].map((item) => path.resolve(item));
    return allowed.includes(resolved) ? "systemd" : null;
  }
  return null;
}

function supportedHostPlatform(hostKind, platform) {
  return (hostKind === "mac" && platform === "darwin") || (hostKind === "linux" && platform === "linux");
}

function projectCandidate(hostId, directory, evidence) {
  const workspaceId = localWorkspaceId(hostId, directory);
  const name = evidence.manifest?.title ?? evidence.package?.name ?? evidence.repository?.name ?? "Local project";
  const kinds = [...new Set(evidence.kinds)].sort(compareCodepoints);
  return {
    kind: "local-project-candidate",
    provider: "local-host",
    resourceType: "project",
    resourceId: workspaceId,
    workspaceId,
    name,
    ...(evidence.repository ? { repository: evidence.repository } : {}),
    ...(evidence.manifest?.id ? { manifestId: evidence.manifest.id } : {}),
    evidence: {
      kinds,
      packageScripts: evidence.package?.scripts ?? [],
      composeServices: evidence.composeServices,
      declaredServices: evidence.manifest?.services.map((service) => service.serviceId) ?? [],
    },
  };
}

function serviceCandidate(hostId, anchor, { name, runtime, evidenceKind, declaredServiceId = null, parentResourceId = null }) {
  const resourceId = `local-service-${digest(`${hostId}\0${anchor}\0${runtime}\0${declaredServiceId ?? name}`)}`;
  return {
    kind: "local-service-candidate",
    provider: "local-host",
    resourceType: "service",
    resourceId,
    ...(parentResourceId ? { parentResourceId } : {}),
    name,
    runtime,
    ...(declaredServiceId ? { declaredServiceId } : {}),
    evidence: { kinds: [evidenceKind] },
  };
}

function sortCandidates(candidates) {
  const unique = new Map(candidates.map((candidate) => [`${candidate.resourceType}\0${candidate.resourceId}`, candidate]));
  return [...unique.values()].sort((left, right) => compareCodepoints(`${left.resourceType}\0${left.resourceId}`, `${right.resourceType}\0${right.resourceId}`));
}

function isoTimestamp(value, label) {
  const result = new Date(value);
  if (!Number.isFinite(result.getTime())) fail("invalid-local-discovery-time", `${label} must be a valid time`);
  return result.toISOString();
}

export function createUnknownLocalDiscoveryDocument({ host, roots, observedAt, limits, reason }) {
  const normalizedRoots = validateExplicitLocalRoots(roots);
  const normalizedLimits = normalizeLocalDiscoveryLimits(limits);
  const timestamp = isoTimestamp(observedAt ?? Date.now(), "observedAt");
  return Object.freeze({
    version: 1,
    command: "discover-local",
    readOnly: true,
    persistent: false,
    catalogWrites: false,
    repositoryWrites: false,
    host: { id: host.id, kind: host.kind },
    identity: { source: "explicit-argument", verified: false },
    status: "unknown",
    observedAt: timestamp,
    validUntil: new Date(Date.parse(timestamp) + freshnessMs).toISOString(),
    scope: { rootCount: normalizedRoots.length, rootIds: normalizedRoots.map(localRootId).sort(compareCodepoints) },
    limits: { ...normalizedLimits, entriesVisited: 0, bytesRead: 0, depthLimited: false, symlinksSkipped: 0 },
    reason,
    candidates: [],
  });
}

function validateSafeStringArray(value, label, pattern = null, maximum = 200) {
  if (!Array.isArray(value) || value.length > maximum) fail("invalid-local-discovery-document", `${label} must be a bounded array`);
  const parsed = value.map((item, index) => {
    const result = requiredSafeString(item, `${label}[${index}]`, 200);
    if (pattern && !pattern.test(result)) fail("invalid-local-discovery-document", `${label}[${index}] has an invalid shape`);
    return result;
  });
  if (new Set(parsed).size !== parsed.length || JSON.stringify(parsed) !== JSON.stringify([...parsed].sort(compareCodepoints))) {
    fail("invalid-local-discovery-document", `${label} must be unique and sorted`);
  }
  return parsed;
}

function validateRepository(value, label) {
  exactFields(value, new Set(["provider", "owner", "name"]), label);
  const owner = requiredSafeString(value.owner, `${label}.owner`, 39);
  const name = requiredSafeString(value.name, `${label}.name`, 100);
  if (value.provider !== "github" || !githubOwnerPattern.test(owner) || !githubRepositoryPattern.test(name)) {
    fail("invalid-local-discovery-document", `${label} must be a canonical GitHub identity`);
  }
  return { provider: "github", owner, name };
}

function validateCandidate(value, index) {
  const label = `localDiscovery.candidates[${index}]`;
  if (!plainObject(value) || !new Set(["local-project-candidate", "local-service-candidate"]).has(value.kind)) {
    fail("invalid-local-discovery-document", `${label} has an unsupported kind`);
  }
  const project = value.kind === "local-project-candidate";
  exactFields(value, project
    ? new Set(["kind", "provider", "resourceType", "resourceId", "workspaceId", "name", "repository", "manifestId", "evidence"])
    : new Set(["kind", "provider", "resourceType", "resourceId", "parentResourceId", "name", "runtime", "declaredServiceId", "evidence"]), label);
  if (value.provider !== "local-host" || value.resourceType !== (project ? "project" : "service")) {
    fail("invalid-local-discovery-document", `${label} provider/resource type is invalid`);
  }
  const resourceId = requiredSafeString(value.resourceId, `${label}.resourceId`, 100);
  if (!(project ? /^local-workspace-[a-f0-9]{24}$/ : /^local-service-[a-f0-9]{24}$/).test(resourceId)) {
    fail("invalid-local-discovery-document", `${label}.resourceId is invalid`);
  }
  const candidate = {
    kind: value.kind,
    provider: "local-host",
    resourceType: value.resourceType,
    resourceId,
  };
  if (project) {
    if (value.workspaceId !== resourceId) fail("invalid-local-discovery-document", `${label}.workspaceId must match its resource identity`);
    candidate.workspaceId = resourceId;
    candidate.name = requiredSafeString(value.name, `${label}.name`);
    if (value.repository !== undefined) candidate.repository = validateRepository(value.repository, `${label}.repository`);
    if (value.manifestId !== undefined) {
      candidate.manifestId = requiredSafeString(value.manifestId, `${label}.manifestId`, 100);
      if (!stableIdPattern.test(candidate.manifestId)) fail("invalid-local-discovery-document", `${label}.manifestId is invalid`);
    }
    exactFields(value.evidence, new Set(["kinds", "packageScripts", "composeServices", "declaredServices"]), `${label}.evidence`);
    candidate.evidence = {
      kinds: validateSafeStringArray(value.evidence.kinds, `${label}.evidence.kinds`, /^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      packageScripts: validateSafeStringArray(value.evidence.packageScripts, `${label}.evidence.packageScripts`, packageScriptPattern, 100),
      composeServices: validateSafeStringArray(value.evidence.composeServices, `${label}.evidence.composeServices`, composeServicePattern),
      declaredServices: validateSafeStringArray(value.evidence.declaredServices, `${label}.evidence.declaredServices`, stableIdPattern),
    };
  } else {
    if (value.parentResourceId !== undefined) {
      candidate.parentResourceId = requiredSafeString(value.parentResourceId, `${label}.parentResourceId`, 100);
      if (!/^local-workspace-[a-f0-9]{24}$/.test(candidate.parentResourceId)) fail("invalid-local-discovery-document", `${label}.parentResourceId is invalid`);
    }
    candidate.name = requiredSafeString(value.name, `${label}.name`);
    candidate.runtime = requiredSafeString(value.runtime, `${label}.runtime`, 100);
    if (value.declaredServiceId !== undefined) {
      candidate.declaredServiceId = requiredSafeString(value.declaredServiceId, `${label}.declaredServiceId`, 100);
      if (!stableIdPattern.test(candidate.declaredServiceId)) fail("invalid-local-discovery-document", `${label}.declaredServiceId is invalid`);
    }
    exactFields(value.evidence, new Set(["kinds"]), `${label}.evidence`);
    candidate.evidence = { kinds: validateSafeStringArray(value.evidence.kinds, `${label}.evidence.kinds`, /^[a-z0-9]+(?:-[a-z0-9]+)*$/) };
  }
  return candidate;
}

export function validateLocalDiscoveryDocument(value, options = {}) {
  exactFields(value, new Set([
    "version", "command", "readOnly", "persistent", "catalogWrites", "repositoryWrites", "host", "identity",
    "status", "observedAt", "validUntil", "scope", "limits", "reason", "candidates",
  ]), "localDiscovery");
  if (value.version !== 1 || value.command !== "discover-local" || value.readOnly !== true || value.persistent !== false
      || value.catalogWrites !== false || value.repositoryWrites !== false || !new Set(["complete", "unknown"]).has(value.status)) {
    fail("invalid-local-discovery-document", "local discovery safety fields are invalid");
  }
  exactFields(value.host, new Set(["id", "kind"]), "localDiscovery.host");
  const host = { id: requiredSafeString(value.host.id, "localDiscovery.host.id", 100), kind: value.host.kind };
  if (!stableIdPattern.test(host.id) || !new Set(["mac", "linux"]).has(host.kind)) fail("invalid-local-discovery-document", "local discovery host identity is invalid");
  if (options.expectedHost && (host.id !== options.expectedHost.id || host.kind !== options.expectedHost.kind)) {
    fail("local-host-identity-drift", "local discovery does not match the reviewed host identity");
  }
  exactFields(value.identity, new Set(["source", "verified"]), "localDiscovery.identity");
  if (value.identity.source !== "explicit-argument" || value.identity.verified !== false) fail("invalid-local-discovery-document", "local discovery identity provenance is invalid");
  const observedAt = isoTimestamp(value.observedAt, "localDiscovery.observedAt");
  const validUntil = isoTimestamp(value.validUntil, "localDiscovery.validUntil");
  if (Date.parse(validUntil) <= Date.parse(observedAt) || Date.parse(validUntil) - Date.parse(observedAt) > freshnessMs) {
    fail("invalid-local-discovery-document", "local discovery freshness window is invalid");
  }
  if (options.now !== undefined) {
    const now = new Date(options.now);
    if (!Number.isFinite(now.getTime()) || Date.parse(observedAt) > now.getTime() || Date.parse(validUntil) < now.getTime()) {
      fail("stale-local-discovery", "local discovery is not current");
    }
  }
  exactFields(value.scope, new Set(["rootCount", "rootIds"]), "localDiscovery.scope");
  if (!Number.isInteger(value.scope.rootCount) || value.scope.rootCount < 1 || value.scope.rootCount > maximumRoots) fail("invalid-local-discovery-document", "local discovery root count is invalid");
  const rootIds = validateSafeStringArray(value.scope.rootIds, "localDiscovery.scope.rootIds", /^root-[a-f0-9]{16}$/, maximumRoots);
  if (rootIds.length !== value.scope.rootCount) fail("invalid-local-discovery-document", "local discovery root identities do not match the reviewed count");
  exactFields(value.limits, new Set([
    "maxDepth", "maxEntries", "maxBytes", "deadlineMs", "entriesVisited", "bytesRead", "depthLimited", "symlinksSkipped",
  ]), "localDiscovery.limits");
  const limits = normalizeLocalDiscoveryLimits({
    maxDepth: value.limits.maxDepth,
    maxEntries: value.limits.maxEntries,
    maxBytes: value.limits.maxBytes,
    deadlineMs: value.limits.deadlineMs,
  });
  for (const [key, maximum] of [["entriesVisited", limits.maxEntries], ["bytesRead", limits.maxBytes], ["symlinksSkipped", limits.maxEntries]]) {
    if (!Number.isInteger(value.limits[key]) || value.limits[key] < 0 || value.limits[key] > maximum) fail("invalid-local-discovery-document", `local discovery ${key} is invalid`);
  }
  if (typeof value.limits.depthLimited !== "boolean") fail("invalid-local-discovery-document", "local discovery depthLimited is invalid");
  if (!Array.isArray(value.candidates) || value.candidates.length > maximumCandidates) fail("invalid-local-discovery-document", "local discovery candidates are not bounded");
  const candidates = value.candidates.map(validateCandidate);
  const keys = candidates.map((candidate) => `${candidate.resourceType}\0${candidate.resourceId}`);
  if (new Set(keys).size !== keys.length || JSON.stringify(keys) !== JSON.stringify([...keys].sort(compareCodepoints))) {
    fail("invalid-local-discovery-document", "local discovery candidates must be unique and sorted");
  }
  const projectIds = new Set(candidates.filter((candidate) => candidate.resourceType === "project").map((candidate) => candidate.resourceId));
  if (candidates.some((candidate) => candidate.parentResourceId && !projectIds.has(candidate.parentResourceId))) {
    fail("invalid-local-discovery-document", "local service candidate references a missing project candidate");
  }
  const reason = value.reason === null ? null : requiredSafeString(value.reason, "localDiscovery.reason", 100);
  if ((value.status === "complete" && reason !== null) || (value.status === "unknown" && (!reason || candidates.length))) {
    fail("invalid-local-discovery-document", "local discovery status, reason and candidates are inconsistent");
  }
  return Object.freeze({
    version: 1,
    command: "discover-local",
    readOnly: true,
    persistent: false,
    catalogWrites: false,
    repositoryWrites: false,
    host,
    identity: { source: "explicit-argument", verified: false },
    status: value.status,
    observedAt,
    validUntil,
    scope: { rootCount: value.scope.rootCount, rootIds },
    limits: { ...limits, entriesVisited: value.limits.entriesVisited, bytesRead: value.limits.bytesRead, depthLimited: value.limits.depthLimited, symlinksSkipped: value.limits.symlinksSkipped },
    reason,
    candidates,
  });
}

export async function discoverLocalCandidates(options) {
  const roots = validateExplicitLocalRoots(options.roots);
  const limits = normalizeLocalDiscoveryLimits(options.limits);
  const platform = options.platform ?? process.platform;
  const host = options.host;
  if (!host || typeof host !== "object" || !stableIdPattern.test(host.id ?? "") || !new Set(["mac", "linux"]).has(host.kind)) {
    fail("invalid-local-host", "local discovery requires one reviewed macOS or Linux host identity");
  }
  if (!supportedHostPlatform(host.kind, platform)) {
    fail(platform === "win32" ? "unsupported-local-discovery-platform" : "local-host-platform-mismatch", "the reviewed host identity does not match this supported local platform");
  }
  const observedAt = isoTimestamp(options.observedAt ?? Date.now(), "observedAt");
  const homeDirectory = path.resolve(options.homeDirectory ?? os.homedir());
  if (!path.isAbsolute(homeDirectory) || homeDirectory.includes("\0")) fail("invalid-local-home", "local discovery requires an absolute home directory boundary");
  const checkedRoots = await preflightRoots(roots);
  const counters = { entriesVisited: 0, bytesRead: 0, depthLimited: false, symlinksSkipped: 0 };
  const skippedSymlinks = new Set();
  const noteSymlink = (filename) => {
    skippedSymlinks.add(path.resolve(filename));
    counters.symlinksSkipped = skippedSymlinks.size;
  };
  const deadlineAt = (options.clock ?? Date.now)() + limits.deadlineMs;
  const candidates = [];

  const checkDeadline = () => {
    if (options.signal?.aborted) fail("local-discovery-aborted", "bounded local discovery was aborted");
    if ((options.clock ?? Date.now)() >= deadlineAt) fail("local-discovery-deadline", "bounded local discovery reached its deadline");
  };

  const readEvidenceFile = async (filename, root) => {
    checkDeadline();
    let details;
    try { details = await lstat(filename); } catch (error) {
      if (error?.code === "ENOENT") return null;
      fail("local-filesystem-unavailable", "selected local evidence became unavailable");
    }
    if (details.isSymbolicLink()) {
      noteSymlink(filename);
      return null;
    }
    if (!details.isFile()) return null;
    if (!inside(root.canonical, path.resolve(filename))) fail("local-filesystem-boundary", "selected local evidence crossed its approved root");
    if (details.size > perEvidenceFileBytes || counters.bytesRead + details.size > limits.maxBytes) {
      fail("local-discovery-byte-limit", "bounded local discovery reached its byte limit");
    }
    let handle;
    try {
      handle = await open(filename, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size !== details.size) fail("local-filesystem-unavailable", "selected local evidence changed during inspection");
      const contents = Buffer.alloc(opened.size);
      const { bytesRead } = await handle.read(contents, 0, opened.size, 0);
      const afterRead = await handle.stat();
      if (bytesRead !== opened.size || afterRead.size !== opened.size) {
        fail("local-filesystem-unavailable", "selected local evidence changed during inspection");
      }
      counters.bytesRead += bytesRead;
      if (counters.bytesRead > limits.maxBytes) fail("local-discovery-byte-limit", "bounded local discovery reached its byte limit");
      checkDeadline();
      return contents.toString("utf8");
    } catch (error) {
      if (error instanceof LocalDiscoveryError) throw error;
      if (error?.code === "ELOOP") {
        noteSymlink(filename);
        return null;
      }
      fail("local-filesystem-unavailable", "selected local evidence could not be read safely");
    } finally {
      await handle?.close().catch(() => {});
    }
  };

  const queue = checkedRoots.map((root) => ({ directory: root.canonical, depth: 0, root }));
  while (queue.length) {
    checkDeadline();
    const current = queue.shift();
    let details;
    let canonicalDirectory;
    let entries;
    try {
      details = await lstat(current.directory);
      if (details.isSymbolicLink() || !details.isDirectory()) fail("local-filesystem-unavailable", "selected local directory changed during inspection");
      canonicalDirectory = path.resolve(await realpath(current.directory));
      if (!inside(current.root.canonical, canonicalDirectory)) fail("local-filesystem-boundary", "local discovery refused a directory outside its approved root");
      entries = (await readdir(canonicalDirectory, { withFileTypes: true })).sort((left, right) => compareCodepoints(left.name, right.name));
    } catch (error) {
      if (error instanceof LocalDiscoveryError) throw error;
      fail("local-filesystem-unavailable", "a selected local directory could not be inspected safely");
    }
    counters.entriesVisited += entries.length;
    if (counters.entriesVisited > limits.maxEntries) fail("local-discovery-entry-limit", "bounded local discovery reached its entry limit");
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    const identityDirectory = path.resolve(current.root.selected, path.relative(current.root.canonical, canonicalDirectory));
    const evidence = { kinds: [], repository: null, package: null, manifest: null, composeServices: [] };

    if (byName.has("package.json")) {
      const contents = await readEvidenceFile(path.join(canonicalDirectory, "package.json"), current.root);
      if (contents !== null) {
        evidence.package = packageEvidence(contents);
        evidence.kinds.push(evidence.package.valid ? "package-json" : "package-json-invalid");
      }
    }
    for (const filename of [...composeFilenames].filter((name) => byName.has(name)).sort(compareCodepoints)) {
      const contents = await readEvidenceFile(path.join(canonicalDirectory, filename), current.root);
      if (contents !== null) {
        const compose = composeEvidence(contents);
        evidence.kinds.push(compose.valid ? "compose" : "compose-invalid");
        evidence.composeServices.push(...compose.services);
      }
    }
    evidence.composeServices = [...new Set(evidence.composeServices)].sort(compareCodepoints).slice(0, 200);

    const devhubEntry = byName.get(".devhub");
    if (devhubEntry) {
      const devhubPath = path.join(canonicalDirectory, ".devhub");
      let devhubDetails;
      try { devhubDetails = await lstat(devhubPath); } catch { fail("local-filesystem-unavailable", "selected local evidence became unavailable"); }
      if (devhubDetails.isSymbolicLink()) noteSymlink(devhubPath);
      else if (devhubDetails.isDirectory()) {
        const manifestContents = await readEvidenceFile(path.join(devhubPath, "project.yaml"), current.root);
        if (manifestContents !== null) {
          evidence.manifest = manifestEvidence(manifestContents);
          evidence.kinds.push(evidence.manifest.valid ? "devhub-manifest" : "devhub-manifest-invalid");
          evidence.repository = evidence.manifest.repository;
        }
      }
    }

    const gitEntry = byName.get(".git");
    if (gitEntry) {
      const gitPath = path.join(canonicalDirectory, ".git");
      let gitDetails;
      try { gitDetails = await lstat(gitPath); } catch { fail("local-filesystem-unavailable", "selected Git evidence became unavailable"); }
      if (gitDetails.isSymbolicLink()) noteSymlink(gitPath);
      else if (gitDetails.isDirectory()) {
        const config = await readEvidenceFile(path.join(gitPath, "config"), current.root);
        if (config !== null) {
          evidence.repository = gitOriginFromConfig(config) ?? evidence.repository;
          evidence.kinds.push(evidence.repository ? "git-origin" : "git-origin-unsafe-or-unknown");
        }
      }
    }

    if (evidence.kinds.length) {
      const project = projectCandidate(host.id, identityDirectory, evidence);
      candidates.push(project);
      for (const service of evidence.manifest?.services ?? []) {
        candidates.push(serviceCandidate(host.id, identityDirectory, {
          name: service.name,
          runtime: service.runtime,
          declaredServiceId: service.serviceId,
          evidenceKind: "devhub-manifest",
          parentResourceId: project.resourceId,
        }));
      }
      for (const serviceName of evidence.composeServices) {
        candidates.push(serviceCandidate(host.id, identityDirectory, {
          name: serviceName,
          runtime: "docker-compose",
          evidenceKind: "compose",
          parentResourceId: project.resourceId,
        }));
      }
      if (evidence.package?.valid && evidence.package.scripts.some((name) => new Set(["dev", "serve", "start"]).has(name))) {
        candidates.push(serviceCandidate(host.id, identityDirectory, {
          name: evidence.package.name ?? project.name,
          runtime: "node-package",
          evidenceKind: "package-json",
          parentResourceId: project.resourceId,
        }));
      }
    }

    const manifestKind = allowedServiceManifestKind(identityDirectory, host.kind, homeDirectory);
    if (manifestKind) {
      for (const entry of entries) {
        if (manifestKind === "systemd" && !systemdUnitPattern.test(entry.name)) continue;
        if (manifestKind === "launchd" && !entry.name.endsWith(".plist")) continue;
        const contents = await readEvidenceFile(path.join(canonicalDirectory, entry.name), current.root);
        if (contents === null) continue;
        const service = manifestKind === "systemd" ? systemdEvidence(contents, entry.name) : launchdEvidence(contents);
        if (service) candidates.push(serviceCandidate(host.id, identityDirectory, service));
      }
    }

    if (candidates.length > maximumCandidates) fail("local-discovery-candidate-limit", "bounded local discovery reached its candidate limit");
    for (const entry of entries) {
      if (current.depth >= limits.maxDepth) {
        if (entry.isDirectory() && !skippedDirectoryNames.has(entry.name)) counters.depthLimited = true;
        continue;
      }
      if (skippedDirectoryNames.has(entry.name)) continue;
      const childPath = path.join(canonicalDirectory, entry.name);
      let childDetails;
      try { childDetails = await lstat(childPath); } catch { fail("local-filesystem-unavailable", "a selected local entry became unavailable"); }
      if (childDetails.isSymbolicLink()) {
        noteSymlink(childPath);
        continue;
      }
      if (childDetails.isDirectory()) queue.push({ directory: childPath, depth: current.depth + 1, root: current.root });
    }
    queue.sort((left, right) => compareCodepoints(left.directory, right.directory));
  }

  const validUntil = new Date(Date.parse(observedAt) + freshnessMs).toISOString();
  return Object.freeze({
    version: 1,
    command: "discover-local",
    readOnly: true,
    persistent: false,
    catalogWrites: false,
    repositoryWrites: false,
    host: { id: host.id, kind: host.kind },
    identity: { source: "explicit-argument", verified: false },
    status: "complete",
    observedAt,
    validUntil,
    scope: { rootCount: checkedRoots.length, rootIds: checkedRoots.map((root) => root.rootId).sort(compareCodepoints) },
    limits: { ...limits, ...counters },
    reason: null,
    candidates: sortCandidates(candidates),
  });
}
