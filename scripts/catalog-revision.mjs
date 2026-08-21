import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function relativeInside(root, target) {
  const relative = path.relative(root, target);
  if (relative === "") return ".";
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

async function nearestExistingDirectory(target) {
  let current = path.resolve(target);
  while (true) {
    try {
      const details = await lstat(current);
      return details.isDirectory() ? current : path.dirname(current);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function canonicalPotentialPath(target) {
  const resolved = path.resolve(target);
  try {
    return await realpath(resolved);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const existing = await nearestExistingDirectory(resolved);
  if (!existing) return resolved;
  return path.join(await realpath(existing), path.relative(existing, resolved));
}

async function defaultRunGit(cwd, args) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

async function optionalGit(runGit, cwd, args) {
  try {
    return await runGit(cwd, args);
  } catch {
    return null;
  }
}

async function catalogFingerprint(catalogDirectory, destinationState) {
  const files = [];
  if (destinationState === "nonempty") {
    const hostsPath = path.join(catalogDirectory, "hosts.yaml");
    const hostsDetails = await lstat(hostsPath);
    if (!hostsDetails.isFile() || hostsDetails.isSymbolicLink()) throw new Error("catalog hosts.yaml must be a regular file");
    files.push({ path: "hosts.yaml", contents: await readFile(hostsPath) });

    const projectDirectory = path.join(catalogDirectory, "projects");
    const projectDetails = await lstat(projectDirectory);
    if (!projectDetails.isDirectory() || projectDetails.isSymbolicLink()) throw new Error("catalog projects must be a regular directory");
    const projectFiles = (await readdir(projectDirectory)).filter((file) => file.endsWith(".yaml")).sort();
    for (const file of projectFiles) {
      const filename = path.join(projectDirectory, file);
      const details = await lstat(filename);
      if (!details.isFile() || details.isSymbolicLink()) throw new Error(`catalog project ${file} must be a regular file`);
      files.push({ path: `projects/${file}`, contents: await readFile(filename) });
    }
  }
  const hash = createHash("sha256");
  hash.update(`${destinationState}\0`);
  for (const file of files) {
    hash.update(`${file.path}\0${file.contents.length}\0`);
    hash.update(file.contents);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

async function generatedBinding(repositoryRoot, paths) {
  const repositoryOutputs = await Promise.all(paths.generatedOutputs.map(async (filename) => relativeInside(repositoryRoot, await canonicalPotentialPath(filename))));
  if (repositoryOutputs.every(Boolean)) {
    const configuredDirectory = paths.generatedDirectory
      ? relativeInside(repositoryRoot, await canonicalPotentialPath(paths.generatedDirectory))
      : null;
    return Object.freeze({
      mode: "repository",
      paths: Object.freeze(repositoryOutputs),
      configuredDirectory,
    });
  }
  return Object.freeze({
    mode: "ephemeral",
    paths: Object.freeze(["app-catalog.json", "public-catalog.json"]),
    configuredDirectory: null,
  });
}

async function connectionProfileBinding(repositoryRoot, paths) {
  const relative = relativeInside(repositoryRoot, await canonicalPotentialPath(paths.connectionProfilesPath));
  return relative
    ? Object.freeze({ mode: "repository", path: relative })
    : Object.freeze({ mode: "none", path: null });
}

export async function inspectCatalogRevision(paths, destinationState, options = {}) {
  const catalogDirectory = path.resolve(paths.catalogDirectory);
  const fingerprint = await catalogFingerprint(catalogDirectory, destinationState);
  const probeDirectory = await nearestExistingDirectory(catalogDirectory);
  const runGit = options.runGit ?? defaultRunGit;
  if (!probeDirectory) {
    return Object.freeze({
      repositoryRoot: null,
      binding: Object.freeze({
        version: 1,
        state: "unbound",
        reason: "catalog-not-in-git-repository",
        catalogState: destinationState,
        catalogFingerprint: fingerprint,
      }),
    });
  }

  try {
    const discoveredRoot = await runGit(probeDirectory, ["rev-parse", "--show-toplevel"]);
    const repositoryRoot = await realpath(discoveredRoot);
    const catalogPath = relativeInside(repositoryRoot, await canonicalPotentialPath(catalogDirectory));
    if (!catalogPath || catalogPath === ".git" || catalogPath.startsWith(".git/")) throw new Error("catalog directory is outside the Git working tree");
    const commonDirectoryOutput = await runGit(repositoryRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const commonDirectory = await realpath(commonDirectoryOutput);
    const baseRevision = await runGit(repositoryRoot, ["rev-parse", "HEAD"]);
    if (!/^[a-f0-9]{40,64}$/.test(baseRevision)) throw new Error("catalog repository HEAD is invalid");
    const origin = await optionalGit(runGit, repositoryRoot, ["config", "--get", "remote.origin.url"]);
    const repositoryId = digest(JSON.stringify({ commonDirectory, origin }));
    return Object.freeze({
      repositoryRoot,
      binding: Object.freeze({
        version: 1,
        state: "bound",
        repositoryId,
        baseRevision,
        catalogPath,
        catalogState: destinationState,
        catalogFingerprint: fingerprint,
        generated: await generatedBinding(repositoryRoot, paths),
        connectionProfiles: await connectionProfileBinding(repositoryRoot, paths),
      }),
    });
  } catch (error) {
    const reason = error?.code === "ENOENT" ? "git-unavailable" : "catalog-not-in-git-repository";
    return Object.freeze({
      repositoryRoot: null,
      binding: Object.freeze({
        version: 1,
        state: "unbound",
        reason,
        catalogState: destinationState,
        catalogFingerprint: fingerprint,
      }),
    });
  }
}
