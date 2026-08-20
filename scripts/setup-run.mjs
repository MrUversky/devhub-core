import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  formatSetupReview,
  parseConnectionReviewDocument,
  resolveSetupRunDeadline,
  runSetupReview,
  SetupRunError,
} from "../lib/setup-run.mjs";
import { readSourceCatalog } from "./catalog-tools.mjs";
import { createConnectedSetup } from "./connected-setup.mjs";
import { resolveDevHubPaths } from "./devhub-config.mjs";
import { createCredentialResolver, createDefaultSetupConnectors, readConnectionProfileDocument } from "./setup-session.mjs";

export function parseSetupRunArguments(args) {
  let sourcesValue = null;
  let sourcesSeen = false;
  let deadlineSeen = false;
  let deadlineMs;
  let connectionReviewPath = null;
  let connectionReviewSeen = false;
  let taskObservationPath = null;
  let taskObservationSeen = false;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") json = true;
    else if (argument.startsWith("--task-observation=") || argument === "--task-observation") {
      if (taskObservationSeen) throw new SetupRunError("setup-run-arguments-invalid", "setup-run accepts --task-observation exactly once");
      taskObservationSeen = true;
      const raw = argument === "--task-observation" ? args[++index] : argument.slice("--task-observation=".length);
      if (typeof raw !== "string" || !path.isAbsolute(raw)) {
        throw new SetupRunError("setup-run-arguments-invalid", "setup-run --task-observation requires an absolute transient JSON path");
      }
      taskObservationPath = raw;
    }
    else if (argument.startsWith("--connection-review=") || argument === "--connection-review") {
      if (connectionReviewSeen) throw new SetupRunError("setup-run-arguments-invalid", "setup-run accepts --connection-review exactly once");
      connectionReviewSeen = true;
      const raw = argument === "--connection-review" ? args[++index] : argument.slice("--connection-review=".length);
      if (typeof raw !== "string" || !path.isAbsolute(raw)) {
        throw new SetupRunError("setup-run-arguments-invalid", "setup-run --connection-review requires an absolute reviewed JSON path");
      }
      connectionReviewPath = raw;
    }
    else if (argument.startsWith("--deadline-ms=") || argument === "--deadline-ms") {
      if (deadlineSeen) throw new SetupRunError("setup-run-arguments-invalid", "setup-run accepts --deadline-ms exactly once");
      deadlineSeen = true;
      const raw = argument === "--deadline-ms" ? args[++index] : argument.slice("--deadline-ms=".length);
      if (typeof raw !== "string" || !/^[1-9][0-9]*$/.test(raw)) {
        throw new SetupRunError("setup-run-arguments-invalid", "setup-run --deadline-ms must be a positive integer");
      }
      deadlineMs = resolveSetupRunDeadline(Number(raw));
    }
    else if (argument.startsWith("--sources=") || argument === "--sources") {
      if (sourcesSeen) throw new SetupRunError("setup-run-arguments-invalid", "setup-run accepts --sources exactly once");
      sourcesSeen = true;
      sourcesValue = argument === "--sources" ? args[++index] : argument.slice("--sources=".length);
    }
    else throw new SetupRunError("setup-run-arguments-invalid", `setup-run does not support ${argument}`);
  }
  if (typeof sourcesValue !== "string" || !sourcesValue.trim()) {
    throw new SetupRunError("setup-run-sources-required", "setup-run requires --sources <comma-separated source IDs>");
  }
  const selectedConnectorIds = sourcesValue.split(",").map((source) => source.trim()).filter(Boolean);
  if (!selectedConnectorIds.length || new Set(selectedConnectorIds).size !== selectedConnectorIds.length) {
    throw new SetupRunError("setup-run-source-invalid", "setup-run sources must be unique non-empty IDs");
  }
  if (connectionReviewPath && taskObservationPath) {
    throw new SetupRunError("setup-run-arguments-invalid", "setup-run accepts connection review or task observations, not both");
  }
  return Object.freeze({ selectedConnectorIds: Object.freeze(selectedConnectorIds), json, deadlineMs, connectionReviewPath, taskObservationPath });
}

const MAX_CONNECTION_REVIEW_BYTES = 64 * 1024;
const MAX_TASK_OBSERVATION_BYTES = 1024 * 1024;

export async function readConnectionReviewDocument(filename) {
  let details;
  try {
    details = await stat(filename);
  } catch {
    throw new SetupRunError("connection-review-unavailable", "the reviewed connection answer document is unavailable");
  }
  if (!details.isFile() || details.size > MAX_CONNECTION_REVIEW_BYTES) {
    throw new SetupRunError("connection-review-invalid", `connection review must be a file no larger than ${MAX_CONNECTION_REVIEW_BYTES} bytes`);
  }
  let document;
  try {
    document = JSON.parse(await readFile(filename, "utf8"));
  } catch {
    throw new SetupRunError("connection-review-invalid", "connection review must contain valid JSON");
  }
  parseConnectionReviewDocument(document);
  return document;
}

export async function readTaskObservationDocument(filename) {
  let details;
  try {
    details = await stat(filename);
  } catch {
    throw new SetupRunError("task-observation-unavailable", "the transient task observation document is unavailable");
  }
  if (!details.isFile() || details.size > MAX_TASK_OBSERVATION_BYTES) {
    throw new SetupRunError("task-observation-invalid", `task observation must be a file no larger than ${MAX_TASK_OBSERVATION_BYTES} bytes`);
  }
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch {
    throw new SetupRunError("task-observation-invalid", "task observation must contain valid JSON");
  }
}

async function readOptionalProfiles(filename) {
  try {
    return await readConnectionProfileDocument(filename);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function waitWithSignal(operation, signal) {
  const settled = Promise.resolve(operation).then(
    (value) => ({ state: "settled", value }),
    (error) => ({ state: "rejected", error }),
  );
  if (!signal) return settled;
  if (signal.aborted) return Promise.resolve({ state: "aborted" });
  return new Promise((resolve) => {
    const aborted = () => resolve({ state: "aborted" });
    signal.addEventListener("abort", aborted, { once: true });
    settled.then((outcome) => {
      signal.removeEventListener("abort", aborted);
      resolve(outcome);
    });
  });
}

export async function runSetupRun(registryRoot, args, options = {}) {
  const parsed = parseSetupRunArguments(args);
  const paths = options.paths ?? resolveDevHubPaths(registryRoot, options.environment);
  const now = new Date(options.now ?? Date.now());
  if (!Number.isFinite(now.getTime())) throw new SetupRunError("setup-run-invalid", "setup-run requires a valid clock");
  const deadlineMs = resolveSetupRunDeadline(parsed.deadlineMs ?? options.deadlineMs);
  const deadlineAt = options.deadlineAt ?? (Date.now() + deadlineMs);
  if (!Number.isFinite(deadlineAt)) throw new SetupRunError("setup-run-deadline-invalid", "setup-run deadlineAt must be a finite runtime timestamp");
  const connectors = options.connectors ?? createDefaultSetupConnectors({ root: paths.root, paths, ...options });
  const preloadController = new AbortController();
  let preloadTimedOut = false;
  const externalAbort = () => preloadController.abort();
  if (options.signal?.aborted) preloadController.abort();
  else options.signal?.addEventListener?.("abort", externalAbort, { once: true });
  const preloadRemainingMs = Math.max(0, Math.min(deadlineMs, deadlineAt - Date.now()));
  if (preloadRemainingMs === 0) {
    preloadTimedOut = true;
    preloadController.abort();
  }
  const timeout = preloadRemainingMs > 0 ? setTimeout(() => {
    preloadTimedOut = true;
    preloadController.abort();
  }, preloadRemainingMs) : null;
  let preload;
  const planningOperation = createConnectedSetup({
    ...(options.planning ?? {}),
    selectedConnectorIds: parsed.selectedConnectorIds,
    signal: preloadController.signal,
  });
  try {
    preload = await waitWithSignal(Promise.all([
      planningOperation,
      options.profileDocument === undefined ? readOptionalProfiles(paths.connectionProfilesPath) : options.profileDocument,
      options.sourceCatalog === undefined ? readSourceCatalog(paths.root, { paths }) : options.sourceCatalog,
      parsed.connectionReviewPath ? readConnectionReviewDocument(parsed.connectionReviewPath) : null,
      parsed.taskObservationPath ? readTaskObservationDocument(parsed.taskObservationPath) : null,
    ]), preloadController.signal);
  } finally {
    if (timeout) clearTimeout(timeout);
    options.signal?.removeEventListener?.("abort", externalAbort);
  }
  if (preload.state === "aborted") await planningOperation;
  if (preload.state === "rejected") throw preload.error;
  if (preload.state !== "settled" && (parsed.connectionReviewPath || parsed.taskObservationPath)) {
    if (parsed.taskObservationPath) {
      throw new SetupRunError("task-observation-preflight-unavailable", "the current selected sources and reviewed profiles could not be verified before the setup-run deadline");
    }
    throw new SetupRunError("connection-review-preflight-unavailable", "current reviewed profiles could not be recomputed before the continuation deadline");
  }
  const [planning, profileDocument, sourceCatalog, connectionReviewDocument, taskObservationDocument] = preload.state === "settled"
    ? preload.value
    : [null, null, options.sourceCatalog ?? null, null, null];
  const result = await runSetupReview({
    selectedConnectorIds: parsed.selectedConnectorIds,
    profileDocument,
    planning,
    sourceCatalog,
    connectionReviewDocument,
    taskObservationDocument,
    localDiscoveryDocument: options.localDiscoveryDocument ?? null,
    discoveryReviewDocument: options.discoveryReviewDocument ?? null,
    now,
  }, {
    deadlineMs,
    deadlineAt,
    deadlineExpired: preloadTimedOut,
    sessionId: options.sessionId,
    signal: options.signal,
    projectDirectory: paths.projectDirectory,
    connectors,
    resolveCredential: options.resolveCredential ?? createCredentialResolver({ environment: options.environment, run: options.runCredentialCommand }),
  });
  return Object.freeze({ parsed, result });
}

export function formatSetupRun(result) {
  return formatSetupReview(result);
}
