import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { buildDiscoveryInbox, DiscoveryInboxError } from "../lib/discovery-inbox.mjs";
import { LocalDiscoveryError, normalizeLocalDiscoveryLimits } from "../lib/local-discovery.mjs";
import { readSourceCatalog } from "./catalog-tools.mjs";
import { resolveDevHubPaths } from "./devhub-config.mjs";
import { runIsolatedLocalDiscovery } from "./local-discovery-process.mjs";

const maximumReviewBytes = 1024 * 1024;
const numericOptions = new Map([
  ["--max-depth", "maxDepth"],
  ["--max-entries", "maxEntries"],
  ["--max-bytes", "maxBytes"],
  ["--deadline-ms", "deadlineMs"],
]);

function optionValue(argument, option) {
  return argument.startsWith(`${option}=`) ? argument.slice(option.length + 1) : null;
}

export function parseLocalDiscoveryArguments(argumentsList) {
  if (!Array.isArray(argumentsList)) throw new LocalDiscoveryError("local-discovery-arguments-invalid", "discover-local arguments must be an array");
  const roots = [];
  const limits = {};
  const positionals = [];
  let reviewFilename = null;
  let json = false;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--json") {
      if (json) throw new LocalDiscoveryError("local-discovery-arguments-invalid", "--json may be supplied once");
      json = true;
      continue;
    }
    if (argument === "--root" || argument.startsWith("--root=")) {
      const value = optionValue(argument, "--root") ?? argumentsList[++index];
      if (!value || value.startsWith("--") || !path.isAbsolute(value)) throw new LocalDiscoveryError("local-discovery-arguments-invalid", "every --root must be an explicit absolute path");
      roots.push(path.resolve(value));
      continue;
    }
    if (argument === "--review" || argument.startsWith("--review=")) {
      if (reviewFilename) throw new LocalDiscoveryError("local-discovery-arguments-invalid", "--review may be supplied once");
      const value = optionValue(argument, "--review") ?? argumentsList[++index];
      if (!value || value.startsWith("--")) throw new LocalDiscoveryError("local-discovery-arguments-invalid", "--review needs a JSON file");
      reviewFilename = path.resolve(value);
      continue;
    }
    const numeric = [...numericOptions].find(([option]) => argument === option || argument.startsWith(`${option}=`));
    if (numeric) {
      const [option, key] = numeric;
      if (Object.hasOwn(limits, key)) throw new LocalDiscoveryError("local-discovery-arguments-invalid", `${option} may be supplied once`);
      const raw = optionValue(argument, option) ?? argumentsList[++index];
      if (!raw || !/^[0-9]+$/.test(raw)) throw new LocalDiscoveryError("local-discovery-arguments-invalid", `${option} needs a positive integer`);
      limits[key] = Number(raw);
      continue;
    }
    if (argument.startsWith("--")) throw new LocalDiscoveryError("local-discovery-arguments-invalid", `unsupported discover-local option: ${argument}`);
    positionals.push(argument);
  }
  if (positionals.length !== 1 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(positionals[0]) || roots.length < 1) {
    throw new LocalDiscoveryError("local-discovery-arguments-invalid", "discover-local needs one reviewed host id and at least one --root /absolute/path");
  }
  return Object.freeze({ hostId: positionals[0], roots: Object.freeze(roots), limits: normalizeLocalDiscoveryLimits(limits), reviewFilename, json });
}

async function readReview(filename) {
  if (!filename) return null;
  const details = await stat(filename);
  if (!details.isFile() || details.size > maximumReviewBytes) throw new DiscoveryInboxError("invalid-discovery-review", "local discovery review must be a bounded JSON file");
  try { return JSON.parse(await readFile(filename, "utf8")); } catch (error) {
    if (error instanceof SyntaxError) throw new DiscoveryInboxError("invalid-discovery-review", "local discovery review must contain valid JSON");
    throw error;
  }
}

export async function runLocalDiscoveryInbox(root, argumentsList, options = {}) {
  const parsed = parseLocalDiscoveryArguments(argumentsList);
  const paths = options.paths ?? resolveDevHubPaths(root);
  const sourceCatalog = await readSourceCatalog(paths.root, { paths });
  const host = sourceCatalog.hosts.find((candidate) => candidate.id === parsed.hostId);
  if (!host) throw new LocalDiscoveryError("unknown-local-host", `no reviewed host has id ${parsed.hostId}`);
  const configuredHostId = options.environment?.DEVHUB_HOST_ID;
  if (configuredHostId && configuredHostId !== parsed.hostId) {
    throw new LocalDiscoveryError("local-host-identity-conflict", "the explicit local discovery host conflicts with DEVHUB_HOST_ID");
  }
  const observedAt = new Date(options.now ?? Date.now());
  const [discovery, review] = await Promise.all([
    runIsolatedLocalDiscovery({ id: host.id, kind: host.kind }, parsed.roots, {
      now: observedAt,
      limits: parsed.limits,
      platform: options.platform,
      homeDirectory: options.homeDirectory,
      childPath: options.childPath,
      signal: options.signal,
    }),
    readReview(parsed.reviewFilename),
  ]);
  const result = buildDiscoveryInbox(sourceCatalog, null, null, review, {
    projectDirectory: paths.projectDirectory,
    now: observedAt,
    localDiscoveryDocument: discovery.document,
  });
  return Object.freeze({ parsed, discovery, result });
}
