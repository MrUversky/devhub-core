import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";
import { validateHostsDocument, validateProjectDocument } from "./catalog-validation.mjs";

const valueOptions = new Set(["--host-id", "--host-name", "--host-kind", "--host-location"]);
const booleanOptions = new Set(["--apply", "--json"]);

export class CatalogInitError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CatalogInitError";
    this.code = code;
  }
}

function invalid(code, message) {
  throw new CatalogInitError(code, message);
}

function normalizedOption(argument) {
  const separator = argument.indexOf("=");
  if (separator === -1) return { name: argument, inlineValue: null };
  return { name: argument.slice(0, separator), inlineValue: argument.slice(separator + 1) };
}

export function parseCatalogInitArguments(args, { cwd = process.cwd() } = {}) {
  const values = new Map();
  const booleans = new Set();
  const positionals = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }

    const { name, inlineValue } = normalizedOption(argument);
    if (booleanOptions.has(name)) {
      if (inlineValue !== null) invalid("invalid-option-value", `${name} does not accept a value`);
      if (booleans.has(name)) invalid("duplicate-option", `${name} may be specified only once`);
      booleans.add(name);
      continue;
    }
    if (!valueOptions.has(name)) invalid("unknown-option", `unsupported option ${name}`);
    if (values.has(name)) invalid("duplicate-option", `${name} may be specified only once`);

    const value = inlineValue ?? args[index + 1];
    if (inlineValue === null) index += 1;
    if (value === undefined || value.startsWith("--") || value.trim() === "") {
      invalid("missing-option-value", `${name} needs a non-empty value`);
    }
    values.set(name, value);
  }

  if (positionals.length !== 1) {
    invalid(
      "destination-required",
      positionals.length === 0
        ? "init-catalog needs exactly one destination directory"
        : "init-catalog accepts only one destination directory",
    );
  }

  const missing = [...valueOptions].filter((option) => !values.has(option));
  if (missing.length > 0) invalid("required-options-missing", `missing required options: ${missing.join(", ")}`);

  const host = {
    id: values.get("--host-id"),
    name: values.get("--host-name"),
    kind: values.get("--host-kind"),
    location: values.get("--host-location"),
  };
  try {
    validateHostsDocument({ version: 1, hosts: [host] }, "init-catalog host");
  } catch (error) {
    invalid("invalid-host", error instanceof Error ? error.message : String(error));
  }

  return {
    destination: path.resolve(cwd, positionals[0]),
    host,
    apply: booleans.has("--apply"),
    json: booleans.has("--json"),
  };
}

export async function inspectCatalogDestination(destination) {
  let stats;
  try {
    stats = await lstat(destination);
  } catch (error) {
    if (error?.code === "ENOENT") return "absent";
    throw error;
  }
  if (stats.isSymbolicLink()) invalid("destination-symlink", `${destination} must not be a symbolic link`);
  if (!stats.isDirectory()) invalid("destination-not-directory", `${destination} exists and is not a directory`);
  return (await readdir(destination)).length === 0 ? "empty" : "nonempty";
}

function starterDocument(host) {
  return { version: 1, hosts: [host] };
}

async function validateStarterCatalog(destination) {
  const hostsPath = path.join(destination, "hosts.yaml");
  const projectsPath = path.join(destination, "projects");
  const hosts = parse(await readFile(hostsPath, "utf8"));
  const { hostIds } = validateHostsDocument(hosts, hostsPath);
  const projectFiles = (await readdir(projectsPath)).filter((file) => file.endsWith(".yaml")).sort();

  for (const file of projectFiles) {
    const source = path.join(projectsPath, file);
    validateProjectDocument(parse(await readFile(source, "utf8")), {
      source,
      hostIds,
      expectedId: file.replace(/\.yaml$/, ""),
    });
  }
  return { hosts: hosts.hosts.length, projects: projectFiles.length };
}

export function createCatalogInitPlan({ destination, host, apply = false, destinationState = null }) {
  return {
    version: 1,
    command: "init-catalog",
    readOnly: !apply,
    status: apply ? "created" : "planned",
    destination,
    destinationState,
    applyEligible: destinationState === "absent" || destinationState === "empty",
    precondition: "destination-must-be-absent-or-empty",
    host,
    files: [
      { type: "file", path: path.join(destination, "hosts.yaml") },
      { type: "directory", path: path.join(destination, "projects") },
    ],
  };
}

export async function initializeCatalog(options) {
  const destinationState = await inspectCatalogDestination(options.destination);
  if (destinationState === "nonempty") {
    invalid("destination-not-empty", `${options.destination} must be absent or empty; no files were changed`);
  }
  const plan = createCatalogInitPlan({ ...options, destinationState });
  if (!options.apply) return plan;

  const document = starterDocument(options.host);
  validateHostsDocument(document, "generated init-catalog hosts.yaml");

  if (destinationState === "absent") await mkdir(options.destination, { recursive: true });
  if ((await readdir(options.destination)).length !== 0) {
    invalid("destination-not-empty", `${options.destination} became non-empty before initialization; no files were overwritten`);
  }

  await mkdir(path.join(options.destination, "projects"));
  await writeFile(path.join(options.destination, "hosts.yaml"), stringify(document), { flag: "wx" });
  const validation = await validateStarterCatalog(options.destination);
  return { ...plan, validation: { status: "passed", ...validation } };
}

export function formatCatalogInit(result) {
  const heading = result.readOnly ? "Catalog initialization plan (read-only)" : "Catalog initialized and validated";
  const action = result.readOnly ? "Would create" : "Created";
  const lines = [heading, `Destination: ${result.destination}`, `Host: ${result.host.id} (${result.host.kind}, ${result.host.location})`];
  for (const file of result.files) lines.push(`${action} ${file.type}: ${file.path}`);
  if (result.readOnly && result.applyEligible) {
    lines.push("No files changed. Repeat the command with --apply after reviewing this plan.");
  } else if (result.readOnly) {
    lines.push("No files changed. Apply is blocked because the destination is not empty.");
  } else lines.push(`Validation passed: ${result.validation.hosts} host, ${result.validation.projects} projects.`);
  return lines.join("\n");
}
