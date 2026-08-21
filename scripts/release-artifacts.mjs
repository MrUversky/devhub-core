import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rmdir, rm, writeFile,
} from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { inspectRuntimeArchive } from "./devhub-install.mjs";
import { scanPublicExport } from "./scan-public-export.mjs";
import { verifyPublicManifest } from "./verify-public-manifest.mjs";

const manifestName = "PUBLIC_EXPORT_MANIFEST.json";
const evidenceName = "RELEASE-EVIDENCE.json";
const checksumsName = "SHA256SUMS";
const runtimeManifestName = "DEVHUB_RUNTIME_MANIFEST.json";
const runtimeAllowlistName = "config/user-runtime-files.txt";
const releaseIntentName = "config/release-intent.json";
const sha256Pattern = /^[a-f0-9]{64}$/;
const semanticVersionPattern = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const releaseContractRoot = path.resolve(import.meta.dirname, "..");

function execFileWithDeadline(file, args, options, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = execFile(file, args, options, (error, stdout, stderr) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      const error = new Error(`${file} exceeded its ${timeoutMs}ms deadline.`);
      error.code = "ETIMEDOUT";
      reject(error);
    }, timeoutMs);
    timer.unref();
  });
}

function compareCodepoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function digest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function validateApplicationDocuments(packageDocument, lockDocument, label) {
  const versions = [
    ["package.json", packageDocument?.version],
    ["package-lock.json", lockDocument?.version],
    ["package-lock.json packages[\"\"]", lockDocument?.packages?.[""]?.version],
  ];
  for (const [source, version] of versions) {
    if (typeof version !== "string" || !semanticVersionPattern.test(version)) {
      throw new Error(`${label} ${source} has an invalid application version.`);
    }
  }
  if (new Set(versions.map(([, version]) => version)).size !== 1) {
    throw new Error(`${label} package.json and package-lock.json application versions disagree.`);
  }
  return packageDocument.version;
}

function validateReleaseIntent(intentDocument, label) {
  if (!intentDocument || typeof intentDocument !== "object" || Array.isArray(intentDocument)
      || Object.keys(intentDocument).length !== 1
      || !semanticVersionPattern.test(intentDocument.applicationVersion ?? "")) {
    throw new Error(`${label} ${releaseIntentName} must contain only one semantic applicationVersion.`);
  }
  return intentDocument.applicationVersion;
}

function validateReleaseDocuments(packageDocument, lockDocument, intentDocument, label) {
  const applicationVersion = validateApplicationDocuments(packageDocument, lockDocument, label);
  const intendedVersion = validateReleaseIntent(intentDocument, label);
  if (applicationVersion !== intendedVersion) {
    throw new Error(`${label} application version ${applicationVersion} does not match release intent ${intendedVersion}.`);
  }
  return applicationVersion;
}

export async function readApplicationReleaseVersion(root) {
  const resolved = path.resolve(root);
  return validateReleaseDocuments(
    JSON.parse(await readFile(path.join(resolved, "package.json"), "utf8")),
    JSON.parse(await readFile(path.join(resolved, "package-lock.json"), "utf8")),
    JSON.parse(await readFile(path.join(resolved, releaseIntentName), "utf8")),
    "Release source",
  );
}

async function resolveIntendedVersion(intendedVersion) {
  if (intendedVersion === null) return readApplicationReleaseVersion(releaseContractRoot);
  if (typeof intendedVersion !== "string" || !semanticVersionPattern.test(intendedVersion)) {
    throw new Error("Intended application version must be semantic.");
  }
  return intendedVersion;
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

export async function createDeterministicTarGzip(root, archiveRoot, relativeFiles) {
  return createSourceArchive(path.resolve(root), archiveRoot, relativeFiles);
}

function validateRelativePath(relative, label) {
  if (!relative || relative.includes("\\") || path.posix.isAbsolute(relative)
      || path.posix.normalize(relative) !== relative || relative === ".." || relative.startsWith("../")) {
    throw new Error(`${label} must be a normalized relative POSIX path: ${JSON.stringify(relative)}`);
  }
}

async function readRuntimeAllowlist(snapshot, publicManifest) {
  const lines = (await readFile(path.join(snapshot, runtimeAllowlistName), "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (!lines.length || new Set(lines).size !== lines.length
      || JSON.stringify(lines) !== JSON.stringify([...lines].sort(compareCodepoints))) {
    throw new Error("User runtime allowlist must be non-empty, unique and codepoint-sorted.");
  }
  const publicPaths = new Set(publicManifest.files.map((entry) => entry.path));
  for (const relative of lines) {
    validateRelativePath(relative, "User runtime allowlist entry");
    if (!publicPaths.has(relative)) throw new Error(`User runtime file is absent from the sanitized public manifest: ${relative}`);
    if (relative.startsWith("catalog/") || relative === "config/connection-profiles.json"
        || relative.startsWith("app/generated/") || relative === "public/catalog.json") {
      throw new Error(`User runtime allowlist crosses the external state boundary: ${relative}`);
    }
  }
  return lines;
}

async function collectRuntimeFiles(runtimeRoot) {
  const files = [];
  async function walk(directory) {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => compareCodepoints(left.name, right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(runtimeRoot, absolute).split(path.sep).join("/");
      const details = await lstat(absolute);
      if (details.isSymbolicLink()) throw new Error(`User runtime may not contain symbolic links: ${relative}`);
      if (details.isDirectory()) await walk(absolute);
      else if (details.isFile()) {
        const contents = await readFile(absolute);
        files.push({
          path: relative,
          sha256: digest(contents),
          mode: details.mode & 0o111 ? 0o755 : 0o644,
        });
      } else throw new Error(`User runtime may contain only regular files: ${relative}`);
    }
  }
  await walk(runtimeRoot);
  return files.sort((left, right) => compareCodepoints(left.path, right.path));
}

async function scanRuntimeFingerprints(runtimeRoot, files, fingerprintFile) {
  if (!fingerprintFile) return;
  const fingerprints = (await readFile(fingerprintFile, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((value) => ({ original: value, folded: Buffer.from(value.toLocaleLowerCase("en-US")) }));
  for (const file of files) {
    const contents = await readFile(path.join(runtimeRoot, ...file.path.split("/")));
    const folded = Buffer.from(contents.toString("utf8").toLocaleLowerCase("en-US"));
    for (const fingerprint of fingerprints) {
      if (folded.includes(fingerprint.folded)) {
        throw new Error(`User runtime contains private fingerprint ${JSON.stringify(fingerprint.original)} in ${file.path}.`);
      }
    }
  }
}

async function buildRuntimePackage(snapshot, publicManifest, packageDocument, parent, fingerprintFile) {
  const runtimeRoot = await mkdtemp(path.join(parent, ".devhub-runtime-package-"));
  try {
    const allowlist = await readRuntimeAllowlist(snapshot, publicManifest);
    for (const relative of allowlist) {
      const source = path.join(snapshot, relative);
      const destination = path.join(runtimeRoot, relative);
      const details = await lstat(source);
      if (!details.isFile() || details.isSymbolicLink()) throw new Error(`User runtime input must be a regular file: ${relative}`);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination);
    }

    const runtimePackagePath = path.join(runtimeRoot, "package.json");
    const runtimePackage = JSON.parse(await readFile(runtimePackagePath, "utf8"));
    const runtimeLockPath = path.join(runtimeRoot, "package-lock.json");
    const runtimeLock = JSON.parse(await readFile(runtimeLockPath, "utf8"));
    runtimePackage.private = true;
    runtimePackage.scripts = { devhub: "node scripts/devhub.mjs" };
    runtimePackage.dependencies = { yaml: runtimePackage.dependencies.yaml };
    delete runtimePackage.devDependencies;
    await writeFile(runtimePackagePath, `${JSON.stringify(runtimePackage, null, 2)}\n`);
    const prunedLock = {
      name: runtimePackage.name,
      version: runtimePackage.version,
      lockfileVersion: runtimeLock.lockfileVersion,
      requires: true,
      packages: {
        "": {
          name: runtimePackage.name,
          version: runtimePackage.version,
          license: runtimePackage.license,
          dependencies: runtimePackage.dependencies,
          bin: runtimePackage.bin,
          engines: runtimePackage.engines,
        },
        "node_modules/yaml": runtimeLock.packages["node_modules/yaml"],
      },
    };
    if (!prunedLock.packages["node_modules/yaml"]?.integrity) throw new Error("Sanitized lockfile is missing the pinned YAML runtime dependency.");
    await writeFile(runtimeLockPath, `${JSON.stringify(prunedLock, null, 2)}\n`);
    await scanPublicExport(runtimeRoot, { fingerprintFile });

    await execFileWithDeadline(
      "npm",
      ["ci", "--ignore-scripts", "--omit=dev", "--offline", "--no-audit", "--no-fund"],
      { cwd: runtimeRoot, encoding: "utf8", maxBuffer: 40 * 1024 * 1024 },
      5 * 60 * 1000,
    );
    await rm(path.join(runtimeRoot, "node_modules/.bin"), { recursive: true, force: true });
    const sbom = await createNormalizedSbom(runtimeRoot, runtimePackage);
    const files = await collectRuntimeFiles(runtimeRoot);
    await scanRuntimeFingerprints(runtimeRoot, files, fingerprintFile);
    const manifest = {
      formatVersion: 1,
      packageName: packageDocument.name,
      version: packageDocument.version,
      source: publicManifest.source,
      node: ">=22.13.0",
      entrypoint: "scripts/devhub.mjs",
      installer: "scripts/devhub-install.mjs",
      privacy: { catalogIncluded: false, profilesIncluded: false },
      files,
    };
    const manifestContents = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(path.join(runtimeRoot, runtimeManifestName), manifestContents);
    const archiveRoot = `devhub-cli-v${packageDocument.version}`;
    const archive = await createSourceArchive(runtimeRoot, archiveRoot, [runtimeManifestName, ...files.map((entry) => entry.path)].sort(compareCodepoints));
    const inspected = inspectRuntimeArchive(archive, { allowDirty: publicManifest.source.state !== "clean" });
    if (JSON.stringify(inspected.manifest) !== JSON.stringify(manifest)) throw new Error("Generated user runtime manifest did not round-trip.");
    return { archive, manifest, manifestContents, sbom };
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
}

async function createNormalizedSbom(snapshot, packageDocument) {
  const { stdout } = await execFileWithDeadline(
    "npm",
    ["sbom", "--package-lock-only", "--omit=dev", "--sbom-format=cyclonedx", "--sbom-type=application"],
    { cwd: snapshot, encoding: "utf8", maxBuffer: 40 * 1024 * 1024 },
    5 * 60 * 1000,
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

export async function verifyReleaseArtifacts(directory, { intendedVersion = null } = {}) {
  const root = path.resolve(directory);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Release evidence root must be a real directory.");
  const expectedVersion = await resolveIntendedVersion(intendedVersion);
  const evidenceContents = await readFile(path.join(root, evidenceName));
  const evidence = JSON.parse(evidenceContents);
  if (![2, 3].includes(evidence.formatVersion) || !semanticVersionPattern.test(evidence.version ?? "")) {
    throw new Error("Release evidence has an unsupported format or version.");
  }
  if (evidence.version !== expectedVersion) {
    throw new Error(`Release evidence application version ${evidence.version} does not match intended application version ${expectedVersion}.`);
  }
  for (const [label, entry] of [
    ["archive", evidence.archive],
    ["runtime", evidence.runtime],
    ["installer", evidence.installer],
    ["sbom", evidence.sbom],
  ]) {
    if (!entry || !sha256Pattern.test(entry.sha256 ?? "")) throw new Error(`Release ${label} evidence is invalid.`);
    validateArtifactName(entry.file, `Release ${label}`);
  }
  if (!evidence.packageAllowlist || evidence.packageAllowlist.file !== manifestName
      || !Number.isInteger(evidence.packageAllowlist.entries) || evidence.packageAllowlist.entries < 1
      || !sha256Pattern.test(evidence.packageAllowlist.sha256 ?? "")
      || evidence.runtime.manifest?.file !== runtimeManifestName
      || !Number.isInteger(evidence.runtime.manifest.entries) || evidence.runtime.manifest.entries < 1
      || !sha256Pattern.test(evidence.runtime.manifest.sha256 ?? "")) {
    throw new Error("Release package allowlist or runtime manifest evidence is invalid.");
  }
  if (evidence.formatVersion === 3
      && (!evidence.privacy || evidence.privacy.status !== "passed"
        || evidence.privacy.scanner !== "scripts/scan-public-export.mjs"
        || JSON.stringify(evidence.privacy.scopes) !== JSON.stringify(["public-source", "user-runtime"])
        || (evidence.privacy.fingerprintPolicySha256 !== null
          && !sha256Pattern.test(evidence.privacy.fingerprintPolicySha256 ?? "")))) {
    throw new Error("Release privacy-scan evidence is invalid.");
  }
  const expectedArtifactNames = {
    archive: `${evidence.packageName}-v${evidence.version}-source.tar.gz`,
    runtime: `devhub-cli-v${evidence.version}.tar.gz`,
    installer: `devhub-install-v${evidence.version}.mjs`,
    sbom: `${evidence.packageName}-v${evidence.version}-sbom.cdx.json`,
  };
  for (const [label, expectedName] of Object.entries(expectedArtifactNames)) {
    if (evidence[label].file !== expectedName) {
      throw new Error(`Release ${label} filename does not match the intended application version.`);
    }
  }

  const artifactEntries = [evidence.archive, evidence.runtime, evidence.installer, evidence.sbom];
  const expectedFiles = [checksumsName, evidenceName, ...artifactEntries.map((entry) => entry.file)].sort(compareCodepoints);
  const actualFiles = (await readdir(root, { withFileTypes: true })).map((entry) => {
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Unexpected non-file release artifact: ${entry.name}`);
    return entry.name;
  }).sort(compareCodepoints);
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error("Release evidence directory contains missing or unexpected files.");
  }
  const artifactContents = new Map();
  for (const entry of artifactEntries) {
    const contents = await readFile(path.join(root, entry.file));
    if (digest(contents) !== entry.sha256) throw new Error("Release artifact digest does not match its evidence.");
    artifactContents.set(entry.file, contents);
  }

  const sbom = JSON.parse(artifactContents.get(evidence.sbom.file));
  if (sbom.bomFormat !== "CycloneDX" || sbom.specVersion !== "1.5"
      || sbom.metadata?.component?.name !== evidence.packageName
      || sbom.metadata?.component?.version !== evidence.version) {
    throw new Error("Release SBOM identity does not match its evidence.");
  }

  const archiveFiles = readSourceArchive(artifactContents.get(evidence.archive.file));
  const archiveRoot = `${evidence.packageName}-v${evidence.version}`;
  const manifestContents = archiveFiles.get(`${archiveRoot}/${manifestName}`);
  if (!manifestContents || digest(manifestContents) !== evidence.packageAllowlist.sha256) {
    throw new Error("Release archive does not contain the evidenced public manifest.");
  }
  const manifest = JSON.parse(manifestContents);
  if (!Array.isArray(manifest.files) || manifest.files.length !== evidence.packageAllowlist.entries) {
    throw new Error("Release archive public manifest count does not match its evidence.");
  }
  const expectedArchivePaths = [manifestName, ...manifest.files.map((entry) => entry.path)]
    .map((relative) => `${archiveRoot}/${relative}`).sort(compareCodepoints);
  if (JSON.stringify([...archiveFiles.keys()].sort(compareCodepoints)) !== JSON.stringify(expectedArchivePaths)) {
    throw new Error("Release archive violates the public package file allowlist.");
  }
  for (const entry of manifest.files) {
    const contents = archiveFiles.get(`${archiveRoot}/${entry.path}`);
    if (!contents || digest(contents) !== entry.sha256) throw new Error(`Release archive package checksum mismatch: ${entry.path}`);
  }
  if (JSON.stringify(manifest.source) !== JSON.stringify(evidence.source)) {
    throw new Error("Release archive source provenance does not match its evidence.");
  }
  const archivedPackage = archiveFiles.get(`${archiveRoot}/package.json`);
  const archivedLock = archiveFiles.get(`${archiveRoot}/package-lock.json`);
  const archivedIntent = archiveFiles.get(`${archiveRoot}/${releaseIntentName}`);
  if (!archivedPackage || !archivedLock || !archivedIntent) {
    throw new Error("Release archive is missing application version ownership files.");
  }
  const archivedVersion = validateReleaseDocuments(
    JSON.parse(archivedPackage),
    JSON.parse(archivedLock),
    JSON.parse(archivedIntent),
    "Release archive",
  );
  if (archivedVersion !== evidence.version) {
    throw new Error("Release archive application version does not match its evidence.");
  }

  const runtime = inspectRuntimeArchive(artifactContents.get(evidence.runtime.file), {
    allowDirty: evidence.source.state !== "clean",
  });
  const runtimeManifestEntry = runtime.files.get(runtimeManifestName);
  if (!runtimeManifestEntry || digest(runtimeManifestEntry.contents) !== evidence.runtime.manifest.sha256
      || runtime.manifest.files.length !== evidence.runtime.manifest.entries
      || runtime.manifest.version !== evidence.version
      || JSON.stringify(runtime.manifest.source) !== JSON.stringify(evidence.source)) {
    throw new Error("Release runtime manifest does not match its evidence.");
  }
  const runtimePackage = runtime.files.get("package.json");
  const runtimeLock = runtime.files.get("package-lock.json");
  if (!runtimePackage || !runtimeLock
      || validateApplicationDocuments(
        JSON.parse(runtimePackage.contents),
        JSON.parse(runtimeLock.contents),
        "Release runtime",
      ) !== evidence.version) {
    throw new Error("Release runtime application version does not match its evidence.");
  }
  const installerSource = manifest.files.find((entry) => entry.path === "scripts/devhub-install.mjs");
  if (!installerSource || installerSource.sha256 !== evidence.installer.sourceSha256
      || digest(artifactContents.get(evidence.installer.file)) !== installerSource.sha256) {
    throw new Error("Release installer does not match the sanitized public snapshot.");
  }

  const checksumEntries = parseChecksums(await readFile(path.join(root, checksumsName), "utf8"));
  const expectedChecksums = [
    ...artifactEntries.map((entry) => ({ file: entry.file, sha256: entry.sha256 })),
    { file: evidenceName, sha256: digest(evidenceContents) },
  ].sort((left, right) => compareCodepoints(left.file, right.file));
  if (JSON.stringify(checksumEntries) !== JSON.stringify(expectedChecksums)) {
    throw new Error(`${checksumsName} does not match the release artifacts.`);
  }
  return { version: evidence.version, files: actualFiles.length, source: evidence.source };
}

export async function buildReleaseArtifacts({
  snapshot: inputSnapshot,
  output: inputOutput,
  allowDirty = false,
  fingerprintFile = null,
  intendedVersion = null,
}) {
  const snapshot = await realpath(path.resolve(inputSnapshot));
  const snapshotStat = await lstat(snapshot);
  if (!snapshotStat.isDirectory() || snapshotStat.isSymbolicLink()) throw new Error("Release snapshot must be a real directory.");
  const excludedTopLevels = new Set([".git", ".next", ".vinext", ".wrangler", "dist", "node_modules"]);
  const rootEntries = (await readdir(snapshot)).filter((entry) => !excludedTopLevels.has(entry));
  const verificationRoot = await mkdtemp(path.join(path.dirname(snapshot), ".devhub-release-verify-"));
  try {
    for (const entry of rootEntries) {
      const source = path.join(snapshot, entry);
      const details = await lstat(source);
      if (details.isSymbolicLink()) throw new Error(`${entry}: symbolic links are not allowed`);
      await cp(source, path.join(verificationRoot, entry), {
        recursive: details.isDirectory(),
        preserveTimestamps: false,
      });
    }
    await scanPublicExport(verificationRoot, { fingerprintFile });
    await verifyPublicManifest(verificationRoot);
  } finally {
    await rm(verificationRoot, { recursive: true, force: true });
  }
  const expectedVersion = await resolveIntendedVersion(intendedVersion);
  const snapshotVersion = await readApplicationReleaseVersion(snapshot);
  if (snapshotVersion !== expectedVersion) {
    throw new Error(`Generated public snapshot application version ${snapshotVersion} does not match intended application version ${expectedVersion}.`);
  }
  const manifestContents = await readFile(path.join(snapshot, manifestName));
  const manifest = JSON.parse(manifestContents);
  if (!allowDirty && manifest.source.state !== "clean") throw new Error("Release evidence requires a clean public snapshot.");
  const packageDocument = JSON.parse(await readFile(path.join(snapshot, "package.json"), "utf8"));
  const fingerprintPolicySha256 = fingerprintFile ? digest(await readFile(fingerprintFile)) : null;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(packageDocument.name ?? "")
      || !semanticVersionPattern.test(packageDocument.version ?? "")) {
    throw new Error("Public package name or version is not release-safe.");
  }

  const requestedOutput = path.resolve(inputOutput);
  const outputParent = path.dirname(requestedOutput);
  await mkdir(outputParent, { recursive: true });
  const canonicalParent = await realpath(outputParent);
  const output = path.join(canonicalParent, path.basename(requestedOutput));
  if (isInside(snapshot, output) || isInside(output, snapshot)) throw new Error("Release evidence output must be outside the public snapshot.");
  const existing = await statIfPresent(output);
  if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) throw new Error("Release evidence output must be a real directory.");
  if (existing && (await readdir(output)).length) throw new Error(`Release evidence output must be empty: ${output}`);

  const archiveRoot = `${packageDocument.name}-v${packageDocument.version}`;
  const archiveName = `${archiveRoot}-source.tar.gz`;
  const runtimeName = `devhub-cli-v${packageDocument.version}.tar.gz`;
  const installerName = `devhub-install-v${packageDocument.version}.mjs`;
  const sbomName = `${archiveRoot}-sbom.cdx.json`;
  const relativeFiles = [manifestName, ...manifest.files.map((entry) => entry.path)].sort(compareCodepoints);
  const staging = await mkdtemp(path.join(canonicalParent, ".devhub-release-staging-"));
  let activeStaging = staging;
  try {
    const archive = await createSourceArchive(snapshot, archiveRoot, relativeFiles);
    const runtime = await buildRuntimePackage(snapshot, manifest, packageDocument, canonicalParent, fingerprintFile);
    const installer = await readFile(path.join(snapshot, "scripts/devhub-install.mjs"));
    const sbom = runtime.sbom;
    await writeFile(path.join(staging, archiveName), archive);
    await writeFile(path.join(staging, runtimeName), runtime.archive);
    await writeFile(path.join(staging, installerName), installer, { mode: 0o755 });
    await writeFile(path.join(staging, sbomName), sbom);
    const evidence = {
      formatVersion: 3,
      packageName: packageDocument.name,
      version: packageDocument.version,
      source: manifest.source,
      packageAllowlist: {
        file: manifestName,
        entries: manifest.files.length,
        sha256: digest(manifestContents),
      },
      privacy: {
        status: "passed",
        scanner: "scripts/scan-public-export.mjs",
        scopes: ["public-source", "user-runtime"],
        fingerprintPolicySha256,
      },
      archive: { file: archiveName, sha256: digest(archive) },
      runtime: {
        file: runtimeName,
        sha256: digest(runtime.archive),
        manifest: { file: runtimeManifestName, entries: runtime.manifest.files.length, sha256: digest(runtime.manifestContents) },
      },
      installer: { file: installerName, sha256: digest(installer), sourceSha256: digest(installer) },
      sbom: { file: sbomName, format: "CycloneDX-1.5", sha256: digest(sbom) },
    };
    const releaseEvidenceContents = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
    await writeFile(path.join(staging, evidenceName), releaseEvidenceContents);
    const sums = [
      { file: archiveName, sha256: evidence.archive.sha256 },
      { file: runtimeName, sha256: evidence.runtime.sha256 },
      { file: installerName, sha256: evidence.installer.sha256 },
      { file: sbomName, sha256: evidence.sbom.sha256 },
      { file: evidenceName, sha256: digest(releaseEvidenceContents) },
    ].sort((left, right) => compareCodepoints(left.file, right.file));
    await writeFile(path.join(staging, checksumsName), `${sums.map((entry) => `${entry.sha256}  ${entry.file}`).join("\n")}\n`);
    await verifyReleaseArtifacts(staging, { intendedVersion: expectedVersion });
    if (existing) await rmdir(output);
    await rename(staging, output);
    activeStaging = null;
    return { output, version: packageDocument.version, files: 6 };
  } finally {
    if (activeStaging) await rm(activeStaging, { recursive: true, force: true });
  }
}
