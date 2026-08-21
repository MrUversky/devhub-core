import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { readSourceCatalog } from "./catalog-tools.mjs";
import { resolveDevHubPaths } from "./devhub-config.mjs";

const execFileAsync = promisify(execFile);
const unitPattern = /^[A-Za-z0-9_.@:-]+\.service$/;
const launchdPattern = /^[A-Za-z0-9_.-]+$/;
const composeFilenames = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
const operationalCommands = ["start", "stop", "restart", "logs"];
const gitHubOwnerPattern = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
const gitHubRepositoryPattern = /^[a-z0-9._-]{1,100}$/;
const gitOriginTimeoutMs = 2_000;
const gitOriginMaxBytes = 4 * 1024;
const maxReviewedWorkspaces = 100;

export class HostInspectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HostInspectionError";
    this.code = code;
  }
}

async function defaultFileExists(filename) {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new HostInspectionError("inspection-aborted", "The bounded host inspection was aborted");
  }
}

async function defaultRunner(command, args, options = {}) {
  const allowed = new Set(["systemctl", "launchctl", "docker", "docker-compose", "git"]);
  if (!allowed.has(command)) throw new HostInspectionError("unsafe-inspection-command", `Inspection does not allow ${command}`);
  throwIfAborted(options.signal);
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: { ...process.env, DOCKER_CLI_HINTS: "false", GIT_TERMINAL_PROMPT: "0" },
      timeout: options.timeoutMs ?? 5_000,
      maxBuffer: options.maxBuffer ?? 1024 * 1024,
      shell: false,
      windowsHide: true,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return { ok: true, stdout: result.stdout, unavailable: false };
  } catch (error) {
    if (options.signal?.aborted || error?.name === "AbortError") throwIfAborted(options.signal ?? { aborted: true });
    return {
      ok: false,
      stdout: typeof error?.stdout === "string" ? error.stdout : "",
      unavailable: error?.code === "ENOENT",
      timedOut: error?.killed === true || error?.code === "ETIMEDOUT",
    };
  }
}

function canonicalGitHubRepository(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > gitOriginMaxBytes) return null;
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1 || lines[0].includes("%")) return null;
  const remote = lines[0];
  let owner;
  let name;
  const scp = remote.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (scp) {
    [, owner, name] = scp;
  } else {
    let parsed;
    try { parsed = new URL(remote); } catch { return null; }
    const https = parsed.protocol === "https:" && !parsed.username && !parsed.password;
    const ssh = parsed.protocol === "ssh:" && parsed.username === "git" && !parsed.password;
    if ((!https && !ssh) || parsed.hostname.toLowerCase() !== "github.com" || parsed.port || parsed.search || parsed.hash) return null;
    const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (parts.length !== 2) return null;
    [owner, name] = parts;
  }
  name = name.replace(/\.git$/i, "");
  owner = owner.toLowerCase();
  name = name.toLowerCase();
  if (!gitHubOwnerPattern.test(owner) || !gitHubRepositoryPattern.test(name) || name.endsWith(".git")) return null;
  return { provider: "github", owner, name };
}

function safeCommands(service) {
  return operationalCommands.map((name) => service.commands?.[name]).filter(Boolean);
}

function extractSystemdUnits(service) {
  const units = new Set();
  for (const command of safeCommands(service)) {
    for (const match of command.matchAll(/(?:^|\s)systemctl(?:\s+--user)?\s+(?:show|status|start|stop|restart|try-restart|reload)\s+([A-Za-z0-9_.@:-]+\.service)\b/g)) {
      if (unitPattern.test(match[1])) units.add(match[1]);
    }
    for (const match of command.matchAll(/(?:^|\s)journalctl\s+(?:[^\n]*?\s)?-u\s+([A-Za-z0-9_.@:-]+\.service)\b/g)) {
      if (unitPattern.test(match[1])) units.add(match[1]);
    }
  }
  return [...units].sort();
}

function extractLaunchdLabels(service) {
  const labels = new Set();
  for (const command of safeCommands(service)) {
    for (const match of command.matchAll(/launchctl\s+(?:kickstart|print|enable|disable|bootout)\s+(?:-k\s+)?(?:gui\/\$\(id -u\)|gui\/\d+|user\/\d+|system)\/([A-Za-z0-9_.-]+)/g)) {
      if (launchdPattern.test(match[1])) labels.add(match[1]);
    }
  }
  return [...labels].sort();
}

function extractNpmScripts(service) {
  const scripts = new Set();
  for (const command of safeCommands(service)) {
    for (const match of command.matchAll(/(?:^|\s)npm\s+run\s+([A-Za-z0-9_.:-]+)\b/g)) scripts.add(match[1]);
  }
  return [...scripts].sort();
}

function parseProperties(stdout) {
  return Object.fromEntries(stdout.split(/\r?\n/).flatMap((line) => {
    const separator = line.indexOf("=");
    return separator > 0 ? [[line.slice(0, separator), line.slice(separator + 1)]] : [];
  }));
}

function systemdState(properties) {
  if (properties.LoadState === "not-found") return "unknown";
  if (properties.ActiveState === "active") return "running";
  if (properties.ActiveState === "failed") return "failed";
  if (["inactive", "deactivating"].includes(properties.ActiveState)) return "stopped";
  return "unknown";
}

function parseLaunchdState(stdout) {
  const state = stdout.match(/^\s*state\s*=\s*([A-Za-z-]+)\s*$/m)?.[1]?.toLowerCase();
  if (state === "running") return "running";
  if (["exited", "stopped", "waiting"].includes(state)) return "stopped";
  return "unknown";
}

function sourceUnavailable(type, timedOut = false) {
  return { type, available: false, timedOut, observations: 0 };
}

function serviceIdentity(project, service) {
  return {
    projectId: project.id,
    projectTitle: project.title,
    serviceId: service.id,
    serviceName: service.name,
    runtime: service.runtime,
    mode: service.mode,
  };
}

function unknown(project, service, reason, message) {
  return { ...serviceIdentity(project, service), reason, message };
}

function serviceMatch(project, service, source, identifier, state, details = {}) {
  return {
    ...serviceIdentity(project, service),
    source,
    identifier,
    state,
    ...details,
  };
}

function workspaceFor(project, hostId) {
  return (project.workspaces ?? []).filter((workspace) => workspace.host === hostId);
}

async function inspectProjectRepository(project, context) {
  const workspaces = workspaceFor(project, context.host.id);
  if (!workspaces.length) return null;
  if (workspaces.length > maxReviewedWorkspaces) return { source: sourceUnavailable("git-origin"), match: null };
  const repositories = [];
  for (const workspace of workspaces) {
    const result = await context.runner("git", ["-C", workspace.path, "remote", "get-url", "origin"], {
      timeoutMs: gitOriginTimeoutMs,
      maxBuffer: gitOriginMaxBytes,
      shell: false,
    });
    const source = result.unavailable || result.timedOut
      ? sourceUnavailable("git-origin", result.timedOut)
      : { type: "git-origin", available: true, observations: 1 };
    if (!result.ok || result.unavailable || result.timedOut) return { source, match: null };
    const repository = canonicalGitHubRepository(result.stdout);
    if (!repository) return { source, match: null };
    repositories.push(repository);
  }
  const unique = new Map(repositories.map((repository) => [`${repository.owner}/${repository.name}`, repository]));
  if (unique.size !== 1) return { source: { type: "git-origin", available: true, observations: workspaces.length }, match: null };
  return {
    source: { type: "git-origin", available: true, observations: workspaces.length },
    match: {
      projectId: project.id,
      hostId: context.host.id,
      source: "git-origin",
      repository: [...unique.values()][0],
    },
  };
}

async function inspectSystemd(project, service, context) {
  const units = extractSystemdUnits(service);
  if (units.length !== 1) {
    return { unknown: unknown(project, service, units.length ? "ambiguous-reviewed-unit" : "no-reviewed-unit", "Exactly one systemd unit must be identifiable from reviewed operational commands.") };
  }
  const unit = units[0];
  const result = await context.runner("systemctl", [
    "show", unit, "--no-pager", "--property=LoadState,ActiveState,SubState,UnitFileState",
  ]);
  if (result.unavailable || result.timedOut) {
    return { source: sourceUnavailable("systemd", result.timedOut), unknown: unknown(project, service, "systemd-unavailable", "The read-only systemd status query is unavailable on this host.") };
  }
  const properties = parseProperties(result.stdout);
  if (!result.ok || !properties.LoadState || properties.LoadState === "not-found") {
    return { source: { type: "systemd", available: true, observations: 1 }, unknown: unknown(project, service, "unit-not-found", `Reviewed unit ${unit} was not found by systemd.`) };
  }
  return {
    source: { type: "systemd", available: true, observations: 1 },
    match: serviceMatch(project, service, "systemd", unit, systemdState(properties), {
      definition: properties.LoadState,
      activeState: properties.ActiveState ?? null,
      subState: properties.SubState ?? null,
      unitFileState: properties.UnitFileState ?? null,
    }),
  };
}

async function launchdDefinition(label, context) {
  const candidates = [
    path.join(context.homeDirectory, "Library/LaunchAgents", `${label}.plist`),
    path.join("/Library/LaunchAgents", `${label}.plist`),
    path.join("/Library/LaunchDaemons", `${label}.plist`),
  ];
  for (const candidate of candidates) if (await context.fileExists(candidate)) return candidate;
  return null;
}

async function inspectLaunchd(project, service, context) {
  const labels = extractLaunchdLabels(service);
  if (labels.length !== 1) {
    return { unknown: unknown(project, service, labels.length ? "ambiguous-reviewed-label" : "no-reviewed-label", "Exactly one launchd label must be identifiable from reviewed operational commands.") };
  }
  const label = labels[0];
  const definitionPath = await launchdDefinition(label, context);
  const domain = `gui/${context.uid}/${label}`;
  const result = await context.runner("launchctl", ["print", domain]);
  if (result.unavailable || result.timedOut) {
    return { source: sourceUnavailable("launchd", result.timedOut), unknown: unknown(project, service, "launchd-unavailable", "The read-only launchd status query is unavailable on this host.") };
  }
  if (!result.ok) {
    if (definitionPath) {
      return {
        source: { type: "launchd", available: true, observations: 1 },
        match: serviceMatch(project, service, "launchd", label, "unknown", { definitionPresent: true, loaded: null }),
        unknown: unknown(project, service, "launchd-status-unavailable", `Reviewed label ${label} has a standard definition, but launchd did not return a readable status.`),
      };
    }
    return { source: { type: "launchd", available: true, observations: 1 }, unknown: unknown(project, service, "label-not-found", `Reviewed label ${label} is neither loaded nor present in a standard definition path.`) };
  }
  return {
    source: { type: "launchd", available: true, observations: 1 },
    match: serviceMatch(project, service, "launchd", label, parseLaunchdState(result.stdout), {
      definitionPresent: definitionPath ? true : null,
      loaded: true,
    }),
  };
}

function parseComposePs(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return trimmed.split(/\r?\n/).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  }
}

function composeState(rows) {
  const states = rows.map((row) => String(row.State ?? row.Status ?? "").toLowerCase());
  if (states.some((state) => state.includes("running"))) return "running";
  if (states.some((state) => state.includes("dead") || state.includes("removing"))) return "failed";
  if (states.some((state) => state.includes("exited") || state.includes("stopped") || state.includes("created"))) return "stopped";
  return "unknown";
}

async function findComposeFile(workspaces, context) {
  const found = [];
  for (const workspace of workspaces) {
    for (const filename of composeFilenames) {
      const candidate = path.join(workspace.path, filename);
      if (await context.fileExists(candidate)) found.push(candidate);
    }
  }
  return found;
}

async function runCompose(composeFile, args, context) {
  let result = await context.runner("docker", ["compose", "-f", composeFile, ...args], { cwd: path.dirname(composeFile) });
  if (result.unavailable) result = await context.runner("docker-compose", ["-f", composeFile, ...args], { cwd: path.dirname(composeFile) });
  return result;
}

async function inspectCompose(project, service, context) {
  const files = await findComposeFile(workspaceFor(project, context.host.id), context);
  if (files.length !== 1) {
    return { unknown: unknown(project, service, files.length ? "ambiguous-compose-definition" : "compose-definition-not-found", "Exactly one checked Compose definition must exist in a reviewed workspace.") };
  }
  const composeFile = files[0];
  const configured = await runCompose(composeFile, ["config", "--services"], context);
  if (configured.unavailable || configured.timedOut) {
    return { source: sourceUnavailable("docker-compose", configured.timedOut), unknown: unknown(project, service, "compose-unavailable", "Docker Compose is unavailable for a read-only checked-config query.") };
  }
  if (!configured.ok) {
    return { source: { type: "docker-compose", available: true, observations: 1 }, unknown: unknown(project, service, "compose-config-invalid", "The checked Compose configuration could not be read safely.") };
  }
  const serviceIds = configured.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const runtimeIdentifier = service.runtimeIdentifier ?? service.id;
  if (!serviceIds.includes(runtimeIdentifier)) {
    return { source: { type: "docker-compose", available: true, observations: 1 }, unknown: unknown(project, service, "compose-service-not-matched", `No exact Compose service named ${runtimeIdentifier} exists in the reviewed workspace.`) };
  }
  const status = await runCompose(composeFile, ["ps", "--all", "--format", "json"], context);
  if (status.unavailable || status.timedOut || !status.ok) {
    return {
      source: { type: "docker-compose", available: !status.unavailable, timedOut: status.timedOut, observations: 2 },
      match: serviceMatch(project, service, "docker-compose", runtimeIdentifier, "unknown", { definitionPresent: true }),
    };
  }
  const rows = parseComposePs(status.stdout).filter((row) => (row.Service ?? row.service) === runtimeIdentifier);
  return {
    source: { type: "docker-compose", available: true, observations: 2 },
    match: serviceMatch(project, service, "docker-compose", runtimeIdentifier, rows.length ? composeState(rows) : "stopped", {
      definitionPresent: true,
      containersObserved: rows.length,
    }),
  };
}

async function inspectPackage(project, service, context) {
  const scripts = extractNpmScripts(service);
  if (scripts.length !== 1) {
    return { unknown: unknown(project, service, scripts.length ? "ambiguous-reviewed-script" : "no-reviewed-script", "Exactly one npm script must be identifiable from reviewed operational commands.") };
  }
  const workspaces = workspaceFor(project, context.host.id);
  const packages = [];
  for (const workspace of workspaces) {
    const packagePath = path.join(workspace.path, "package.json");
    if (await context.fileExists(packagePath)) packages.push(packagePath);
  }
  if (packages.length !== 1) {
    return { unknown: unknown(project, service, packages.length ? "ambiguous-package-definition" : "package-definition-not-found", "Exactly one package.json must exist in a reviewed workspace.") };
  }
  let document;
  try {
    document = JSON.parse(await readFile(packages[0], "utf8"));
  } catch {
    return { source: { type: "package-json", available: true, observations: 1 }, unknown: unknown(project, service, "package-definition-invalid", "The reviewed workspace package.json is invalid.") };
  }
  const script = scripts[0];
  if (typeof document.scripts?.[script] !== "string") {
    return { source: { type: "package-json", available: true, observations: 1 }, unknown: unknown(project, service, "package-script-not-found", `Reviewed npm script ${script} is not defined in package.json.`) };
  }
  return {
    source: { type: "package-json", available: true, observations: 1 },
    match: serviceMatch(project, service, "package-json", script, "unknown", { definitionPresent: true }),
  };
}

function mergeSources(sources) {
  const merged = new Map();
  for (const source of sources.filter(Boolean)) {
    const previous = merged.get(source.type);
    if (!previous) merged.set(source.type, source);
    else merged.set(source.type, {
      type: source.type,
      available: previous.available && source.available,
      timedOut: Boolean(previous.timedOut || source.timedOut),
      observations: previous.observations + source.observations,
    });
  }
  return [...merged.values()].sort((left, right) => left.type.localeCompare(right.type));
}

export function formatHostInspection(result) {
  if (result.status === "unknown") {
    return [
      `DevHub host inspection for ${result.hostId}`,
      `Observed: ${result.observedAt}`,
      `UNKNOWN ${result.reason}: ${result.message}`,
    ].join("\n");
  }
  const lines = [
    `DevHub host inspection for ${result.host.id} (${result.host.name})`,
    `Observed: ${result.observedAt}`,
    `Identity source: ${result.identity.source} (operator assertion, not remotely verified)`,
    `Matched services: ${result.serviceMatches.length}`,
  ];
  for (const match of result.serviceMatches) lines.push(`${match.state.toUpperCase()} ${match.projectId}/${match.serviceId} via ${match.source}:${match.identifier}`);
  lines.push(`Unknown services: ${result.unknowns.length}`);
  for (const item of result.unknowns) lines.push(`UNKNOWN ${item.projectId}/${item.serviceId}: ${item.message}`);
  return lines.join("\n");
}

export async function inspectHost(root, hostId, options = {}) {
  throwIfAborted(options.signal);
  const paths = options.paths ?? resolveDevHubPaths(root);
  const sourceCatalog = await readSourceCatalog(paths.root, { paths });
  throwIfAborted(options.signal);
  const host = sourceCatalog.hosts.find((candidate) => candidate.id === hostId);
  if (!host) throw new HostInspectionError("unknown-host", `No reviewed host has id ${hostId}`);
  const observedAt = (options.now ?? new Date()).toISOString();
  const runner = options.runner ?? defaultRunner;
  const fileExists = options.fileExists ?? defaultFileExists;
  const context = {
    host,
    signal: options.signal,
    async runner(command, args, runOptions = {}) {
      throwIfAborted(options.signal);
      const result = await runner(command, args, {
        ...runOptions,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      throwIfAborted(options.signal);
      return result;
    },
    async fileExists(filename) {
      throwIfAborted(options.signal);
      const result = await fileExists(filename);
      throwIfAborted(options.signal);
      return result;
    },
    homeDirectory: options.homeDirectory ?? os.homedir(),
    uid: options.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0),
  };
  const projects = sourceCatalog.projects.map(({ manifest }) => manifest);
  const reviewedServices = projects.flatMap((project) =>
    project.services.filter((service) => service.host === host.id).map((service) => ({ project, service })));
  const serviceMatches = [];
  const projectRepositories = [];
  const unknowns = [];
  const sources = [];

  if (host.kind === "cloud") {
    for (const { project, service } of reviewedServices) {
      unknowns.push(unknown(project, service, "managed-host-not-local", "A one-shot local inspection cannot query a managed cloud host."));
    }
  } else {
    for (const project of projects) {
      throwIfAborted(options.signal);
      const observation = await inspectProjectRepository(project, context);
      if (observation?.source) sources.push(observation.source);
      if (observation?.match) projectRepositories.push(observation.match);
    }
    for (const { project, service } of reviewedServices) {
      throwIfAborted(options.signal);
      let observation;
      const runtime = service.runtime.toLowerCase();
      if (runtime === "systemd") observation = await inspectSystemd(project, service, context);
      else if (runtime === "launchd") observation = await inspectLaunchd(project, service, context);
      else if (["docker-compose", "compose"].includes(runtime)) observation = await inspectCompose(project, service, context);
      else if (["node", "npm", "vinext"].includes(runtime)) observation = await inspectPackage(project, service, context);
      else observation = { unknown: unknown(project, service, "unsupported-runtime", `Runtime ${service.runtime} has no safe one-shot adapter.`) };
      if (observation.source) sources.push(observation.source);
      if (observation.match) serviceMatches.push(observation.match);
      if (observation.unknown) unknowns.push(observation.unknown);
    }
  }

  serviceMatches.sort((left, right) => `${left.projectId}/${left.serviceId}`.localeCompare(`${right.projectId}/${right.serviceId}`));
  projectRepositories.sort((left, right) => left.projectId.localeCompare(right.projectId));
  unknowns.sort((left, right) => `${left.projectId}/${left.serviceId}`.localeCompare(`${right.projectId}/${right.serviceId}`));
  return {
    version: 1,
    command: "inspect-host",
    readOnly: true,
    host: {
      id: host.id,
      name: host.name,
      kind: host.kind,
      location: host.location,
    },
    identity: {
      source: options.identitySource ?? "explicit-argument",
      verified: false,
    },
    observedAt,
    sources: mergeSources(sources),
    projectRepositories,
    serviceMatches,
    unknowns,
  };
}
