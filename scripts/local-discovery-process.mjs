import os from "node:os";
import path from "node:path";

import {
  createUnknownLocalDiscoveryDocument,
  LocalDiscoveryError,
  normalizeLocalDiscoveryLimits,
  validateExplicitLocalRoots,
  validateLocalDiscoveryDocument,
} from "../lib/local-discovery.mjs";
import { runIsolatedJsonChild } from "./isolated-json-child.mjs";

const defaultChildPath = path.join(import.meta.dirname, "local-discovery-child.mjs");
const maximumOutputBytes = 2 * 1024 * 1024;
const hostIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function requestFor(host, roots, options) {
  if (!host || typeof host !== "object" || !hostIdPattern.test(host.id ?? "") || !new Set(["mac", "linux"]).has(host.kind)) {
    throw new LocalDiscoveryError("invalid-local-host", "local discovery requires one reviewed macOS or Linux host identity");
  }
  const platform = options.platform ?? process.platform;
  if (!new Set(["darwin", "linux"]).has(platform)) {
    throw new LocalDiscoveryError("unsupported-local-discovery-platform", "local discovery currently supports macOS and Linux only");
  }
  const homeDirectory = path.resolve(options.homeDirectory ?? os.homedir());
  const observedAt = new Date(options.now ?? Date.now()).toISOString();
  return {
    version: 1,
    host: { id: host.id, kind: host.kind },
    roots: validateExplicitLocalRoots(roots),
    observedAt,
    homeDirectory,
    platform,
    limits: normalizeLocalDiscoveryLimits(options.limits),
  };
}

function invalidResult(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === "command,error,status,version"
    && value.version === 1 && value.command === "discover-local" && value.status === "invalid"
    && value.error && typeof value.error === "object" && !Array.isArray(value.error)
    && Object.keys(value.error).join(",") === "code" && typeof value.error.code === "string";
}

export async function runIsolatedLocalDiscovery(host, roots, options = {}) {
  const request = requestFor(host, roots, options);
  const execution = await runIsolatedJsonChild({
    childPath: options.childPath ?? defaultChildPath,
    input: request,
    signal: options.signal,
    timeoutMs: request.limits.deadlineMs,
    maxInputBytes: 256 * 1024,
    maxOutputBytes: maximumOutputBytes,
  });
  if (execution.state !== "completed") {
    return Object.freeze({
      state: execution.state,
      document: createUnknownLocalDiscoveryDocument({
        host: request.host,
        roots: request.roots,
        observedAt: request.observedAt,
        limits: request.limits,
        reason: execution.state === "aborted" ? "local-discovery-aborted"
          : execution.state === "timed-out" ? "local-discovery-deadline" : "local-discovery-unavailable",
      }),
    });
  }
  let value;
  try { value = JSON.parse(execution.stdout); } catch { value = null; }
  if (invalidResult(value)) throw new LocalDiscoveryError(value.error.code, "local discovery rejected its reviewed roots or host identity before inspection");
  try {
    const document = validateLocalDiscoveryDocument(value, { expectedHost: request.host, now: request.observedAt });
    if (document.observedAt !== request.observedAt) throw new Error("observation time drift");
    return Object.freeze({ state: "completed", document });
  } catch {
    return Object.freeze({
      state: "unavailable",
      document: createUnknownLocalDiscoveryDocument({
        host: request.host,
        roots: request.roots,
        observedAt: request.observedAt,
        limits: request.limits,
        reason: "local-discovery-unavailable",
      }),
    });
  }
}
