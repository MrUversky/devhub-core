import { inspectHost } from "./host-inspection.mjs";
import path from "node:path";

const MAX_INPUT_BYTES = 64 * 1024;
const hostIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function exactFields(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

function parseRequest(value) {
  if (!exactFields(value, ["version", "root", "paths", "hostId", "observedAt", "identitySource", "homeDirectory", "uid"])
      || value.version !== 1 || typeof value.root !== "string" || !path.isAbsolute(value.root) || value.root.includes("\0")
      || !exactFields(value.paths, ["root", "catalogDirectory", "hostsPath", "projectDirectory"])
      || Object.values(value.paths).some((item) => typeof item !== "string" || !path.isAbsolute(item) || item.includes("\0"))
      || value.paths.root !== value.root
      || value.paths.hostsPath !== path.join(value.paths.catalogDirectory, "hosts.yaml")
      || value.paths.projectDirectory !== path.join(value.paths.catalogDirectory, "projects")
      || typeof value.hostId !== "string" || !hostIdPattern.test(value.hostId)
      || new Date(value.observedAt).toISOString() !== value.observedAt
      || !new Set(["explicit-argument", "DEVHUB_HOST_ID", "reviewed-connection-profile"]).has(value.identitySource)
      || typeof value.homeDirectory !== "string" || !path.isAbsolute(value.homeDirectory) || value.homeDirectory.includes("\0")
      || !Number.isInteger(value.uid) || value.uid < 0 || value.uid > 0x7fffffff) {
    throw new TypeError("invalid isolated host inspection request");
  }
  return value;
}

async function main() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_INPUT_BYTES) throw new TypeError("isolated host inspection input is too large");
    chunks.push(chunk);
  }
  const request = parseRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  const inspection = await inspectHost(request.root, request.hostId, {
    paths: request.paths,
    now: new Date(request.observedAt),
    identitySource: request.identitySource,
    homeDirectory: request.homeDirectory,
    uid: request.uid,
  });
  process.stdout.write(`${JSON.stringify(inspection)}\n`);
}

try {
  await main();
} catch {
  process.exitCode = 2;
}
