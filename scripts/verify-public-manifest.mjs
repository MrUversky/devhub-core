#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const manifestName = "PUBLIC_EXPORT_MANIFEST.json";

function compareCodepoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toPosix(relative) {
  return relative.split(path.sep).join("/");
}

function validateRelativePath(relative) {
  return typeof relative === "string"
    && relative !== ""
    && !relative.includes("\\")
    && !path.posix.isAbsolute(relative)
    && path.posix.normalize(relative) === relative
    && relative !== ".."
    && !relative.startsWith("../");
}

async function collectFiles(root) {
  const files = [];
  async function walk(directory) {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => compareCodepoints(left.name, right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = toPosix(path.relative(root, absolute));
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`${relative}: symbolic links are not allowed`);
      if (stat.isDirectory()) {
        await walk(absolute);
      } else if (stat.isFile()) {
        if (relative !== manifestName) {
          const sha256 = createHash("sha256").update(await readFile(absolute)).digest("hex");
          files.push({ path: relative, sha256 });
        }
      } else {
        throw new Error(`${relative}: special files are not allowed`);
      }
    }
  }
  await walk(root);
  return files.sort((left, right) => compareCodepoints(left.path, right.path));
}

export async function verifyPublicManifest(directory) {
  const root = path.resolve(directory);
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Public export root must be a real directory.");
  }

  const manifestPath = path.join(root, manifestName);
  const manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error(`${manifestName} must be a regular file.`);
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.manifestVersion !== 2 || manifest.exporterVersion !== 1) {
    throw new Error("Unsupported public export manifest version.");
  }
  if (!manifest.source || typeof manifest.source !== "object"
      || !new Set(["clean", "dirty-explicit-allowlist"]).has(manifest.source.state)) {
    throw new Error("Public export manifest has an invalid source state.");
  }
  const validCommit = /^[a-f0-9]{40,64}$/.test(manifest.source.commit ?? "");
  if ((!validCommit && manifest.source.state === "clean")
      || (!validCommit && manifest.source.commit !== null)) {
    throw new Error("Public export manifest has invalid source provenance.");
  }
  if (!Array.isArray(manifest.files)) throw new Error("Public export manifest files must be an array.");

  const expected = [];
  const seen = new Set();
  for (const [index, file] of manifest.files.entries()) {
    if (!file || !validateRelativePath(file.path)) {
      throw new Error(`Public export manifest files[${index}].path is invalid.`);
    }
    if (!/^[a-f0-9]{64}$/.test(file.sha256 ?? "")) {
      throw new Error(`Public export manifest files[${index}].sha256 is invalid.`);
    }
    if (file.path === manifestName) throw new Error(`${manifestName} cannot list itself.`);
    if (seen.has(file.path)) throw new Error(`Public export manifest duplicates ${file.path}.`);
    seen.add(file.path);
    expected.push({ path: file.path, sha256: file.sha256 });
  }
  const sortedExpected = [...expected].sort((left, right) => compareCodepoints(left.path, right.path));
  if (JSON.stringify(expected) !== JSON.stringify(sortedExpected)) {
    throw new Error("Public export manifest files are not codepoint-sorted.");
  }

  const actual = await collectFiles(root);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const actualPaths = new Set(actual.map((file) => file.path));
    const expectedPaths = new Set(expected.map((file) => file.path));
    const missing = expected.filter((file) => !actualPaths.has(file.path)).map((file) => file.path);
    const unexpected = actual.filter((file) => !expectedPaths.has(file.path)).map((file) => file.path);
    const changed = actual
      .filter((file) => expectedPaths.has(file.path) && expected.find((item) => item.path === file.path)?.sha256 !== file.sha256)
      .map((file) => file.path);
    throw new Error([
      "Public export manifest verification failed.",
      missing.length ? `Missing: ${missing.join(", ")}` : null,
      unexpected.length ? `Unexpected: ${unexpected.join(", ")}` : null,
      changed.length ? `Changed: ${changed.join(", ")}` : null,
    ].filter(Boolean).join("\n"));
  }
  return { files: actual.length, source: manifest.source };
}

const invokedAsScript = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedAsScript) {
  const target = process.argv[2] ?? ".";
  const result = await verifyPublicManifest(target);
  console.log(`public export manifest: verified (${result.files} files, ${result.source.commit ?? "commit unavailable"})`);
}
