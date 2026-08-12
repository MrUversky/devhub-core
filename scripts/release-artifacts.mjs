import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rmdir, rm, writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import { verifyPublicManifest } from "./verify-public-manifest.mjs";

const execFileAsync = promisify(execFile);
const manifestName = "PUBLIC_EXPORT_MANIFEST.json";
const evidenceName = "RELEASE-EVIDENCE.json";
const checksumsName = "SHA256SUMS";

function compareCodepoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function digest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function isInside(parent, candidate) {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

async function statIfPresent(filename) {
  try {
    return await lstat(filename);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function validateArtifactName(name, label) {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error(`${label} is not a safe artifact filename.`);
  }
}

function writeField(header, offset, length, value) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) throw new Error(`Tar field is too long: ${value}`);
  bytes.copy(header, offset);
}

function writeOctal(header, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length > length - 1) throw new Error(`Tar numeric field is too large: ${value}`);
  writeField(header, offset, length, `${encoded}\0`);
}

function splitTarPath(filename) {
  if (Buffer.byteLength(filename) <= 100) return { name: filename, prefix: "" };
  for (let index = filename.lastIndexOf("/"); index > 0; index = filename.lastIndexOf("/", index - 1)) {
    const prefix = filename.slice(0, index);
    const name = filename.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`Path cannot be represented in a portable ustar archive: ${filename}`);
}

function tarHeader(filename, size, mode) {
  const header = Buffer.alloc(512);
  const split = splitTarPath(filename);
  writeField(header, 0, 100, split.name);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeField(header, 257, 6, "ustar\0");
  writeField(header, 263, 2, "00");
  writeField(header, 265, 32, "root");
  writeField(header, 297, 32, "root");
  writeField(header, 345, 155, split.prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0");
  writeField(header, 148, 8, `${checksum}\0 `);
  return header;
}

async function createSourceArchive(snapshot, archiveRoot, relativeFiles) {
  const chunks = [];
  for (const relative of relativeFiles) {
    const absolute = path.join(snapshot, relative);
    const stat = await lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Release archive input must be a regular file: ${relative}`);
    }
    const contents = await readFile(absolute);
    const archivePath = `${archiveRoot}/${relative.split(path.sep).join("/")}`;
    chunks.push(tarHeader(archivePath, contents.length, stat.mode & 0o111 ? 0o755 : 0o644));
    chunks.push(contents);
    const padding = (512 - (contents.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  const archive = gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
  // zlib's OS byte may differ by runner even when the deflate stream is the
  // same. 255 means unknown and keeps the artifact cross-platform stable.
  archive[9] = 255;
  return archive;
}

async function createNormalizedSbom(snapshot, packageDocument) {
  const { stdout } = await execFileAsync(
    "npm",
    ["sbom", "--package-lock-only", "--omit=dev", "--sbom-format=cyclonedx", "--sbom-type=application"],
    { cwd: snapshot, encoding: "utf8", maxBuffer: 40 * 1024 * 1024, timeout: 5 * 60 * 1000 },
  );
  const sbom = JSON.parse(stdout);
  if (sbom.bomFormat !== "CycloneDX" || sbom.specVersion !== "1.5" || !sbom.metadata?.component) {
    throw new Error("npm produced an unsupported CycloneDX SBOM.");
  }
  delete sbom.serialNumber;
  delete sbom.metadata.timestamp;
  delete sbom.metadata.tools;
  sbom.metadata.component.type = "application";
  sbom.metadata.component.name = packageDocument.name;
  sbom.metadata.component.version = packageDocument.version;
  return Buffer.from(`${JSON.stringify(sbom, null, 2)}\n`);
}

function readTarString(header, offset, length) {
  const end = header.indexOf(0, offset);
  const bounded = end >= offset && end < offset + length ? end : offset + length;
  return header.subarray(offset, bounded).toString("utf8");
}

function readTarOctal(header, offset, length) {
  const value = readTarString(header, offset, length).trim();
  if (!/^[0-7]+$/.test(value)) throw new Error("Release archive contains an invalid tar numeric field.");
  return Number.parseInt(value, 8);
}

function readSourceArchive(archive) {
  const tar = gunzipSync(archive);
  const files = new Map();
  let offset = 0;
  let zeroBlocks = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      if (zeroBlocks === 2) break;
      continue;
    }
    if (zeroBlocks) throw new Error("Release archive has data after an incomplete terminator.");
    const expectedChecksum = readTarOctal(header, 148, 8);
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    if (actualChecksum !== expectedChecksum) throw new Error("Release archive tar header checksum is invalid.");
    const type = String.fromCharCode(header[156]);
    if (type !== "0" && header[156] !== 0) throw new Error("Release archive may contain only regular files.");
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const filename = prefix ? `${prefix}/${name}` : name;
    const size = readTarOctal(header, 124, 12);
    if (!filename || files.has(filename) || offset + size > tar.length) {
      throw new Error("Release archive contains an invalid or duplicate file entry.");
    }
    files.set(filename, Buffer.from(tar.subarray(offset, offset + size)));
    offset += Math.ceil(size / 512) * 512;
  }
  if (zeroBlocks !== 2 || offset > tar.length) throw new Error("Release archive is truncated.");
  return files;
}

function parseChecksums(contents) {
  if (!contents.endsWith("\n")) throw new Error(`${checksumsName} must end with a newline.`);
  const entries = contents.trimEnd().split("\n").map((line) => {
    const match = /^([a-f0-9]{64})[ ]{2}([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line);
    if (!match) throw new Error(`${checksumsName} contains an invalid line.`);
    return { file: match[2], sha256: match[1] };
  });
  const names = entries.map((entry) => entry.file);
  if (new Set(names).size !== names.length
      || JSON.stringify(names) !== JSON.stringify([...names].sort(compareCodepoints))) {
    throw new Error(`${checksumsName} entries must be unique and codepoint-sorted.`);
  }
  return entries;
}

export async function verifyReleaseArtifacts(directory) {
  const root = path.resolve(directory);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Release evidence root must be a real directory.");
  }
  const evidence = JSON.parse(await readFile(path.join(root, evidenceName), "utf8"));
  if (evidence.formatVersion !== 1 || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(evidence.version ?? "")) {
    throw new Error("Release evidence has an unsupported format or version.");
  }
  for (const [label, entry] of [["archive", evidence.archive], ["sbom", evidence.sbom]]) {
    if (!entry || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")) throw new Error(`Release ${label} evidence is invalid.`);
    validateArtifactName(entry.file, `Release ${label}`);
  }
  if (!evidence.packageAllowlist || evidence.packageAllowlist.file !== manifestName
      || !Number.isInteger(evidence.packageAllowlist.entries) || evidence.packageAllowlist.entries < 1
      || !/^[a-f0-9]{64}$/.test(evidence.packageAllowlist.sha256 ?? "")) {
    throw new Error("Release package allowlist evidence is invalid.");
  }

  const expectedFiles = [checksumsName, evidenceName, evidence.archive.file, evidence.sbom.file]
    .sort(compareCodepoints);
  const actualFiles = (await readdir(root, { withFileTypes: true })).map((entry) => {
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Unexpected non-file release artifact: ${entry.name}`);
    return entry.name;
  }).sort(compareCodepoints);
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error("Release evidence directory contains missing or unexpected files.");
  }

  const archive = await readFile(path.join(root, evidence.archive.file));
  const sbomContents = await readFile(path.join(root, evidence.sbom.file));
  if (digest(archive) !== evidence.archive.sha256 || digest(sbomContents) !== evidence.sbom.sha256) {
    throw new Error("Release artifact digest does not match its evidence.");
  }
  const sbom = JSON.parse(sbomContents);
  if (sbom.bomFormat !== "CycloneDX" || sbom.specVersion !== "1.5"
      || sbom.metadata?.component?.name !== evidence.packageName
      || sbom.metadata?.component?.version !== evidence.version) {
    throw new Error("Release SBOM identity does not match its evidence.");
  }

  const archiveFiles = readSourceArchive(archive);
  const archiveRoot = `${evidence.packageName}-v${evidence.version}`;
  const manifestPath = `${archiveRoot}/${manifestName}`;
  const manifestContents = archiveFiles.get(manifestPath);
  if (!manifestContents || digest(manifestContents) !== evidence.packageAllowlist.sha256) {
    throw new Error("Release archive does not contain the evidenced public manifest.");
  }
  const manifest = JSON.parse(manifestContents);
  if (!Array.isArray(manifest.files) || manifest.files.length !== evidence.packageAllowlist.entries) {
    throw new Error("Release archive public manifest count does not match its evidence.");
  }
  const expectedArchivePaths = [manifestName, ...manifest.files.map((entry) => entry.path)]
    .map((relative) => `${archiveRoot}/${relative}`)
    .sort(compareCodepoints);
  const actualArchivePaths = [...archiveFiles.keys()].sort(compareCodepoints);
  if (JSON.stringify(actualArchivePaths) !== JSON.stringify(expectedArchivePaths)) {
    throw new Error("Release archive violates the public package file allowlist.");
  }
  for (const entry of manifest.files) {
    const contents = archiveFiles.get(`${archiveRoot}/${entry.path}`);
    if (!contents || digest(contents) !== entry.sha256) {
      throw new Error(`Release archive package checksum mismatch: ${entry.path}`);
    }
  }
  if (JSON.stringify(manifest.source) !== JSON.stringify(evidence.source)) {
    throw new Error("Release archive source provenance does not match its evidence.");
  }

  const checksumEntries = parseChecksums(await readFile(path.join(root, checksumsName), "utf8"));
  const evidenceContents = await readFile(path.join(root, evidenceName));
  const expectedChecksums = [
    { file: evidence.archive.file, sha256: evidence.archive.sha256 },
    { file: evidence.sbom.file, sha256: evidence.sbom.sha256 },
    { file: evidenceName, sha256: digest(evidenceContents) },
  ].sort((left, right) => compareCodepoints(left.file, right.file));
  if (JSON.stringify(checksumEntries) !== JSON.stringify(expectedChecksums)) {
    throw new Error(`${checksumsName} does not match the release artifacts.`);
  }
  return { version: evidence.version, files: actualFiles.length, source: evidence.source };
}

export async function buildReleaseArtifacts({ snapshot: inputSnapshot, output: inputOutput, allowDirty = false }) {
  const snapshot = await realpath(path.resolve(inputSnapshot));
  const snapshotStat = await lstat(snapshot);
  if (!snapshotStat.isDirectory() || snapshotStat.isSymbolicLink()) {
    throw new Error("Release snapshot must be a real directory.");
  }
  const excludedTopLevels = new Set([".git", ".next", ".vinext", ".wrangler", "dist", "node_modules"]);
  const rootEntries = (await readdir(snapshot)).filter((entry) => !excludedTopLevels.has(entry));
  const verificationRoot = await mkdtemp(path.join(path.dirname(snapshot), ".devhub-release-verify-"));
  try {
    for (const entry of rootEntries) {
      const source = path.join(snapshot, entry);
      const stat = await lstat(source);
      if (stat.isSymbolicLink()) throw new Error(`${entry}: symbolic links are not allowed`);
      await cp(source, path.join(verificationRoot, entry), {
        recursive: stat.isDirectory(),
        preserveTimestamps: false,
      });
    }
    await verifyPublicManifest(verificationRoot);
  } finally {
    await rm(verificationRoot, { recursive: true, force: true });
  }
  const manifestContents = await readFile(path.join(snapshot, manifestName));
  const manifest = JSON.parse(manifestContents);
  const verification = { source: manifest.source };
  if (!allowDirty && verification.source.state !== "clean") {
    throw new Error("Release evidence requires a clean public snapshot.");
  }
  const packageDocument = JSON.parse(await readFile(path.join(snapshot, "package.json"), "utf8"));
  if (!/^[a-z0-9][a-z0-9-]*$/.test(packageDocument.name ?? "")
      || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(packageDocument.version ?? "")) {
    throw new Error("Public package name or version is not release-safe.");
  }

  const requestedOutput = path.resolve(inputOutput);
  const outputParent = path.dirname(requestedOutput);
  await mkdir(outputParent, { recursive: true });
  const canonicalParent = await realpath(outputParent);
  const output = path.join(canonicalParent, path.basename(requestedOutput));
  if (isInside(snapshot, output) || isInside(output, snapshot)) {
    throw new Error("Release evidence output must be outside the public snapshot.");
  }
  const existing = await statIfPresent(output);
  if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) {
    throw new Error("Release evidence output must be a real directory.");
  }
  if (existing && (await readdir(output)).length) throw new Error(`Release evidence output must be empty: ${output}`);

  const archiveRoot = `${packageDocument.name}-v${packageDocument.version}`;
  const archiveName = `${archiveRoot}-source.tar.gz`;
  const sbomName = `${archiveRoot}-sbom.cdx.json`;
  const relativeFiles = [manifestName, ...manifest.files.map((entry) => entry.path)].sort(compareCodepoints);
  const staging = await mkdtemp(path.join(canonicalParent, ".devhub-release-staging-"));
  let activeStaging = staging;
  try {
    const archive = await createSourceArchive(snapshot, archiveRoot, relativeFiles);
    const sbom = await createNormalizedSbom(snapshot, packageDocument);
    await writeFile(path.join(staging, archiveName), archive);
    await writeFile(path.join(staging, sbomName), sbom);
    const evidence = {
      formatVersion: 1,
      packageName: packageDocument.name,
      version: packageDocument.version,
      source: manifest.source,
      packageAllowlist: {
        file: manifestName,
        entries: manifest.files.length,
        sha256: digest(manifestContents),
      },
      archive: { file: archiveName, sha256: digest(archive) },
      sbom: { file: sbomName, format: "CycloneDX-1.5", sha256: digest(sbom) },
    };
    const evidenceContents = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
    await writeFile(path.join(staging, evidenceName), evidenceContents);
    const sums = [
      { file: archiveName, sha256: evidence.archive.sha256 },
      { file: sbomName, sha256: evidence.sbom.sha256 },
      { file: evidenceName, sha256: digest(evidenceContents) },
    ].sort((left, right) => compareCodepoints(left.file, right.file));
    await writeFile(path.join(staging, checksumsName), `${sums.map((entry) => `${entry.sha256}  ${entry.file}`).join("\n")}\n`);
    await verifyReleaseArtifacts(staging);
    if (existing) await rmdir(output);
    await rename(staging, output);
    activeStaging = null;
    return { output, version: packageDocument.version, files: 4 };
  } finally {
    if (activeStaging) await rm(activeStaging, { recursive: true, force: true });
  }
}
