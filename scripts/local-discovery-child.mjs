import path from "node:path";

import {
  createUnknownLocalDiscoveryDocument,
  discoverLocalCandidates,
  LocalDiscoveryError,
  normalizeLocalDiscoveryLimits,
  validateExplicitLocalRoots,
} from "../lib/local-discovery.mjs";

const maximumInputBytes = 256 * 1024;
const hostIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const invalidCodes = new Set([
  "duplicate-local-root",
  "invalid-local-discovery-limits",
  "invalid-local-host",
  "invalid-local-home",
  "invalid-local-root",
  "invalid-local-roots",
  "local-host-platform-mismatch",
  "unknown-local-root",
  "unsupported-local-discovery-platform",
]);

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactFields(value, fields) {
  return plainObject(value) && Object.keys(value).every((key) => fields.has(key));
}

function parseRequest(value) {
  if (!exactFields(value, new Set(["version", "host", "roots", "observedAt", "homeDirectory", "platform", "limits"]))
      || value.version !== 1
      || !exactFields(value.host, new Set(["id", "kind"]))
      || !hostIdPattern.test(value.host.id ?? "")
      || !new Set(["mac", "linux"]).has(value.host.kind)
      || value.platform !== process.platform
      || !new Set(["darwin", "linux"]).has(value.platform)
      || typeof value.homeDirectory !== "string" || !path.isAbsolute(value.homeDirectory) || value.homeDirectory.includes("\0")
      || new Date(value.observedAt).toISOString() !== value.observedAt) {
    throw new LocalDiscoveryError("invalid-local-discovery-request", "invalid isolated local discovery request");
  }
  const roots = validateExplicitLocalRoots(value.roots);
  const limits = normalizeLocalDiscoveryLimits(value.limits);
  return { ...value, roots, limits };
}

async function readInput() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > maximumInputBytes) throw new LocalDiscoveryError("invalid-local-discovery-request", "isolated local discovery input is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function main() {
  let request;
  try {
    request = parseRequest(await readInput());
    const result = await discoverLocalCandidates(request);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error instanceof LocalDiscoveryError ? error.code : "local-filesystem-unavailable";
    if (request && !invalidCodes.has(code)) {
      const result = createUnknownLocalDiscoveryDocument({
        host: request.host,
        roots: request.roots,
        observedAt: request.observedAt,
        limits: request.limits,
        reason: code,
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify({ version: 1, command: "discover-local", status: "invalid", error: { code } })}\n`);
  }
}

await main();
