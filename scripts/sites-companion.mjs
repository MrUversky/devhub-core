import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { stringify } from "yaml";
import {
  createSitesCompanionPlan,
  parseSitesCompanionBinding,
  sanitizeSitesCompanionCatalog,
  SitesCompanionError,
} from "../lib/sites-companion.mjs";
import { inspectCatalogRevision } from "./catalog-revision.mjs";
import { readSourceCatalog } from "./catalog-tools.mjs";

const execFileAsync = promisify(execFile);
const SOURCE_MANIFEST = "PUBLIC_EXPORT_MANIFEST.json";
const SHA256_PATTERN = /^(?:sha256:)?([a-f0-9]{64})$/;
const REVISION_PATTERN = /^[a-f0-9]{40,64}$/;
const EXCLUDED_ROUTES = new Set([
  "app/api/context/route.ts",
  "app/api/status/route.ts",
  "app/mcp/route.ts",
]);

function invalid(code, message) {
  throw new SitesCompanionError(code, message);
}

function digest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function digestArgument(value, label) {
  const match = typeof value === "string" ? value.toLowerCase().match(SHA256_PATTERN) : null;
  if (!match) invalid("sites-companion-arguments-invalid", `${label} must be a SHA-256 digest`);
  return match[1];
}

function exactRevision(value, label) {
  if (typeof value !== "string" || !REVISION_PATTERN.test(value)) {
    invalid("sites-companion-arguments-invalid", `${label} must be an exact Git commit`);
  }
  return value;
}

function safeManifestPath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || path.posix.isAbsolute(value)) return null;
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) return null;
  return normalized;
}

function isInside(parent, candidate) {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

function option(argumentsList, name, { required = false, absolute = false } = {}) {
  const values = [];
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === name) {
      const value = argumentsList[index + 1];
      if (!value || value.startsWith("--")) invalid("sites-companion-arguments-invalid", `${name} needs a value`);
      values.push(value);
      index += 1;
    } else if (argument.startsWith(`${name}=`)) {
      const value = argument.slice(name.length + 1);
      if (!value) invalid("sites-companion-arguments-invalid", `${name} needs a value`);
      values.push(value);
    }
  }
  if (values.length > 1) invalid("sites-companion-arguments-invalid", `${name} may be specified only once`);
  if (required && !values.length) invalid("sites-companion-arguments-invalid", `${name} is required`);
  if (!values.length) return null;
  if (absolute && !path.isAbsolute(values[0])) invalid("sites-companion-arguments-invalid", `${name} must be an absolute path`);
  return absolute ? path.normalize(values[0]) : values[0];
}

export function parseSitesCompanionArguments(argumentsList) {
  const supportedFlags = new Set(["--apply", "--json"]);
  const supportedOptions = new Set([
    "--source-dir",
    "--source-tag",
    "--source-manifest-sha256",
    "--catalog-revision",
    "--status-api-origin",
    "--staging-dir",
    "--binding-file",
  ]);
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    const name = argument.includes("=") ? argument.slice(0, argument.indexOf("=")) : argument;
    if (supportedFlags.has(argument)) continue;
    if (!supportedOptions.has(name)) invalid("sites-companion-arguments-invalid", `sites-companion does not accept ${argument}`);
    if (!argument.includes("=")) index += 1;
  }
  return Object.freeze({
    sourceDirectory: option(argumentsList, "--source-dir", { required: true, absolute: true }),
    releaseTag: option(argumentsList, "--source-tag", { required: true }),
    sourceManifestSha256: digestArgument(option(argumentsList, "--source-manifest-sha256", { required: true }), "--source-manifest-sha256"),
    catalogRevision: exactRevision(option(argumentsList, "--catalog-revision", { required: true }), "--catalog-revision"),
    statusApiOrigin: option(argumentsList, "--status-api-origin", { required: true }),
    stagingDirectory: option(argumentsList, "--staging-dir", { required: true, absolute: true }),
    bindingFilename: option(argumentsList, "--binding-file", { absolute: true }),
    apply: argumentsList.includes("--apply"),
    json: argumentsList.includes("--json"),
  });
}

async function verifyRegularFile(root, relativePath, expectedDigest) {
  const filename = path.join(root, ...relativePath.split("/"));
  const details = await lstat(filename);
  if (!details.isFile() || details.isSymbolicLink()) invalid("sites-companion-source-invalid", `${relativePath} must be a regular source file`);
  const contents = await readFile(filename);
  if (digest(contents) !== expectedDigest) invalid("sites-companion-source-drift", `${relativePath} does not match the verified public manifest`);
  return Object.freeze({ relativePath, filename, contents });
}

async function verifyPublicSource(parsed) {
  const sourceDirectory = await realpath(parsed.sourceDirectory);
  const manifestFilename = path.join(sourceDirectory, SOURCE_MANIFEST);
  const manifestContents = await readFile(manifestFilename);
  if (digest(manifestContents) !== parsed.sourceManifestSha256) {
    invalid("sites-companion-source-drift", `${SOURCE_MANIFEST} does not match --source-manifest-sha256`);
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestContents);
  } catch {
    invalid("sites-companion-source-invalid", `${SOURCE_MANIFEST} is not valid JSON`);
  }
  if (manifest?.manifestVersion !== 2 || manifest?.source?.state !== "clean"
      || !REVISION_PATTERN.test(manifest?.source?.commit) || !Array.isArray(manifest?.files) || !manifest.files.length) {
    invalid("sites-companion-source-invalid", `${SOURCE_MANIFEST} is not a clean version 2 public export manifest`);
  }
  const packageDocument = JSON.parse(await readFile(path.join(sourceDirectory, "package.json"), "utf8"));
  if (parsed.releaseTag !== `v${packageDocument.version}`) {
    invalid("sites-companion-source-drift", `--source-tag must match the exact source version v${packageDocument.version}`);
  }
  const seen = new Set();
  const files = [];
  for (const entry of manifest.files) {
    const relativePath = safeManifestPath(entry?.path);
    if (!relativePath || seen.has(relativePath) || !SHA256_PATTERN.test(entry?.sha256)) {
      invalid("sites-companion-source-invalid", `${SOURCE_MANIFEST} contains an invalid or duplicate file entry`);
    }
    if (relativePath === ".openai/hosting.json" || relativePath.startsWith("plugins/devhub-private-profile/")
        || relativePath === "config/connection-profiles.json") {
      invalid("sites-companion-source-invalid", `${SOURCE_MANIFEST} contains forbidden owner-specific source`);
    }
    seen.add(relativePath);
    files.push(await verifyRegularFile(sourceDirectory, relativePath, entry.sha256.replace(/^sha256:/, "")));
  }
  return Object.freeze({
    sourceDirectory,
    manifestFilename,
    manifestContents,
    sourceCommit: manifest.source.commit,
    files: Object.freeze(files),
  });
}

async function readOptionalBinding(filename) {
  if (!filename) return null;
  try {
    return parseSitesCompanionBinding(JSON.parse(await readFile(filename, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof SitesCompanionError) throw error;
    invalid("sites-companion-binding-invalid", `${filename} is not valid companion binding JSON`);
  }
}

async function verifyCatalog(root, paths, expectedRevision) {
  const sourceCatalog = await readSourceCatalog(root, { paths });
  const revision = await inspectCatalogRevision(paths, "nonempty");
  if (revision.binding.state !== "bound") invalid("sites-companion-catalog-unbound", "the reviewed catalog must be in a Git repository");
  if (revision.binding.baseRevision !== expectedRevision) {
    invalid("sites-companion-catalog-drift", `the catalog is at ${revision.binding.baseRevision}, not the reviewed ${expectedRevision}`);
  }
  const { stdout } = await execFileAsync("git", ["-C", revision.repositoryRoot, "status", "--porcelain=v1", "--untracked-files=all"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (stdout.trim()) invalid("sites-companion-catalog-dirty", "the reviewed catalog repository must be clean before staging");
  return Object.freeze({ sourceCatalog, revision });
}

async function verifyStagingBoundary(root, parsed, verifiedSource, revision) {
  const parent = path.dirname(parsed.stagingDirectory);
  let canonicalParent;
  try {
    canonicalParent = await realpath(parent);
  } catch (error) {
    if (error?.code === "ENOENT") {
      invalid("sites-companion-staging-invalid", "--staging-dir parent must already exist inside the operating-system temporary directory");
    }
    throw error;
  }
  const canonicalStaging = path.join(canonicalParent, path.basename(parsed.stagingDirectory));
  const [temporaryRoot, runtimeRoot, catalogRoot] = await Promise.all([
    realpath(os.tmpdir()),
    realpath(root),
    realpath(revision.repositoryRoot),
  ]);
  if (!isInside(temporaryRoot, canonicalStaging) || canonicalStaging === temporaryRoot) {
    invalid("sites-companion-staging-invalid", "--staging-dir must be a fresh child of the operating-system temporary directory");
  }
  for (const [label, protectedRoot] of [
    ["verified public source", verifiedSource.sourceDirectory],
    ["catalog repository", catalogRoot],
    ["DevHub runtime/source checkout", runtimeRoot],
  ]) {
    if (isInside(protectedRoot, canonicalStaging) || isInside(canonicalStaging, protectedRoot)) {
      invalid("sites-companion-staging-invalid", `--staging-dir must remain outside the ${label}`);
    }
  }
  return Object.freeze({ ...parsed, stagingDirectory: canonicalStaging });
}

function excludedFromCompanion(relativePath) {
  return EXCLUDED_ROUTES.has(relativePath)
    || relativePath === ".devhub-public-snapshot"
    || relativePath === "app/generated/catalog.json"
    || relativePath === "public/catalog.json"
    || relativePath === SOURCE_MANIFEST
    || relativePath === "config/connection-profiles.json"
    || relativePath.startsWith("catalog/");
}

async function writeSanitizedCatalog(stagingRoot, catalog) {
  const catalogRoot = path.join(stagingRoot, "catalog");
  const projectRoot = path.join(catalogRoot, "projects");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(catalogRoot, "hosts.yaml"), stringify({ version: 1, hosts: catalog.hosts }, { lineWidth: 0 }));
  await Promise.all(catalog.projects.map((project) => writeFile(
    path.join(projectRoot, `${project.id}.yaml`),
    stringify(project, { lineWidth: 0 }),
  )));
}

async function stageCompanion(parsed, verifiedSource, sanitizedCatalog, result) {
  try {
    await lstat(parsed.stagingDirectory);
    invalid("sites-companion-staging-exists", "--staging-dir must be a fresh path that does not exist");
  } catch (error) {
    if (error instanceof SitesCompanionError) throw error;
    if (error?.code !== "ENOENT") throw error;
  }
  const parent = path.dirname(parsed.stagingDirectory);
  const temporary = await mkdtemp(path.join(parent, ".devhub-sites-companion-"));
  try {
    for (const file of verifiedSource.files) {
      if (excludedFromCompanion(file.relativePath)) continue;
      const destination = path.join(temporary, ...file.relativePath.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(file.filename, destination);
    }
    await writeSanitizedCatalog(temporary, sanitizedCatalog);
    const provenance = path.join(temporary, ".devhub-sites-provenance");
    await mkdir(provenance, { recursive: true });
    await copyFile(verifiedSource.manifestFilename, path.join(provenance, SOURCE_MANIFEST));
    await writeFile(path.join(temporary, ".devhub-sites-companion"), "owner-only\n");
    await writeFile(path.join(temporary, "SITES-COMPANION-MANIFEST.json"), `${JSON.stringify({
      version: 1,
      kind: "devhub-sites-companion-staging",
      source: result.source,
      catalog: result.catalog,
      backend: result.backend,
      excludedRoutes: [...EXCLUDED_ROUTES].sort(),
      excludedOwnerData: ["profiles", "credentials", "workspaces", "private-context", "urls", "commands", "probes", "readiness", "stewardship"],
      requiredRuntime: {
        DEVHUB_SITES_COMPANION: "owner-only",
        DEVHUB_STATUS_API_BASE_URL: result.backend.statusApiOrigin,
      },
      hostingMetadata: "add only inside this staging tree after Sites create/reuse",
    }, null, 2)}\n`);
    await rename(temporary, parsed.stagingDirectory);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function runSitesCompanion(root, argumentsList, options) {
  const requested = parseSitesCompanionArguments(argumentsList);
  const [verifiedSource, binding] = await Promise.all([
    verifyPublicSource(requested),
    readOptionalBinding(requested.bindingFilename),
  ]);
  const { sourceCatalog, revision } = await verifyCatalog(root, options.paths, requested.catalogRevision);
  const parsed = await verifyStagingBoundary(root, requested, verifiedSource, revision);
  const sanitizedCatalog = sanitizeSitesCompanionCatalog(sourceCatalog);
  const plan = createSitesCompanionPlan({
    apply: parsed.apply,
    source: {
      releaseTag: parsed.releaseTag,
      sourceCommit: verifiedSource.sourceCommit,
      manifestSha256: parsed.sourceManifestSha256,
    },
    catalog: {
      revision: revision.binding.baseRevision,
      fingerprint: revision.binding.catalogFingerprint,
    },
    statusApiOrigin: parsed.statusApiOrigin,
    binding,
  });
  const result = Object.freeze({
    ...plan,
    staging: Object.freeze({
      directory: parsed.stagingDirectory,
      writes: parsed.apply,
      sourceFilesVerified: verifiedSource.files.length,
      projectCount: sanitizedCatalog.projects.length,
      serviceCount: sanitizedCatalog.projects.reduce((sum, project) => sum + project.services.length, 0),
      hostingMetadataPresent: false,
    }),
  });
  if (parsed.apply) await stageCompanion(parsed, verifiedSource, sanitizedCatalog, result);
  return Object.freeze({ parsed, result });
}

export function formatSitesCompanion(result) {
  const action = result.site.action === "reuse" ? "reuse the bound private Site" : "create one private Site in the invoking account";
  const first = result.readOnly ? "Sites companion preview" : "Sites companion staged";
  return `${first}: ${result.staging.projectCount} projects / ${result.staging.serviceCount} services; ${action}.\n`
    + `Source ${result.source.releaseTag} and catalog ${result.catalog.revision} are exact. Publish remains a separate explicit approval.`;
}
