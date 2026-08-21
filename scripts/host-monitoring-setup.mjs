import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, open, readFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { readSourceCatalog } from "./catalog-tools.mjs";
import { runtimeHostId } from "./devhub-config.mjs";
import { withCatalogMutationLock } from "./reconciliation.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DARWIN_TAILSCALE = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

export class HostMonitoringSetupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HostMonitoringSetupError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new HostMonitoringSetupError(code, message);
}

function normalizedDnsName(value) {
  return typeof value === "string" ? value.trim().replace(/\.$/, "").toLowerCase() : "";
}

function parseJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch {
    fail("tailscale-output-invalid", `${label} returned invalid JSON`);
  }
}

async function defaultRun(file, args) {
  try {
    return await execFileAsync(file, args, {
      encoding: "utf8",
      timeout: DEFAULT_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      shell: false,
    });
  } catch (error) {
    const detail = typeof error?.stderr === "string" && error.stderr.trim()
      ? error.stderr.trim().split(/\r?\n/, 1)[0]
      : error?.code === "ENOENT" ? "executable not found" : "command failed";
    fail("tailscale-command-failed", `Tailscale ${args.slice(0, 2).join(" ")} failed: ${detail}`);
  }
}

async function resolveTailscaleBinary(environment, platform, accessFile) {
  const configured = environment.DEVHUB_TAILSCALE_BIN?.trim();
  if (configured) {
    if (!path.isAbsolute(configured) || configured.includes("\0")) {
      fail("tailscale-binary-invalid", "DEVHUB_TAILSCALE_BIN must be an absolute executable path");
    }
    try {
      await accessFile(configured, constants.X_OK);
    } catch {
      fail("tailscale-binary-unavailable", `DEVHUB_TAILSCALE_BIN is not executable: ${configured}`);
    }
    return configured;
  }
  if (platform === "darwin") {
    try {
      await accessFile(DARWIN_TAILSCALE, constants.X_OK);
      return DARWIN_TAILSCALE;
    } catch {
      // The standalone CLI remains the portable fallback.
    }
  }
  return "tailscale";
}

function parseArguments(args, environment) {
  let hostId = null;
  let apply = false;
  let json = false;
  const seen = new Set();
  for (const argument of args) {
    if (argument === "--apply" || argument === "--json") {
      if (seen.has(argument)) fail("host-monitoring-arguments-invalid", `setup-host-monitoring accepts ${argument} only once`);
      seen.add(argument);
      if (argument === "--apply") apply = true;
      else json = true;
      continue;
    }
    if (argument.startsWith("--") || hostId !== null) {
      fail("host-monitoring-arguments-invalid", "setup-host-monitoring accepts one optional host id, --apply and --json");
    }
    hostId = argument;
  }
  const configuredHostId = runtimeHostId(environment);
  if (hostId && configuredHostId && hostId !== configuredHostId) {
    fail("host-identity-conflict", `Requested host ${hostId} conflicts with DEVHUB_HOST_ID=${configuredHostId}`);
  }
  hostId ??= configuredHostId;
  if (!hostId) fail("host-required", "setup-host-monitoring needs a host id argument or DEVHUB_HOST_ID");
  return Object.freeze({ hostId, apply, json });
}

function reviewedRoutes(sourceCatalog, hostId) {
  const routes = [];
  for (const { manifest: project } of sourceCatalog.projects) {
    for (const service of project.services ?? []) {
      const publish = service.probe?.publish;
      if (service.host !== hostId || publish?.type !== "tailscale-serve") continue;
      routes.push(Object.freeze({
        key: `${project.id}/${service.id}`,
        projectId: project.id,
        serviceId: service.id,
        mode: service.mode,
        probeUrl: service.probe.url,
        successStatuses: [...service.probe.successStatuses],
        timeoutMs: service.probe.timeoutMs ?? 5_000,
        path: publish.path,
        targetUrl: publish.targetUrl,
      }));
    }
  }
  routes.sort((left, right) => left.key.localeCompare(right.key));
  const byPath = new Map();
  for (const route of routes) {
    const previous = byPath.get(route.path);
    if (previous) {
      fail("reviewed-route-conflict", `${previous.key} and ${route.key} both own published path ${route.path}`);
    }
    byPath.set(route.path, route);
  }
  return routes;
}

function verifyIdentity(host, status) {
  const self = status?.Self;
  const dnsName = normalizedDnsName(self?.DNSName);
  const tailscaleIPs = Array.isArray(self?.TailscaleIPs) ? self.TailscaleIPs : [];
  if (!dnsName || !Array.isArray(self?.TailscaleIPs)) {
    fail("tailscale-status-invalid", "Tailscale status does not contain a usable Self identity");
  }
  if (self.Online === false) fail("tailscale-offline", `Tailscale reports ${dnsName} offline`);
  if (host.tailscaleName && dnsName.split(".", 1)[0] !== host.tailscaleName.toLowerCase()) {
    fail("tailscale-identity-conflict", `Catalog host ${host.id} expects ${host.tailscaleName}, but this device is ${dnsName}`);
  }
  if (host.tailscaleIPv4 && !tailscaleIPs.includes(host.tailscaleIPv4)) {
    fail("tailscale-identity-conflict", `Catalog host ${host.id} expects ${host.tailscaleIPv4}, but this device does not own it`);
  }
  return Object.freeze({ dnsName, tailscaleIPs: [...tailscaleIPs] });
}

function currentHandlers(serveStatus, dnsName) {
  const web = serveStatus?.Web;
  if (web === undefined) return {};
  if (!web || typeof web !== "object" || Array.isArray(web)) {
    fail("tailscale-serve-status-invalid", "Tailscale Serve status has an invalid Web map");
  }
  const host = web[`${dnsName}:443`];
  if (host === undefined) return {};
  if (!host || typeof host !== "object" || Array.isArray(host)
      || !host.Handlers || typeof host.Handlers !== "object" || Array.isArray(host.Handlers)) {
    fail("tailscale-serve-status-invalid", `Tailscale Serve status for ${dnsName}:443 has invalid handlers`);
  }
  return host.Handlers;
}

function centralVerification(routes) {
  return Object.freeze({
    state: routes.length ? "pending" : "not-applicable",
    note: routes.length
      ? "Verify every HTTPS probe from the central DevHub host; local setup cannot prove DNS, ACL or end-to-end reachability."
      : "This host has no reviewed publisher routes.",
  });
}

function assertTargetsUp(plan) {
  const unhealthy = plan.routes.filter((route) => route.target.state !== "up");
  if (unhealthy.length) {
    fail(
      "host-monitoring-target-unhealthy",
      `Local health target is not ready for ${unhealthy.map((route) => route.key).join(", ")}; no routes were changed`,
    );
  }
}

async function observeTarget(route, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), route.timeoutMs);
  try {
    const response = await fetchImpl(route.targetUrl, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      signal: controller.signal,
    });
    return Object.freeze({
      state: route.successStatuses.includes(response.status) ? "up" : "unexpected-status",
      httpStatus: response.status,
    });
  } catch {
    return Object.freeze({ state: "unreachable", httpStatus: null });
  } finally {
    clearTimeout(timer);
  }
}

function servePathState(handlers, routePath) {
  if (!Object.hasOwn(handlers, routePath)) return Object.freeze({ kind: "absent", target: null });
  const handler = handlers[routePath];
  if (typeof handler?.Proxy === "string") return Object.freeze({ kind: "proxy", target: handler.Proxy });
  return Object.freeze({ kind: "occupied", target: null });
}

async function readServePathState(dependencies, dnsName, routePath) {
  const output = await dependencies.run(dependencies.tailscaleBinary, ["serve", "status", "--json"]);
  const status = parseJson(output.stdout, "tailscale serve status --json");
  return servePathState(currentHandlers(status, dnsName), routePath);
}

async function createPlan(sourceCatalog, parsed, dependencies) {
  const host = sourceCatalog.hosts.find((candidate) => candidate.id === parsed.hostId);
  if (!host) fail("host-unknown", `Catalog does not contain host ${parsed.hostId}`);
  const routes = reviewedRoutes(sourceCatalog, parsed.hostId);
  if (!routes.length) {
    return Object.freeze({
      version: 1,
      command: "setup-host-monitoring",
      readOnly: !parsed.apply,
      status: "current",
      host: Object.freeze({ id: host.id, kind: host.kind, dnsName: null, tailscaleIPs: [] }),
      adapters: Object.freeze([]),
      safety: Object.freeze({
        reviewedCatalogOnly: true,
        funnel: false,
        serveReset: false,
        preservesUnrelatedRoutes: true,
        credentialsStored: false,
        residentAgent: false,
      }),
      centralVerification: centralVerification([]),
      routes: Object.freeze([]),
    });
  }
  if (!new Set(["mac", "windows", "linux"]).has(host.kind)) {
    fail("host-unsupported", `The tailscale-serve publisher supports mac, windows and linux hosts, not ${host.kind}`);
  }
  if (!host.tailscaleName && !host.tailscaleIPv4) {
    fail("tailscale-identity-missing", `Catalog host ${host.id} needs a reviewed tailscaleName or tailscaleIPv4`);
  }
  const status = parseJson((await dependencies.run(dependencies.tailscaleBinary, ["status", "--json"])).stdout, "tailscale status --json");
  const identity = verifyIdentity(host, status);
  const serveStatus = parseJson((await dependencies.run(dependencies.tailscaleBinary, ["serve", "status", "--json"])).stdout, "tailscale serve status --json");
  const handlers = currentHandlers(serveStatus, identity.dnsName);
  const plannedRoutes = [];
  for (const route of routes) {
    const probe = new URL(route.probeUrl);
    if (probe.protocol !== "https:" || normalizedDnsName(probe.hostname) !== identity.dnsName
        || (probe.port && probe.port !== "443") || probe.pathname !== route.path || probe.search || probe.hash) {
      fail("probe-identity-conflict", `${route.key} probe URL must be exactly https://${identity.dnsName}${route.path}`);
    }
    const pathState = servePathState(handlers, route.path);
    const currentTarget = pathState.kind === "proxy" ? pathState.target : pathState.kind === "occupied" ? "non-proxy-handler" : null;
    const routeState = pathState.kind === "absent" ? "pending" : pathState.kind === "proxy" && pathState.target === route.targetUrl ? "current" : "conflict";
    plannedRoutes.push(Object.freeze({
      ...route,
      routeState,
      currentTarget,
      target: await observeTarget(route, dependencies.fetch),
      applyInvocation: Object.freeze({
        file: dependencies.tailscaleBinary,
        args: Object.freeze(["serve", "--bg", "--https=443", `--set-path=${route.path}`, route.targetUrl]),
      }),
      rollbackInvocation: Object.freeze({
        file: dependencies.tailscaleBinary,
        args: Object.freeze(["serve", "--https=443", `--set-path=${route.path}`, "off"]),
      }),
    }));
  }
  const conflicts = plannedRoutes.filter((route) => route.routeState === "conflict");
  return Object.freeze({
    version: 1,
    command: "setup-host-monitoring",
    readOnly: !parsed.apply,
    status: conflicts.length ? "blocked" : plannedRoutes.some((route) => route.routeState === "pending") ? "changes-planned" : "current",
    host: Object.freeze({ id: host.id, kind: host.kind, dnsName: identity.dnsName, tailscaleIPs: identity.tailscaleIPs }),
    adapters: Object.freeze(["tailscale-serve"]),
    safety: Object.freeze({
      reviewedCatalogOnly: true,
      funnel: false,
      serveReset: false,
      preservesUnrelatedRoutes: true,
      credentialsStored: false,
      residentAgent: false,
    }),
    centralVerification: centralVerification(plannedRoutes),
    routes: Object.freeze(plannedRoutes),
  });
}

async function acquireApplyLock(lockPath) {
  const nonce = randomUUID();
  try {
    const handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({ nonce, pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() })}\n`);
    return Object.freeze({ handle, nonce });
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail("host-monitoring-locked", `Another host monitoring setup is active (${lockPath}); after a crash, remove this file only after confirming no setup process is running`);
    }
    throw error;
  }
}

async function withApplyLock(hostId, operation) {
  const lockPath = path.join(os.tmpdir(), `devhub-host-monitoring-${hostId}.lock`);
  const lock = await acquireApplyLock(lockPath);
  try {
    return await operation();
  } finally {
    await lock.handle.close().catch(() => {});
    let owner = null;
    try { owner = JSON.parse(await readFile(lockPath, "utf8")); } catch { /* Missing or malformed ownership fails closed. */ }
    if (owner?.nonce !== lock.nonce) {
      fail("host-monitoring-lock-ownership-lost", `Host monitoring lock ownership changed; ${lockPath} was not removed`);
    }
    await unlink(lockPath);
  }
}

export async function runHostMonitoringSetup(root, args, options = {}) {
  const environment = options.environment ?? process.env;
  const parsed = parseArguments(args, environment);
  const sourceCatalog = await readSourceCatalog(root, { paths: options.paths });
  const dependencies = {
    run: options.run ?? defaultRun,
    fetch: options.fetch ?? globalThis.fetch,
    tailscaleBinary: options.tailscaleBinary ?? await resolveTailscaleBinary(
      environment,
      options.platform ?? process.platform,
      options.access ?? access,
    ),
  };
  const firstPlan = await createPlan(sourceCatalog, parsed, dependencies);
  if (!parsed.apply) return Object.freeze({ parsed, result: firstPlan });
  if (firstPlan.status === "blocked") {
    fail("tailscale-serve-conflict", "Existing Tailscale Serve paths conflict with the reviewed catalog; no routes were changed");
  }
  assertTargetsUp(firstPlan);
  const applied = [];
  const attempted = [];
  const result = await withApplyLock(parsed.hostId, () => withCatalogMutationLock(options.paths, async () => {
    const currentCatalog = await readSourceCatalog(root, { paths: options.paths });
    const plan = await createPlan(currentCatalog, parsed, dependencies);
    if (plan.status === "blocked") fail("tailscale-serve-conflict", "Tailscale Serve changed before apply; no routes were changed");
    assertTargetsUp(plan);
    try {
      for (const plannedRoute of plan.routes.filter((candidate) => candidate.routeState === "pending")) {
        const freshPlan = await createPlan(currentCatalog, parsed, dependencies);
        const route = freshPlan.routes.find((candidate) => candidate.key === plannedRoute.key);
        if (!route) fail("reviewed-route-changed", `${plannedRoute.key} disappeared from the reviewed catalog before apply`);
        if (route.routeState === "current") continue;
        if (route.routeState !== "pending") {
          fail("tailscale-serve-conflict", `${route.key} changed ownership before apply; no further routes were changed`);
        }
        assertTargetsUp(Object.freeze({ routes: Object.freeze([route]) }));
        const pathImmediatelyBeforeWrite = await readServePathState(dependencies, freshPlan.host.dnsName, route.path);
        if (pathImmediatelyBeforeWrite.kind === "proxy" && pathImmediatelyBeforeWrite.target === route.targetUrl) continue;
        if (pathImmediatelyBeforeWrite.kind !== "absent") {
          fail("tailscale-serve-conflict", `${route.key} changed ownership during its health check; no further routes were changed`);
        }
        attempted.push(route);
        await dependencies.run(dependencies.tailscaleBinary, [
          "serve", "--bg", "--https=443", `--set-path=${route.path}`, route.targetUrl,
        ]);
        const currentPath = await readServePathState(dependencies, freshPlan.host.dnsName, route.path);
        if (currentPath.kind !== "proxy" || currentPath.target !== route.targetUrl) {
          fail("tailscale-serve-verification-failed", `${route.key} was not retained after apply`);
        }
        applied.push(route);
      }
      const verified = await createPlan(currentCatalog, parsed, dependencies);
      if (verified.routes.some((route) => route.routeState !== "current")
          || verified.routes.some((route) => route.target.state !== "up")) {
        fail("tailscale-serve-verification-failed", "A reviewed route or its local health target failed post-apply verification");
      }
      return Object.freeze({ ...verified, readOnly: false, status: "applied", applied: Object.freeze(applied.map((route) => route.key)) });
    } catch (error) {
      const rollbackFailures = [];
      for (const route of [...attempted].reverse()) {
        try {
          const currentPath = await readServePathState(dependencies, plan.host.dnsName, route.path);
          if (currentPath.kind === "absent") continue;
          if (currentPath.kind !== "proxy" || currentPath.target !== route.targetUrl) {
            rollbackFailures.push(`${route.key}: route ownership changed; the path was not removed`);
            continue;
          }
          await dependencies.run(dependencies.tailscaleBinary, ["serve", "--https=443", `--set-path=${route.path}`, "off"]);
          const afterRollback = await readServePathState(dependencies, plan.host.dnsName, route.path);
          if (afterRollback.kind !== "absent") rollbackFailures.push(`${route.key}: route remained after rollback`);
        } catch (rollbackError) {
          rollbackFailures.push(`${route.key}: ${rollbackError.message}`);
        }
      }
      if (rollbackFailures.length) {
        fail("host-monitoring-rollback-incomplete", `${error.message}; rollback also failed: ${rollbackFailures.join("; ")}`);
      }
      throw error;
    }
  }));
  return Object.freeze({ parsed, result });
}

export function formatHostMonitoringSetup(result) {
  const lines = [
    `DevHub host monitoring: ${result.status}`,
    `Host: ${result.host.id} (${result.host.dnsName ?? result.host.kind})`,
    "Safety: reviewed catalog paths only; no Funnel, Serve reset, credentials or resident agent.",
    `Central verification: ${result.centralVerification.state}. ${result.centralVerification.note}`,
  ];
  if (!result.routes.length) lines.push("No reviewed Tailscale Serve health routes are configured for this host.");
  for (const route of result.routes) {
    const target = route.target.httpStatus ? `${route.target.state} HTTP ${route.target.httpStatus}` : route.target.state;
    lines.push(`- ${route.key}: ${route.routeState}; local target ${target}`);
    if (route.routeState === "pending") {
      lines.push(`  apply executable: ${JSON.stringify(route.applyInvocation.file)}`);
      lines.push(`  apply arguments: ${JSON.stringify(route.applyInvocation.args)}`);
    }
    if (route.routeState === "conflict") lines.push(`  conflict: ${route.currentTarget}`);
    lines.push(`  verify: ${route.probeUrl}`);
    lines.push(`  rollback executable: ${JSON.stringify(route.rollbackInvocation.file)}`);
    lines.push(`  rollback arguments: ${JSON.stringify(route.rollbackInvocation.args)}`);
  }
  if (result.readOnly && result.status === "changes-planned") {
    lines.push("Review the exact paths above, then repeat with --apply.");
  }
  return lines.join("\n");
}
