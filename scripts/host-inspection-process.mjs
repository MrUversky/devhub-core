import os from "node:os";
import path from "node:path";

import { resolveDevHubPaths } from "./devhub-config.mjs";
import { runIsolatedJsonChild } from "./isolated-json-child.mjs";

const MAX_INSPECTION_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const defaultChildPath = path.join(import.meta.dirname, "host-inspection-child.mjs");
const hostIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const matchFields = new Set([
  "activeState", "containersObserved", "definition", "definitionPresent", "identifier", "loaded", "mode",
  "projectId", "projectTitle", "runtime", "serviceId", "serviceName", "source", "state", "subState", "unitFileState",
]);

function exactFields(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

function safeString(value, maximum = 500) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !value.includes("\0");
}

function normalizePaths(root, supplied) {
  const resolved = supplied ?? resolveDevHubPaths(root);
  const paths = {
    root: path.resolve(resolved.root),
    catalogDirectory: path.resolve(resolved.catalogDirectory),
    hostsPath: path.resolve(resolved.hostsPath),
    projectDirectory: path.resolve(resolved.projectDirectory),
  };
  if (paths.root !== path.resolve(root)
      || paths.hostsPath !== path.join(paths.catalogDirectory, "hosts.yaml")
      || paths.projectDirectory !== path.join(paths.catalogDirectory, "projects")) {
    throw new TypeError("isolated host inspection requires exact reviewed catalog paths");
  }
  return paths;
}

function inspectionRequest(root, hostId, options) {
  const observedAt = new Date(options.now ?? Date.now()).toISOString();
  if (!hostIdPattern.test(hostId)) throw new TypeError("isolated host inspection requires a stable host id");
  const homeDirectory = path.resolve(options.homeDirectory ?? os.homedir());
  const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
  if (!Number.isInteger(uid) || uid < 0 || uid > 0x7fffffff) throw new TypeError("isolated host inspection requires a valid uid");
  const identitySource = options.identitySource ?? "explicit-argument";
  if (!new Set(["explicit-argument", "DEVHUB_HOST_ID", "reviewed-connection-profile"]).has(identitySource)) {
    throw new TypeError("isolated host inspection requires an explicit identity source");
  }
  return {
    version: 1,
    root: path.resolve(root),
    paths: normalizePaths(root, options.paths),
    hostId,
    observedAt,
    identitySource,
    homeDirectory,
    uid,
  };
}

function validSource(value) {
  const keys = Object.keys(value ?? {}).sort().join(",");
  return value && typeof value === "object" && !Array.isArray(value)
    && ["available,observations,type", "available,observations,timedOut,type"].includes(keys)
    && safeString(value.type, 100) && typeof value.available === "boolean"
    && Number.isInteger(value.observations) && value.observations >= 0
    && (value.timedOut === undefined || typeof value.timedOut === "boolean");
}

function validMatch(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).some((key) => !matchFields.has(key))) return false;
  for (const key of ["projectId", "projectTitle", "serviceId", "serviceName", "runtime", "mode", "source", "identifier", "state"]) {
    if (!safeString(value[key])) return false;
  }
  return Object.entries(value).every(([key, item]) => matchFields.has(key)
    && (typeof item === "string" || typeof item === "boolean" || item === null || Number.isInteger(item)));
}

function validUnknown(value) {
  return exactFields(value, ["projectId", "projectTitle", "serviceId", "serviceName", "runtime", "mode", "reason", "message"])
    && Object.values(value).every((item) => safeString(item));
}

function validProjectRepository(value, request) {
  return exactFields(value, ["projectId", "hostId", "source", "repository"])
    && typeof value.projectId === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.projectId)
    && value.hostId === request.hostId
    && value.source === "git-origin"
    && exactFields(value.repository, ["provider", "owner", "name"])
    && value.repository.provider === "github"
    && /^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(value.repository.owner)
    && /^[a-z0-9._-]{1,100}$/.test(value.repository.name);
}

function normalizeInspection(stdout, request) {
  let value;
  try { value = JSON.parse(stdout); } catch { return null; }
  const expectedFields = Object.hasOwn(value ?? {}, "projectRepositories")
    ? ["version", "command", "readOnly", "host", "identity", "observedAt", "sources", "projectRepositories", "serviceMatches", "unknowns"]
    : ["version", "command", "readOnly", "host", "identity", "observedAt", "sources", "serviceMatches", "unknowns"];
  if (!exactFields(value, expectedFields)
      || value.version !== 1 || value.command !== "inspect-host" || value.readOnly !== true
      || !exactFields(value.host, ["id", "name", "kind", "location"])
      || value.host.id !== request.hostId || !Object.values(value.host).every((item) => safeString(item))
      || !exactFields(value.identity, ["source", "verified"])
      || value.identity.source !== request.identitySource || value.identity.verified !== false
      || value.observedAt !== request.observedAt
      || !Array.isArray(value.sources) || value.sources.length > 100 || !value.sources.every(validSource)
      || (value.projectRepositories !== undefined && (!Array.isArray(value.projectRepositories)
        || value.projectRepositories.length > 500
        || !value.projectRepositories.every((item) => validProjectRepository(item, request))))
      || !Array.isArray(value.serviceMatches) || value.serviceMatches.length > 500 || !value.serviceMatches.every(validMatch)
      || !Array.isArray(value.unknowns) || value.unknowns.length > 500 || !value.unknowns.every(validUnknown)) return null;
  return { ...value, projectRepositories: value.projectRepositories ?? [] };
}

export async function runIsolatedHostInspection(root, hostId, options = {}) {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new TypeError("isolated host inspection requires an absolute registry root");
  const request = inspectionRequest(root, hostId, options);
  const execution = await runIsolatedJsonChild({
    childPath: options.childPath ?? defaultChildPath,
    input: request,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxInputBytes: 64 * 1024,
    maxOutputBytes: MAX_INSPECTION_BYTES,
  });
  if (execution.state !== "completed") return Object.freeze({ state: execution.state, inspection: null, observedAt: request.observedAt });
  const inspection = normalizeInspection(execution.stdout, request);
  return Object.freeze({ state: inspection ? "completed" : "unavailable", inspection, observedAt: request.observedAt });
}

export function unavailableHostInspection(hostId, identitySource, observedAt, reason) {
  const normalizedReason = reason === "aborted" ? "inspection-aborted"
    : reason === "timed-out" ? "inspection-timed-out" : "inspection-unavailable";
  return Object.freeze({
    version: 1,
    command: "inspect-host",
    readOnly: true,
    status: "unknown",
    hostId,
    identitySource,
    observedAt,
    reason: normalizedReason,
    message: "The isolated read-only host inspection did not return a bounded reviewed observation.",
  });
}
