#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import {
  access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";

const execFileAsync = promisify(execFile);
const runtimeManifestName = "DEVHUB_RUNTIME_MANIFEST.json";
const wrapperMarker = "# DevHub user runtime wrapper";
const versionPattern = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const maxArchiveBytes = 256 * 1024 * 1024;
const maxExpandedBytes = 768 * 1024 * 1024;
const maxArchiveEntries = 100_000;

export class DevHubInstallError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DevHubInstallError";
    this.code = code;
  }
}

function invalid(code, message) {
  throw new DevHubInstallError(code, message);
}

function compareCodepoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function digest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function readTarString(header, offset, length) {
  const end = header.indexOf(0, offset);
  const bounded = end >= offset && end < offset + length ? end : offset + length;
  return header.subarray(offset, bounded).toString("utf8");
}

function readTarOctal(header, offset, length) {
  const value = readTarString(header, offset, length).trim();
  if (!/^[0-7]+$/.test(value)) invalid("runtime-archive-invalid", "runtime archive contains an invalid tar numeric field");
  return Number.parseInt(value, 8);
}

function safeRelativePath(filename) {
  return typeof filename === "string"
    && filename !== ""
    && !filename.includes("\\")
    && !path.posix.isAbsolute(filename)
    && path.posix.normalize(filename) === filename
    && filename !== ".."
    && !filename.startsWith("../");
}

function parseRuntimeTar(archive) {
  if (!Buffer.isBuffer(archive) || archive.length > maxArchiveBytes) {
    invalid("runtime-archive-invalid", `runtime archive must be no larger than ${maxArchiveBytes} bytes`);
  }
  let tar;
  try {
    tar = gunzipSync(archive, { maxOutputLength: maxExpandedBytes });
  } catch {
    invalid("runtime-archive-invalid", "runtime archive is not a bounded gzip stream");
  }
  const files = new Map();
  let offset = 0;
  let zeroBlocks = 0;
  let archiveRoot = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      if (zeroBlocks === 2) break;
      continue;
    }
    if (zeroBlocks) invalid("runtime-archive-invalid", "runtime archive has data after an incomplete terminator");
    const expectedChecksum = readTarOctal(header, 148, 8);
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    if (actualChecksum !== expectedChecksum) invalid("runtime-archive-invalid", "runtime archive tar checksum is invalid");
    const type = String.fromCharCode(header[156]);
    if (type !== "0" && header[156] !== 0) invalid("runtime-archive-invalid", "runtime archive may contain only regular files");
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const filename = prefix ? `${prefix}/${name}` : name;
    const size = readTarOctal(header, 124, 12);
    const mode = readTarOctal(header, 100, 8) & 0o777;
    if (!safeRelativePath(filename) || offset + size > tar.length || files.size >= maxArchiveEntries) {
      invalid("runtime-archive-invalid", "runtime archive contains an unsafe or oversized entry");
    }
    const [root, ...parts] = filename.split("/");
    if (!root || !parts.length || (archiveRoot !== null && archiveRoot !== root)) {
      invalid("runtime-archive-invalid", "runtime archive must contain one rooted file tree");
    }
    archiveRoot ??= root;
    const relative = parts.join("/");
    if (!safeRelativePath(relative) || files.has(relative)) invalid("runtime-archive-invalid", "runtime archive contains duplicate paths");
    files.set(relative, { contents: Buffer.from(tar.subarray(offset, offset + size)), mode });
    offset += Math.ceil(size / 512) * 512;
  }
  if (zeroBlocks !== 2 || offset > tar.length || !archiveRoot || tar.length % 512 !== 0
      || tar.subarray(offset).some((byte) => byte !== 0)) {
    invalid("runtime-archive-invalid", "runtime archive is truncated or has trailing data");
  }
  return { archiveRoot, files };
}

function forbiddenRuntimePath(relative) {
  const folded = relative.toLocaleLowerCase("en-US");
  return folded === "config/connection-profiles.json"
    || folded.startsWith("catalog/")
    || folded.startsWith("app/generated/")
    || folded === "public/catalog.json";
}

function parseRuntimeManifest(entry, files, { allowDirty = false } = {}) {
  let manifest;
  try {
    manifest = JSON.parse(entry.contents.toString("utf8"));
  } catch {
    invalid("runtime-manifest-invalid", `${runtimeManifestName} must contain valid JSON`);
  }
  if (manifest.formatVersion !== 1 || manifest.packageName !== "devhub-self-hosted"
      || !versionPattern.test(manifest.version ?? "") || manifest.entrypoint !== "scripts/devhub.mjs"
      || manifest.installer !== "scripts/devhub-install.mjs" || manifest.node !== ">=22.13.0") {
    invalid("runtime-manifest-invalid", `${runtimeManifestName} has an unsupported identity or contract`);
  }
  if (!manifest.source || !/^[a-f0-9]{40,64}$/.test(manifest.source.commit ?? "")
      || !new Set(["clean", "dirty-explicit-allowlist"]).has(manifest.source.state)) {
    invalid("runtime-manifest-invalid", `${runtimeManifestName} has invalid source provenance`);
  }
  if (!allowDirty && manifest.source.state !== "clean") {
    invalid("runtime-not-release-safe", "runtime installation requires a clean sanitized public snapshot");
  }
  if (JSON.stringify(manifest.privacy) !== JSON.stringify({ catalogIncluded: false, profilesIncluded: false })) {
    invalid("runtime-manifest-invalid", `${runtimeManifestName} does not prove the external state boundary`);
  }
  if (!Array.isArray(manifest.files) || !manifest.files.length) invalid("runtime-manifest-invalid", "runtime manifest has no files");
  const expectedPaths = [];
  for (const [index, item] of manifest.files.entries()) {
    if (!item || !safeRelativePath(item.path) || item.path === runtimeManifestName || forbiddenRuntimePath(item.path)
        || !sha256Pattern.test(item.sha256 ?? "") || !new Set([0o644, 0o755]).has(item.mode)) {
      invalid("runtime-manifest-invalid", `runtime manifest files[${index}] is invalid`);
    }
    expectedPaths.push(item.path);
    const archived = files.get(item.path);
    if (!archived || digest(archived.contents) !== item.sha256 || archived.mode !== item.mode) {
      invalid("runtime-archive-invalid", `runtime archive does not match its manifest: ${item.path}`);
    }
  }
  if (new Set(expectedPaths).size !== expectedPaths.length
      || JSON.stringify(expectedPaths) !== JSON.stringify([...expectedPaths].sort(compareCodepoints))) {
    invalid("runtime-manifest-invalid", "runtime manifest paths must be unique and codepoint-sorted");
  }
  const actualPaths = [...files.keys()].filter((relative) => relative !== runtimeManifestName).sort(compareCodepoints);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    invalid("runtime-archive-invalid", "runtime archive contains files outside its exact manifest");
  }
  return manifest;
}

export function inspectRuntimeArchive(archive, options = {}) {
  const parsed = parseRuntimeTar(archive);
  const manifestEntry = parsed.files.get(runtimeManifestName);
  if (!manifestEntry) invalid("runtime-manifest-missing", `runtime archive is missing ${runtimeManifestName}`);
  if (manifestEntry.mode !== 0o644) invalid("runtime-manifest-invalid", `${runtimeManifestName} must use mode 0644`);
  const manifest = parseRuntimeManifest(manifestEntry, parsed.files, options);
  if (parsed.archiveRoot !== `devhub-cli-v${manifest.version}`) {
    invalid("runtime-archive-invalid", "runtime archive root does not match its pinned version");
  }
  return Object.freeze({ ...parsed, manifest });
}

export function isCloudBackedPath(filename, { platform = process.platform, homeDirectory = os.homedir(), metadata = "" } = {}) {
  const absolute = path.resolve(filename);
  const folded = absolute.toLocaleLowerCase("en-US");
  const segments = [
    `${path.sep}library${path.sep}cloudstorage${path.sep}`,
    `${path.sep}library${path.sep}mobile documents${path.sep}`,
    `${path.sep}dropbox${path.sep}`,
    `${path.sep}google drive${path.sep}`,
    `${path.sep}onedrive${path.sep}`,
    `${path.sep}nextcloud${path.sep}`,
    `${path.sep}icloud drive${path.sep}`,
  ].map((value) => value.toLocaleLowerCase("en-US"));
  const knownCloudPath = segments.some((segment) => `${folded}${path.sep}`.includes(segment));
  const flags = String(metadata).toLocaleLowerCase("en-US");
  const fileProviderMetadata = /\b(?:dataless|compressed)\b|com\.apple\.(?:fileprovider|icloud)/.test(flags);
  const macHome = path.resolve(homeDirectory).toLocaleLowerCase("en-US");
  const desktopOrDocuments = platform === "darwin"
    && (folded === `${macHome}${path.sep}desktop` || folded.startsWith(`${macHome}${path.sep}desktop${path.sep}`)
      || folded === `${macHome}${path.sep}documents` || folded.startsWith(`${macHome}${path.sep}documents${path.sep}`));
  return knownCloudPath || fileProviderMetadata || (desktopOrDocuments && fileProviderMetadata);
}

function minimumNodeVersionSatisfied(version = process.versions.node) {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

function installerLocations(environment, options = {}) {
  const homeDirectory = path.resolve(options.homeDirectory ?? os.homedir());
  const dataHome = path.resolve(environment.XDG_DATA_HOME?.trim() || path.join(homeDirectory, ".local/share"));
  const dataRoot = path.resolve(options.dataRoot ?? (environment.DEVHUB_INSTALL_DATA_ROOT?.trim() || path.join(dataHome, "devhub")));
  const binDirectory = path.resolve(options.binDirectory ?? (environment.DEVHUB_INSTALL_BIN_DIR?.trim() || path.join(homeDirectory, ".local/bin")));
  return Object.freeze({
    dataRoot,
    binDirectory,
    runtimeDirectory: path.join(dataRoot, "runtime"),
    currentPath: path.join(dataRoot, "current"),
    devhubPath: path.join(binDirectory, "devhub"),
    installerPath: path.join(binDirectory, "devhub-install"),
  });
}

async function ownerWritableDirectory(directory, label, options = {}) {
  if (/[\r\n\0]/.test(directory)) invalid("install-path-invalid", `${label} contains unsupported characters`);
  if (isCloudBackedPath(path.resolve(directory), options)) {
    invalid("install-path-cloud-backed", `${label} must not be FileProvider or cloud-backed: ${path.resolve(directory)}`);
  }
  await mkdir(directory, { recursive: true, mode: 0o755 });
  const canonical = await realpath(directory);
  const details = await stat(canonical);
  await access(canonical, constants.W_OK);
  if (typeof process.getuid === "function" && details.uid !== process.getuid()) {
    invalid("install-path-not-owned", `${label} must be owned by the current user: ${canonical}`);
  }
  if (isCloudBackedPath(canonical, options)) {
    invalid("install-path-cloud-backed", `${label} must not be FileProvider or cloud-backed: ${canonical}`);
  }
  return canonical;
}

function shellLiteral(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function wrapperContents(dataRoot, binDirectory, entrypoint) {
  return `#!/bin/sh
${wrapperMarker}
set -eu
DEVHUB_DATA_ROOT=${shellLiteral(dataRoot)}
DEVHUB_INSTALL_DATA_ROOT=${shellLiteral(dataRoot)}
DEVHUB_INSTALL_BIN_DIR=${shellLiteral(binDirectory)}
DEVHUB_NODE=${shellLiteral(process.execPath)}
DEVHUB_ENTRYPOINT=${shellLiteral(entrypoint)}
export DEVHUB_INSTALL_DATA_ROOT DEVHUB_INSTALL_BIN_DIR
if ! IFS= read -r DEVHUB_VERSION < "$DEVHUB_DATA_ROOT/current"; then
  echo "DevHub is not installed. Install one pinned verified runtime." >&2
  exit 127
fi
case "$DEVHUB_VERSION" in
  *[!0-9A-Za-z.-]*|"") echo "DevHub active runtime pointer is invalid." >&2; exit 126 ;;
esac
case "$DEVHUB_VERSION" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "DevHub active runtime version is invalid." >&2; exit 126 ;;
esac
exec "$DEVHUB_NODE" "$DEVHUB_DATA_ROOT/runtime/$DEVHUB_VERSION/$DEVHUB_ENTRYPOINT" "$@"
`;
}

async function atomicWrite(filename, contents, mode = 0o644) {
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { flag: "wx", mode });
    await chmod(temporary, mode);
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function assertWrapperAvailable(filename) {
  await readFileState(filename, { label: "DevHub wrapper", managedWrapper: true });
}

async function ownedRuntimeDirectory(dataRoot, options = {}) {
  const directory = path.join(dataRoot, "runtime");
  try {
    const details = await lstat(directory);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      invalid("install-path-invalid", `DevHub runtime directory must be a real directory: ${directory}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const canonical = await ownerWritableDirectory(directory, "DevHub runtime directory", options);
  if (canonical !== directory) {
    invalid("install-path-invalid", `DevHub runtime directory must stay inside its data root: ${directory}`);
  }
  return canonical;
}

async function ensureOwnedWrapper(filename, contents) {
  await assertWrapperAvailable(filename);
  await atomicWrite(filename, contents, 0o755);
}

async function readFileState(filename, { label, managedWrapper = false, maxBytes = 64 * 1024 } = {}) {
  let details;
  try {
    details = await lstat(filename);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (details.isSymbolicLink() || !details.isFile() || details.size > maxBytes) {
    invalid(managedWrapper ? "install-wrapper-conflict" : "install-state-invalid", `${label} must be a bounded regular file: ${filename}`);
  }
  const contents = await readFile(filename);
  if (managedWrapper && !contents.toString("utf8").startsWith(`#!/bin/sh\n${wrapperMarker}\n`)) {
    invalid("install-wrapper-conflict", `refusing to replace an unrelated executable: ${filename}`);
  }
  return Object.freeze({ contents, mode: details.mode & 0o777 });
}

function fileState(contents, mode) {
  return Object.freeze({ contents: Buffer.from(contents), mode });
}

function sameFileState(left, right) {
  return left === null || right === null
    ? left === right
    : left.mode === right.mode && left.contents.equals(right.contents);
}

async function restoreFileState(item) {
  const current = await readFileState(item.filename, {
    label: item.label,
    managedWrapper: item.managedWrapper,
    maxBytes: item.maxBytes,
  });
  if (sameFileState(current, item.before)) return;
  if (!sameFileState(current, item.after)) {
    invalid("install-rollback-conflict", `refusing to overwrite concurrently changed ${item.label}: ${item.filename}`);
  }
  if (item.before === null) await rm(item.filename);
  else await atomicWrite(item.filename, item.before.contents, item.before.mode);
}

async function prepareActivation(dataRoot, binDirectory, version) {
  const devhubContents = wrapperContents(dataRoot, binDirectory, "scripts/devhub.mjs");
  const installerContents = wrapperContents(dataRoot, binDirectory, "scripts/devhub-install.mjs");
  const items = [
    {
      filename: path.join(binDirectory, "devhub"),
      label: "DevHub command wrapper",
      managedWrapper: true,
      maxBytes: 64 * 1024,
      after: fileState(devhubContents, 0o755),
    },
    {
      filename: path.join(binDirectory, "devhub-install"),
      label: "DevHub installer wrapper",
      managedWrapper: true,
      maxBytes: 64 * 1024,
      after: fileState(installerContents, 0o755),
    },
    {
      filename: path.join(dataRoot, "current"),
      label: "DevHub active runtime pointer",
      managedWrapper: false,
      maxBytes: 4 * 1024,
      after: fileState(`${version}\n`, 0o644),
    },
  ];
  for (const item of items) {
    item.before = await readFileState(item.filename, item);
  }
  return Object.freeze({
    items: Object.freeze(items.map((item) => Object.freeze(item))),
    devhubContents,
    installerContents,
  });
}

async function runActivationTestSeam(environment, boundary) {
  // Wrapper writes are too fast to interrupt at a deterministic boundary.
  // This process-level test seam is inert unless a test process opts in.
  if (environment.NODE_ENV !== "test") return;
  const action = environment.DEVHUB_TEST_INSTALL_ACTIVATION;
  if (!action) return;
  if (!new Set(["pause-after-first", "fail-after-wrappers"]).has(action)) {
    invalid("test-install-seam-invalid", "test activation action is unsupported");
  }
  if (action === "pause-after-first" && boundary === "after-first") {
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
  if (action === "fail-after-wrappers" && boundary === "after-wrappers") {
    invalid("test-install-activation-failure", "test requested an activation failure");
  }
}

async function activateRuntime({ activation, dataRoot, binDirectory, version, environment, testSeam = false }) {
  try {
    await ensureOwnedWrapper(path.join(binDirectory, "devhub"), activation.devhubContents);
    if (testSeam) await runActivationTestSeam(environment, "after-first");
    await ensureOwnedWrapper(path.join(binDirectory, "devhub-install"), activation.installerContents);
    if (testSeam) await runActivationTestSeam(environment, "after-wrappers");
    await atomicWrite(path.join(dataRoot, "current"), `${version}\n`);
  } catch (error) {
    const rollbackErrors = [];
    for (const item of [...activation.items].reverse()) {
      try {
        await restoreFileState(item);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length) {
      throw new AggregateError([error, ...rollbackErrors], "DevHub activation failed and could not be fully rolled back", { cause: error });
    }
    throw error;
  }
}

async function cleanupInstallStaging(runtimeDirectory, version, activeStaging = null) {
  const prefix = `.install-${version}-`;
  const entries = await readdir(runtimeDirectory, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = path.join(runtimeDirectory, entry.name);
    if (entry.name.startsWith(prefix) && candidate !== activeStaging) {
      await rm(candidate, { recursive: true, force: true });
    }
  }
}

async function extractRuntime(parsed, destination) {
  for (const [relative, entry] of parsed.files) {
    const filename = path.join(destination, ...relative.split("/"));
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o755 });
    await writeFile(filename, entry.contents, { flag: "wx", mode: entry.mode });
    await chmod(filename, entry.mode);
  }
}

async function verifyInstalledEntrypoint(runtimeRoot, version) {
  let result;
  try {
    result = await execFileAsync(process.execPath, [path.join(runtimeRoot, "scripts/devhub.mjs"), "doctor", "--workflow", "--json"], {
      cwd: runtimeRoot,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    invalid("runtime-smoke-failed", "installed runtime could not load its workflow contract");
  }
  let contract;
  try {
    contract = JSON.parse(result.stdout);
  } catch {
    invalid("runtime-smoke-failed", "installed runtime emitted an invalid workflow contract");
  }
  const expected = {
    contractVersion: 2,
    runtimeVersion: version,
    capabilities: { setupRun: 1, connectionReview: 1, guidedConfirmation: 1, taskObservation: 1 },
  };
  if (result.stderr !== "" || JSON.stringify(contract) !== JSON.stringify(expected)) {
    invalid("runtime-smoke-failed", "installed runtime workflow contract does not match its pinned version");
  }
}

export async function installUserRuntime({ archivePath, expectedSha256, environment = process.env, allowDirty = false, ...options }) {
  if (!minimumNodeVersionSatisfied()) invalid("node-version-unsupported", "DevHub requires Node.js 22.13 or newer");
  if (!path.isAbsolute(archivePath ?? "") || !sha256Pattern.test(expectedSha256 ?? "")) {
    invalid("install-arguments-invalid", "install requires an absolute --archive path and lowercase --sha256 digest");
  }
  const archiveDetails = await lstat(archivePath);
  if (!archiveDetails.isFile() || archiveDetails.isSymbolicLink() || archiveDetails.size > maxArchiveBytes) {
    invalid("runtime-archive-invalid", `runtime archive must be a regular file no larger than ${maxArchiveBytes} bytes`);
  }
  const archive = await readFile(archivePath);
  if (digest(archive) !== expectedSha256) invalid("runtime-checksum-mismatch", "runtime archive SHA-256 does not match the pinned digest");
  const parsed = inspectRuntimeArchive(archive, { allowDirty });
  const locations = installerLocations(environment, options);
  const canonicalDataRoot = await ownerWritableDirectory(locations.dataRoot, "DevHub data root", options);
  const canonicalBin = await ownerWritableDirectory(locations.binDirectory, "DevHub bin directory", options);
  const runtimeDirectory = await ownedRuntimeDirectory(canonicalDataRoot, options);
  const target = path.join(runtimeDirectory, parsed.manifest.version);
  const activation = await prepareActivation(canonicalDataRoot, canonicalBin, parsed.manifest.version);
  let targetExists = false;
  try {
    const details = await lstat(target);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      invalid("runtime-version-conflict", `runtime ${parsed.manifest.version} exists but is not a verified directory`);
    }
    targetExists = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  let staging = null;
  let targetCreated = false;
  let activated = false;
  try {
    if (targetExists) {
      await verifyExistingRuntimeTarget(target, parsed, { allowDirty });
      await verifyInstalledEntrypoint(target, parsed.manifest.version);
    } else {
      await cleanupInstallStaging(runtimeDirectory, parsed.manifest.version);
      staging = await mkdtemp(path.join(runtimeDirectory, `.install-${parsed.manifest.version}-`));
      const payload = path.join(staging, "payload");
      await mkdir(payload);
      await extractRuntime(parsed, payload);
      await verifyInstalledEntrypoint(payload, parsed.manifest.version);
      await rename(payload, target);
      targetCreated = true;
    }
    await cleanupInstallStaging(runtimeDirectory, parsed.manifest.version, staging);
    await activateRuntime({
      activation,
      dataRoot: canonicalDataRoot,
      binDirectory: canonicalBin,
      version: parsed.manifest.version,
      environment,
      testSeam: true,
    });
    activated = true;
  } catch (error) {
    if (targetCreated && !activated) {
      try {
        await rm(target, { recursive: true, force: true });
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "DevHub installation failed and its new runtime could not be removed", { cause: error });
      }
    }
    throw error;
  } finally {
    if (staging !== null) await rm(staging, { recursive: true, force: true });
  }
  return Object.freeze({
    version: 1,
    command: "install",
    status: "installed",
    runtimeVersion: parsed.manifest.version,
    sourceCommit: parsed.manifest.source.commit,
    runtimePath: target,
    commandPath: path.join(canonicalBin, "devhub"),
    installerPath: path.join(canonicalBin, "devhub-install"),
  });
}

async function readInstalledFiles(runtimeRoot) {
  const files = new Map();
  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      invalid("installed-runtime-invalid", `installed runtime is unavailable: ${runtimeRoot}`);
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(runtimeRoot, absolute).split(path.sep).join("/");
      const details = await lstat(absolute);
      if (details.isSymbolicLink()) invalid("installed-runtime-invalid", `installed runtime contains a symbolic link: ${relative}`);
      if (details.isDirectory()) await walk(absolute);
      else if (details.isFile()) {
        if (files.size >= maxArchiveEntries) invalid("installed-runtime-invalid", "installed runtime has too many files");
        files.set(relative, {
          contents: await readFile(absolute),
          mode: details.mode & 0o777,
        });
      } else invalid("installed-runtime-invalid", `installed runtime contains a special file: ${relative}`);
    }
  }
  await walk(runtimeRoot);
  return files;
}

async function readInstalledManifest(runtimeRoot, options = {}) {
  const files = await readInstalledFiles(runtimeRoot);
  const manifestEntry = files.get(runtimeManifestName);
  if (!manifestEntry) invalid("installed-runtime-invalid", `installed runtime manifest is unavailable: ${runtimeRoot}`);
  if (manifestEntry.mode !== 0o644) invalid("installed-runtime-invalid", `installed runtime manifest mode is invalid: ${runtimeRoot}`);
  const document = parseRuntimeManifest(manifestEntry, files, options);
  if (document.version !== path.basename(runtimeRoot)) invalid("installed-runtime-invalid", `installed runtime identity is invalid: ${runtimeRoot}`);
  return document;
}

async function verifyExistingRuntimeTarget(runtimeRoot, parsed, options = {}) {
  try {
    const files = await readInstalledFiles(runtimeRoot);
    const installedManifest = files.get(runtimeManifestName);
    const expectedManifest = parsed.files.get(runtimeManifestName);
    if (!installedManifest || !expectedManifest
        || installedManifest.mode !== expectedManifest.mode
        || !installedManifest.contents.equals(expectedManifest.contents)) {
      invalid("runtime-version-conflict", `runtime ${parsed.manifest.version} does not match the pinned archive`);
    }
    const document = parseRuntimeManifest(installedManifest, files, options);
    if (document.version !== parsed.manifest.version || path.basename(runtimeRoot) !== parsed.manifest.version) {
      invalid("runtime-version-conflict", `runtime ${parsed.manifest.version} has a mismatched installed identity`);
    }
    return document;
  } catch (error) {
    if (error instanceof DevHubInstallError && error.code === "runtime-version-conflict") throw error;
    invalid("runtime-version-conflict", `runtime ${parsed.manifest.version} exists but does not exactly match the pinned archive`);
  }
}

export async function rollbackUserRuntime({ version, environment = process.env, allowDirty = false, ...options }) {
  if (!versionPattern.test(version ?? "")) invalid("rollback-arguments-invalid", "rollback requires one pinned --version");
  const locations = installerLocations(environment, options);
  const canonicalDataRoot = await ownerWritableDirectory(locations.dataRoot, "DevHub data root", options);
  const canonicalBin = await ownerWritableDirectory(locations.binDirectory, "DevHub bin directory", options);
  const runtimeDirectory = await ownedRuntimeDirectory(canonicalDataRoot, options);
  const target = path.join(runtimeDirectory, version);
  const manifest = await readInstalledManifest(target, { allowDirty });
  await verifyInstalledEntrypoint(target, version);
  const activation = await prepareActivation(canonicalDataRoot, canonicalBin, version);
  await activateRuntime({
    activation,
    dataRoot: canonicalDataRoot,
    binDirectory: canonicalBin,
    version,
    environment,
  });
  return Object.freeze({
    version: 1,
    command: "rollback",
    status: "activated",
    runtimeVersion: version,
    sourceCommit: manifest.source.commit,
    runtimePath: target,
  });
}

async function removeOwnedWrapper(filename) {
  try {
    const contents = await readFile(filename, "utf8");
    if (!contents.startsWith(`#!/bin/sh\n${wrapperMarker}\n`)) {
      invalid("install-wrapper-conflict", `refusing to remove an unrelated executable: ${filename}`);
    }
    await rm(filename);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function uninstallUserRuntime({ environment = process.env, ...options } = {}) {
  const locations = installerLocations(environment, options);
  const canonicalDataRoot = await ownerWritableDirectory(locations.dataRoot, "DevHub data root", options);
  const canonicalBin = await ownerWritableDirectory(locations.binDirectory, "DevHub bin directory", options);
  const runtimeDirectory = path.join(canonicalDataRoot, "runtime");
  try {
    const details = await lstat(runtimeDirectory);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      invalid("installed-runtime-invalid", `refusing to remove an invalid runtime directory: ${runtimeDirectory}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await assertWrapperAvailable(path.join(canonicalBin, "devhub"));
  await assertWrapperAvailable(path.join(canonicalBin, "devhub-install"));
  await atomicWrite(path.join(canonicalDataRoot, "current"), "uninstalled\n");
  await removeOwnedWrapper(path.join(canonicalBin, "devhub"));
  await removeOwnedWrapper(path.join(canonicalBin, "devhub-install"));
  await rm(runtimeDirectory, { recursive: true, force: true });
  await rm(path.join(canonicalDataRoot, "current"), { force: true });
  return Object.freeze({
    version: 1,
    command: "uninstall",
    status: "uninstalled",
    preserved: Object.freeze({ catalogPath: path.join(canonicalDataRoot, "catalog"), configuration: true }),
  });
}

function parseArguments(argumentsList) {
  const [command, ...rest] = argumentsList;
  const values = new Map();
  let json = false;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--json") {
      if (json) invalid("install-arguments-invalid", "--json may be specified only once");
      json = true;
      continue;
    }
    const separator = argument.indexOf("=");
    const option = separator === -1 ? argument : argument.slice(0, separator);
    if (!new Set(["--archive", "--sha256", "--version", "--data-root", "--bin-dir"]).has(option) || values.has(option)) {
      invalid("install-arguments-invalid", `unsupported or duplicate installer option: ${option}`);
    }
    const value = separator === -1 ? rest[++index] : argument.slice(separator + 1);
    if (typeof value !== "string" || !value || value.startsWith("--")) invalid("install-arguments-invalid", `${option} requires one value`);
    values.set(option, value);
  }
  const options = {
    ...(values.has("--data-root") ? { dataRoot: path.resolve(values.get("--data-root")) } : {}),
    ...(values.has("--bin-dir") ? { binDirectory: path.resolve(values.get("--bin-dir")) } : {}),
  };
  if (command === "install") {
    if (!values.has("--archive") || !values.has("--sha256") || values.has("--version")) {
      invalid("install-arguments-invalid", "install needs --archive and --sha256 only");
    }
    return { command, json, options: { ...options, archivePath: path.resolve(values.get("--archive")), expectedSha256: values.get("--sha256") } };
  }
  if (command === "rollback") {
    if (!values.has("--version") || values.has("--archive") || values.has("--sha256")) {
      invalid("rollback-arguments-invalid", "rollback needs --version only");
    }
    return { command, json, options: { ...options, version: values.get("--version") } };
  }
  if (command === "uninstall") {
    if (values.has("--version") || values.has("--archive") || values.has("--sha256")) {
      invalid("uninstall-arguments-invalid", "uninstall accepts only path overrides and --json");
    }
    return { command, json, options };
  }
  invalid("install-command-invalid", "usage: devhub-install <install|rollback|uninstall> [options] [--json]");
}

function formatResult(result) {
  if (result.command === "install") return `Installed DevHub ${result.runtimeVersion} at ${result.runtimePath}`;
  if (result.command === "rollback") return `Activated DevHub ${result.runtimeVersion} at ${result.runtimePath}`;
  return `Uninstalled DevHub runtime. Preserved catalog path: ${result.preserved.catalogPath}`;
}

const invokedAsScript = process.argv[1]
  && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));

if (invokedAsScript) {
  const jsonRequested = process.argv.includes("--json");
  try {
    const parsed = parseArguments(process.argv.slice(2));
    const result = parsed.command === "install"
      ? await installUserRuntime(parsed.options)
      : parsed.command === "rollback"
        ? await rollbackUserRuntime(parsed.options)
        : await uninstallUserRuntime(parsed.options);
    if (parsed.json) console.log(JSON.stringify(result, null, 2));
    else console.log(formatResult(result));
  } catch (error) {
    const failure = {
      version: 1,
      command: process.argv[2] ?? "unknown",
      status: "invalid",
      error: {
        code: error instanceof DevHubInstallError ? error.code : error?.code ?? "install-failed",
        message: error instanceof Error ? error.message : String(error),
      },
    };
    if (jsonRequested) console.log(JSON.stringify(failure, null, 2));
    else console.error(`DevHub installer failed: ${failure.error.code} — ${failure.error.message}`);
    process.exitCode = 1;
  }
}
