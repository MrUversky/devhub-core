import { readFile, stat } from "node:fs/promises";

import {
  SetupStateError,
  compareSetupRefresh,
  evaluateSetupState,
  proposeConnectionDisconnect,
} from "../lib/setup-state.mjs";
import { buildDiscoveryInbox } from "../lib/discovery-inbox.mjs";
import { parseConnectionProfileDocument } from "../lib/setup-session.mjs";
import { readSourceCatalog } from "./catalog-tools.mjs";
import { resolveDevHubPaths } from "./devhub-config.mjs";

const MAX_PROFILE_BYTES = 256 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024;
const disconnectActions = new Set(["remove", "disable"]);

export function parseSetupStateCliArguments(args) {
  const filenames = [];
  const options = { availabilityReviewFilename: null, discoveryReviewFilename: null };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") continue;
    const option = ["--availability-review", "--discovery-review"].find((name) => argument === name || argument.startsWith(`${name}=`));
    if (!option) {
      if (argument.startsWith("--")) throw new SetupStateError("setup-state-arguments-invalid", `setup-state does not support ${argument}`);
      filenames.push(argument);
      continue;
    }
    if (seen.has(option)) throw new SetupStateError("setup-state-arguments-invalid", `${option} may be supplied only once`);
    const inline = argument.startsWith(`${option}=`) ? argument.slice(option.length + 1) : null;
    const value = inline ?? args[index + 1];
    if (!value || value.startsWith("--")) throw new SetupStateError("setup-state-arguments-invalid", `${option} needs a JSON file`);
    if (inline === null) index += 1;
    seen.add(option);
    if (option === "--availability-review") options.availabilityReviewFilename = value;
    else options.discoveryReviewFilename = value;
  }
  if (filenames.length !== 2) throw new SetupStateError("setup-state-arguments-invalid", "setup-state needs exactly profiles.json and session.json");
  return { profileFilename: filenames[0], sessionFilename: filenames[1], ...options };
}

export async function readBoundedJson(filename, { label = "JSON document", maximumBytes = MAX_ARTIFACT_BYTES } = {}) {
  let details;
  try {
    details = await stat(filename);
  } catch (error) {
    if (error?.code === "ENOENT") throw new SetupStateError("setup-state-file-not-found", `${label} was not found: ${filename}`);
    throw error;
  }
  if (!details.isFile()) throw new SetupStateError("invalid-setup-state-file", `${label} must be a file`);
  if (details.size > maximumBytes) throw new SetupStateError("invalid-setup-state-file", `${label} exceeds the ${maximumBytes}-byte limit`);
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new SetupStateError("invalid-setup-state-file", `${label} must contain valid JSON`);
    throw error;
  }
}

export async function evaluateSetupStateFiles(profileFilename, sessionFilename, options = {}) {
  const paths = options.paths ?? (options.root ? resolveDevHubPaths(options.root) : null);
  const [sourceCatalog, profiles, session, availabilityReview, discoveryReview] = await Promise.all([
    options.discoveryReviewFilename
      ? readSourceCatalog(paths?.root ?? options.root, { ...(paths ? { paths } : {}) })
      : null,
    readBoundedJson(profileFilename, { label: "connection profile document", maximumBytes: MAX_PROFILE_BYTES }),
    readBoundedJson(sessionFilename, { label: "setup session" }),
    options.availabilityReviewFilename
      ? readBoundedJson(options.availabilityReviewFilename, { label: "availability review", maximumBytes: MAX_PROFILE_BYTES })
      : null,
    options.discoveryReviewFilename
      ? readBoundedJson(options.discoveryReviewFilename, { label: "discovery review" })
      : null,
  ]);
  const discoveryInbox = options.discoveryReviewFilename
    ? buildDiscoveryInbox(sourceCatalog, session, profiles, discoveryReview, {
      projectDirectory: paths?.projectDirectory ?? null,
      now: options.now,
    })
    : null;
  return evaluateSetupState(profiles, session, {
    now: options.now,
    availabilityReview,
    discoveryInbox,
  });
}

export async function compareSetupRefreshFiles(profileFilename, previousSessionFilename, currentSessionFilename, options = {}) {
  const [profiles, previousSession, currentSession] = await Promise.all([
    readBoundedJson(profileFilename, { label: "connection profile document", maximumBytes: MAX_PROFILE_BYTES }),
    readBoundedJson(previousSessionFilename, { label: "previous setup session" }),
    readBoundedJson(currentSessionFilename, { label: "current setup session" }),
  ]);
  return compareSetupRefresh(profiles, previousSession, currentSession, { now: options.now });
}

function parseDisconnectRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SetupStateError("invalid-disconnect-request", "disconnect request must be an object");
  }
  const fields = new Set(["reviewedBy", "requestedAt", "reason", "action"]);
  for (const field of Object.keys(value)) {
    if (!fields.has(field)) throw new SetupStateError("invalid-disconnect-request", `disconnectRequest.${field} is not supported`);
  }
  if (!disconnectActions.has(value.action)) {
    throw new SetupStateError("invalid-disconnect-request", "disconnectRequest.action must be remove or disable");
  }
  return {
    action: value.action,
    requestedAt: value.requestedAt,
    requestedBy: value.reviewedBy,
    reason: value.reason,
  };
}

export async function proposeConnectionDisconnectFiles(profileFilename, profileId, requestFilename) {
  const [profileDocument, requestDocument] = await Promise.all([
    readBoundedJson(profileFilename, { label: "connection profile document", maximumBytes: MAX_PROFILE_BYTES }),
    readBoundedJson(requestFilename, { label: "disconnect request", maximumBytes: MAX_PROFILE_BYTES }),
  ]);
  const profiles = parseConnectionProfileDocument(profileDocument);
  const selected = profiles.filter((profile) => profile.id === profileId);
  if (selected.length !== 1) {
    throw new SetupStateError("invalid-disconnect-request", `disconnect requires one reviewed profile with id ${profileId}`);
  }
  return proposeConnectionDisconnect(selected[0], parseDisconnectRequest(requestDocument));
}

export function formatSetupState(result) {
  const lines = [`DevHub setup state: ${result.status}`, `Setup complete: ${result.setupComplete ? "yes" : "no"}`, result.reason];
  for (const connection of result.connections) lines.push(`${connection.profileId} (${connection.connectorId}): ${connection.state}, ${connection.freshness}`);
  if (result.discovery) lines.push(`Discovery: ${result.discovery.state}`);
  return lines.join("\n");
}

export function formatSetupRefresh(result) {
  return [
    `DevHub refresh: ${result.previousSessionId} -> ${result.currentSessionId}`,
    `New ${result.summary.new}; changed ${result.summary.changed}; stale ${result.summary.stale}; unclear ${result.summary.unclear}; unchanged ${result.summary.unchanged}.`,
    "No deletion, provider mutation or catalog write was inferred.",
  ].join("\n");
}

export function formatConnectionDisconnect(result) {
  return [
    `DevHub disconnect proposal: ${result.profileChange.profileId}`,
    `Profile action: ${result.profileChange.action}`,
    "Apply: no — review the proposal before changing the profile document.",
    "Catalog records, provider resources and evidence history are preserved.",
  ].join("\n");
}
