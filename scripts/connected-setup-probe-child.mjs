import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import path from "node:path";

const MAX_INPUT_BYTES = 256 * 1024;
const MAX_PROBES = 256;
const MAX_CANDIDATES_PER_PROBE = 256;
const MAX_PATH_BYTES = 4096;
const probeIdPattern = /^[a-z0-9]+(?:[.:_-][a-z0-9]+)*$/;

function validCandidate(value) {
  return typeof value === "string"
    && path.isAbsolute(value)
    && !value.includes("\0")
    && Buffer.byteLength(value, "utf8") <= MAX_PATH_BYTES;
}

function parsePlan(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "probes,version"
      || value.version !== 1
      || !Array.isArray(value.probes)
      || value.probes.length > MAX_PROBES) {
    throw new TypeError("invalid isolated marker probe plan");
  }
  const ids = new Set();
  return value.probes.map((probe) => {
    if (!probe || typeof probe !== "object" || Array.isArray(probe)
        || Object.keys(probe).sort().join(",") !== "candidates,id,kind"
        || typeof probe.id !== "string" || !probeIdPattern.test(probe.id) || ids.has(probe.id)
        || !["access", "lstat"].includes(probe.kind)
        || !Array.isArray(probe.candidates)
        || probe.candidates.length > MAX_CANDIDATES_PER_PROBE
        || !probe.candidates.every(validCandidate)) {
      throw new TypeError("invalid isolated marker probe");
    }
    ids.add(probe.id);
    return probe;
  });
}

async function probeState(probe) {
  for (const candidate of probe.candidates) {
    try {
      if (probe.kind === "access") await access(candidate, constants.X_OK);
      else await lstat(candidate);
      return "present";
    } catch {
      // A missing or unreadable marker is absent; no file contents are read.
    }
  }
  return "absent";
}

async function main() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_INPUT_BYTES) throw new TypeError("isolated marker probe input is too large");
    chunks.push(chunk);
  }
  const probes = parsePlan(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  const results = [];
  for (const probe of probes) results.push({ id: probe.id, state: await probeState(probe) });
  process.stdout.write(`${JSON.stringify({ version: 1, results })}\n`);
}

try {
  await main();
} catch {
  process.exitCode = 2;
}
