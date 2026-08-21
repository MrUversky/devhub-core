import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const runtimeManifestName = "DEVHUB_RUNTIME_MANIFEST.json";
const globalPathOptions = new Map([
  ["--catalog-dir", "catalogDirectory"],
  ["--connection-profiles-file", "connectionProfilesFile"],
  ["--generated-dir", "generatedDirectory"],
  ["--instance-config", "instanceConfigPath"],
]);
const instanceConfigFields = new Set([
  "version",
  "catalogDirectory",
  "connectionProfilesFile",
  "generatedDirectory",
]);

export class DevHubConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DevHubConfigError";
    this.code = code;
  }
}

function invalid(code, message) {
  throw new DevHubConfigError(code, message);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function absoluteConfiguredPath(value, label) {
  const normalized = nonEmpty(value);
  if (!normalized || !path.isAbsolute(normalized)) {
    invalid("instance-config-invalid", `${label} must be an absolute path`);
  }
  return path.normalize(normalized);
}

function environmentPath(value) {
  const normalized = nonEmpty(value);
  return normalized ? path.resolve(normalized) : null;
}

export function resolveUserDevHubPaths(environment = {}, options = {}) {
  const homeDirectory = path.resolve(options.homeDirectory ?? os.homedir());
  const dataHome = path.resolve(nonEmpty(environment.XDG_DATA_HOME) ?? path.join(homeDirectory, ".local/share"));
  const configHome = path.resolve(nonEmpty(environment.XDG_CONFIG_HOME) ?? path.join(homeDirectory, ".config"));
  const dataRoot = path.join(dataHome, "devhub");
  const configRoot = path.join(configHome, "devhub");
  return Object.freeze({
    dataRoot,
    configRoot,
    runtimeDirectory: path.join(dataRoot, "runtime"),
    catalogDirectory: path.join(dataRoot, "catalog"),
    generatedDirectory: path.join(dataRoot, "generated"),
    connectionProfilesPath: path.join(configRoot, "connection-profiles.json"),
    instanceConfigPath: path.join(configRoot, "instance.json"),
  });
}

export function isInstalledRuntimeRoot(root) {
  return existsSync(path.join(path.resolve(root), runtimeManifestName));
}

export function parseGlobalPathArguments(argumentsList) {
  const values = {};
  const args = [];
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    const separator = argument.indexOf("=");
    const option = separator === -1 ? argument : argument.slice(0, separator);
    const field = globalPathOptions.get(option);
    if (!field) {
      args.push(argument);
      continue;
    }
    if (Object.hasOwn(values, field)) invalid("path-option-invalid", `${option} may be specified only once`);
    const raw = separator === -1 ? argumentsList[++index] : argument.slice(separator + 1);
    if (typeof raw !== "string" || raw.startsWith("--") || !path.isAbsolute(raw)) {
      invalid("path-option-invalid", `${option} requires one absolute path`);
    }
    values[field] = path.normalize(raw);
  }
  return Object.freeze({ args: Object.freeze(args), pathOptions: Object.freeze(values) });
}

function validateInstanceConfig(document) {
  if (!document || typeof document !== "object" || Array.isArray(document) || document.version !== 1) {
    invalid("instance-config-invalid", "DevHub instance configuration must be a version 1 JSON object");
  }
  const extra = Object.keys(document).filter((field) => !instanceConfigFields.has(field));
  if (extra.length) invalid("instance-config-invalid", `DevHub instance configuration contains unsupported fields: ${extra.join(", ")}`);
  const result = { version: 1 };
  for (const field of ["catalogDirectory", "connectionProfilesFile", "generatedDirectory"]) {
    if (document[field] !== undefined) result[field] = absoluteConfiguredPath(document[field], field);
  }
  return Object.freeze(result);
}

async function readInstanceConfig(filename, { required = false } = {}) {
  let contents;
  try {
    contents = await readFile(filename, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" && !required) return null;
    if (error?.code === "ENOENT") invalid("instance-config-missing", `DevHub instance configuration is missing: ${filename}`);
    throw error;
  }
  try {
    return validateInstanceConfig(JSON.parse(contents));
  } catch (error) {
    if (error instanceof DevHubConfigError) throw error;
    invalid("instance-config-invalid", `DevHub instance configuration is not valid JSON: ${filename}`);
  }
}

export function resolveDevHubPaths(root = process.cwd(), environment = {}, options = {}) {
  const resolvedRoot = path.resolve(root);
  const installed = options.installed ?? isInstalledRuntimeRoot(resolvedRoot);
  const user = resolveUserDevHubPaths(environment, options);
  const pathOptions = options.pathOptions ?? {};
  const instanceConfig = options.instanceConfig ?? {};
  const catalogDirectory = path.resolve(
    pathOptions.catalogDirectory
      ?? environmentPath(environment.DEVHUB_CATALOG_DIR)
      ?? instanceConfig.catalogDirectory
      ?? (installed ? user.catalogDirectory : path.join(resolvedRoot, "catalog")),
  );
  const connectionProfilesPath = path.resolve(
    pathOptions.connectionProfilesFile
      ?? environmentPath(environment.DEVHUB_CONNECTION_PROFILES_FILE)
      ?? instanceConfig.connectionProfilesFile
      ?? (installed ? user.connectionProfilesPath : path.join(resolvedRoot, "config/connection-profiles.json")),
  );
  const configuredGeneratedDirectory = pathOptions.generatedDirectory
    ?? environmentPath(environment.DEVHUB_GENERATED_DIR)
    ?? instanceConfig.generatedDirectory
    ?? (installed ? user.generatedDirectory : null);
  const generatedDirectory = configuredGeneratedDirectory ? path.resolve(configuredGeneratedDirectory) : null;
  const generatedOutputs = generatedDirectory
    ? [path.join(generatedDirectory, "app-catalog.json"), path.join(generatedDirectory, "public-catalog.json")]
    : [path.join(resolvedRoot, "app/generated/catalog.json"), path.join(resolvedRoot, "public/catalog.json")];
  const explicitInstanceConfigPath = pathOptions.instanceConfigPath ?? environmentPath(environment.DEVHUB_INSTANCE_CONFIG);
  const instanceConfigPath = explicitInstanceConfigPath ?? (installed ? user.instanceConfigPath : null);
  return Object.freeze({
    root: resolvedRoot,
    installed,
    runtimeManifestPath: path.join(resolvedRoot, runtimeManifestName),
    instanceConfigPath,
    catalogDirectory,
    hostsPath: path.join(catalogDirectory, "hosts.yaml"),
    projectDirectory: path.join(catalogDirectory, "projects"),
    connectionProfilesPath,
    generatedDirectory,
    generatedOutputs: Object.freeze(generatedOutputs),
  });
}

export async function loadDevHubPaths(root = process.cwd(), environment = {}, options = {}) {
  const resolvedRoot = path.resolve(root);
  const installed = options.installed ?? isInstalledRuntimeRoot(resolvedRoot);
  const user = resolveUserDevHubPaths(environment, options);
  const explicitConfig = options.pathOptions?.instanceConfigPath ?? environmentPath(environment.DEVHUB_INSTANCE_CONFIG);
  const instanceConfigPath = explicitConfig ?? (installed ? user.instanceConfigPath : null);
  const instanceConfig = instanceConfigPath
    ? await readInstanceConfig(instanceConfigPath, { required: Boolean(explicitConfig) })
    : null;
  return resolveDevHubPaths(resolvedRoot, environment, {
    ...options,
    installed,
    instanceConfig,
  });
}

export function resolveInstancePresentation(environment = {}, { publicSnapshot = false } = {}) {
  const mode = (environment.DEVHUB_INSTANCE_MODE?.trim() || (publicSnapshot ? "demo" : "private"));
  if (!new Set(["private", "demo"]).has(mode)) {
    throw new TypeError("DEVHUB_INSTANCE_MODE must be private or demo");
  }
  const label = environment.DEVHUB_INSTANCE_LABEL?.trim() || (mode === "demo" ? "Public demo" : "Private workspace");
  if (!label || label.length > 80 || /[\r\n\t]/.test(label)) {
    throw new TypeError("DEVHUB_INSTANCE_LABEL must be a single line of at most 80 characters");
  }
  return Object.freeze({ mode, label });
}

export function runtimeHostId(environment = process.env) {
  const value = environment.DEVHUB_HOST_ID?.trim();
  return value || null;
}

export function registryRepository(environment = process.env) {
  const value = environment.DEVHUB_REGISTRY_REPOSITORY?.trim();
  return value || null;
}
