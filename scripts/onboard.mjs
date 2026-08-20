import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { listConnectors } from "../lib/connectors.mjs";
import { localRootId, normalizeLocalDiscoveryLimits, validateExplicitLocalRoots } from "../lib/local-discovery.mjs";
import {
  createOnboardPlan,
  formatOnboardPlan,
  OnboardError,
  suggestOnboardHostIdentity,
} from "../lib/onboard.mjs";
import { resolveSetupRunDeadline } from "../lib/setup-run.mjs";
import { SETUP_RUN_CONNECTOR_SUPPORT } from "../lib/setup-run-presentation.mjs";
import { CatalogInitError, createCatalogInitPlan, inspectCatalogDestination } from "./catalog-init.mjs";
import { CatalogSourceError, readSourceCatalog } from "./catalog-tools.mjs";
import { inspectCatalogRevision } from "./catalog-revision.mjs";
import { validateHostsDocument } from "./catalog-validation.mjs";
import { resolveDevHubPaths, runtimeHostId } from "./devhub-config.mjs";
import { runIsolatedLocalDiscovery } from "./local-discovery-process.mjs";
import { runSetupRun } from "./setup-run.mjs";

const stableIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const maximumReviewBytes = 1024 * 1024;

function invalid(message) {
  throw new OnboardError("onboard-arguments-invalid", message);
}

function optionValue(argument, option, args, index) {
  if (argument.startsWith(`${option}=`)) return { value: argument.slice(option.length + 1), index };
  return { value: args[index + 1], index: index + 1 };
}

async function readReviewDocument(filename) {
  let details;
  try {
    details = await stat(filename);
  } catch (error) {
    if (error?.code === "ENOENT") throw new OnboardError("onboard-review-invalid", "onboard review file is missing");
    throw error;
  }
  if (!details.isFile() || details.size > maximumReviewBytes) {
    throw new OnboardError("onboard-review-invalid", `onboard review must be a JSON file no larger than ${maximumReviewBytes} bytes`);
  }
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new OnboardError("onboard-review-invalid", "onboard review must contain valid JSON");
    throw error;
  }
}

export function parseOnboardArguments(args) {
  if (!Array.isArray(args)) invalid("onboard arguments must be an array");
  let sources = null;
  let hostId = null;
  let taskObservationPath = null;
  let reviewPath = null;
  let deadlineMs;
  let json = false;
  const roots = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      if (json) invalid("--json may be supplied once");
      json = true;
      continue;
    }
    if (argument === "--sources" || argument.startsWith("--sources=")) {
      if (sources !== null) invalid("--sources may be supplied once");
      const parsed = optionValue(argument, "--sources", args, index);
      index = parsed.index;
      if (!parsed.value || parsed.value.startsWith("--")) invalid("--sources needs a comma-separated canonical selection");
      sources = parsed.value.split(",").map((source) => source.trim()).filter(Boolean);
      continue;
    }
    if (argument === "--root" || argument.startsWith("--root=")) {
      const parsed = optionValue(argument, "--root", args, index);
      index = parsed.index;
      if (!parsed.value || parsed.value.startsWith("--") || !path.isAbsolute(parsed.value)) invalid("every --root must be an explicit absolute path");
      roots.push(path.resolve(parsed.value));
      continue;
    }
    if (argument === "--host-id" || argument.startsWith("--host-id=")) {
      if (hostId !== null) invalid("--host-id may be supplied once");
      const parsed = optionValue(argument, "--host-id", args, index);
      index = parsed.index;
      if (!stableIdPattern.test(parsed.value ?? "")) invalid("--host-id must be a stable lowercase kebab-case id");
      hostId = parsed.value;
      continue;
    }
    if (argument === "--task-observation" || argument.startsWith("--task-observation=")) {
      if (taskObservationPath !== null) invalid("--task-observation may be supplied once");
      const parsed = optionValue(argument, "--task-observation", args, index);
      index = parsed.index;
      if (!parsed.value || !path.isAbsolute(parsed.value)) invalid("--task-observation requires one absolute transient JSON path");
      taskObservationPath = path.normalize(parsed.value);
      continue;
    }
    if (argument === "--review" || argument.startsWith("--review=")) {
      if (reviewPath !== null) invalid("--review may be supplied once");
      const parsed = optionValue(argument, "--review", args, index);
      index = parsed.index;
      if (!parsed.value || !path.isAbsolute(parsed.value)) invalid("--review requires one absolute artifact-bound Discovery Inbox review path");
      reviewPath = path.normalize(parsed.value);
      continue;
    }
    if (argument === "--deadline-ms" || argument.startsWith("--deadline-ms=")) {
      if (deadlineMs !== undefined) invalid("--deadline-ms may be supplied once");
      const parsed = optionValue(argument, "--deadline-ms", args, index);
      index = parsed.index;
      if (!/^[1-9][0-9]*$/.test(parsed.value ?? "")) invalid("--deadline-ms needs a positive integer");
      deadlineMs = resolveSetupRunDeadline(Number(parsed.value));
      continue;
    }
    invalid(`onboard does not support ${argument}`);
  }
  if (!sources?.length || new Set(sources).size !== sources.length) invalid("onboard requires unique --sources <canonical-comma-list>");
  const supported = new Set(listConnectors()
    .filter((connector) => connector.stage === "available" && SETUP_RUN_CONNECTOR_SUPPORT[connector.id])
    .map((connector) => connector.id));
  if (sources.some((source) => !supported.has(source))) invalid("onboard accepts only available canonical source IDs");
  const selectedRoots = roots.length ? validateExplicitLocalRoots(roots) : Object.freeze([]);
  return Object.freeze({
    selectedConnectorIds: Object.freeze(sources),
    roots: selectedRoots,
    hostId,
    taskObservationPath,
    reviewPath,
    deadlineMs: resolveSetupRunDeadline(deadlineMs),
    json,
  });
}

function resolveHost({ parsed, environment, sourceCatalog, suggestion, catalogMode }) {
  const configuredId = runtimeHostId(environment);
  if (parsed.hostId && configuredId && parsed.hostId !== configuredId) {
    throw new OnboardError("onboard-host-identity-conflict", "--host-id conflicts with the configured DevHub host identity");
  }
  const selectedId = parsed.hostId ?? configuredId;
  const selectedSource = parsed.hostId ? "explicit-argument" : configuredId ? "runtime-configuration" : null;
  let selectedHost = null;
  if (catalogMode === "existing" && selectedId) {
    selectedHost = sourceCatalog.hosts.find((host) => host.id === selectedId) ?? null;
    if (!selectedHost) throw new OnboardError("onboard-host-unknown", "the selected host identity is absent from the reviewed catalog");
  } else if (catalogMode === "empty" && selectedId) {
    selectedHost = { ...suggestion, id: selectedId };
    delete selectedHost.provenance;
    delete selectedHost.ambiguous;
  }
  if (parsed.roots.length && selectedHost && selectedHost.kind !== suggestion.kind) {
    throw new OnboardError("onboard-host-platform-conflict", "the selected host kind does not match this computer");
  }
  const reviewRequired = selectedHost === null && (catalogMode === "empty" || parsed.roots.length > 0);
  return Object.freeze({ selectedId, selectedSource, selectedHost, reviewRequired });
}

function proposedSourceCatalog(host) {
  return { hosts: [host], hostIds: new Set([host.id]), projects: [] };
}

export async function runOnboard(registryRoot, args, options = {}) {
  const parsed = parseOnboardArguments(args);
  const paths = options.paths ?? resolveDevHubPaths(registryRoot, options.environment);
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const hostname = options.hostname ?? os.hostname();
  const now = new Date(options.now ?? Date.now());
  if (!Number.isFinite(now.getTime())) throw new OnboardError("onboard-clock-invalid", "onboard requires a valid clock");
  const suggestion = suggestOnboardHostIdentity({ platform, hostname });
  const discoveryReviewDocument = options.discoveryReviewDocument
    ?? (parsed.reviewPath ? await readReviewDocument(parsed.reviewPath) : null);
  let destinationState;
  try {
    destinationState = await inspectCatalogDestination(paths.catalogDirectory);
  } catch (error) {
    if (error instanceof CatalogInitError) throw new OnboardError(error.code, "the configured catalog destination is not a safe catalog directory");
    throw error;
  }
  const catalogMode = destinationState === "absent" || destinationState === "empty" ? "empty" : "existing";
  let sourceCatalog = null;
  if (catalogMode === "existing") {
    try {
      sourceCatalog = await readSourceCatalog(paths.root, { paths });
    } catch (error) {
      if (error instanceof CatalogSourceError) throw new OnboardError(error.code, "the configured reviewed catalog could not be validated");
      throw error;
    }
  }
  const catalogRevision = await inspectCatalogRevision(paths, destinationState, options.catalogRevision);
  const host = resolveHost({ parsed, environment, sourceCatalog, suggestion, catalogMode });
  const proposedHost = host.selectedHost ?? {
    id: suggestion.id,
    name: suggestion.name,
    kind: suggestion.kind,
    location: suggestion.location,
  };
  if (catalogMode === "empty") {
    validateHostsDocument({ version: 1, hosts: [proposedHost] }, "onboard starter host");
    createCatalogInitPlan({
      destination: paths.catalogDirectory,
      destinationState,
      host: proposedHost,
      apply: false,
    });
    sourceCatalog = proposedSourceCatalog(proposedHost);
  }

  const startedAt = Date.now();
  const deadlineAt = startedAt + parsed.deadlineMs;
  const controller = new AbortController();
  const externalAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener?.("abort", externalAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), parsed.deadlineMs);
  let localDiscovery = null;
  let localDiscoveryReason = parsed.roots.length ? "host-identity-review-required" : "no-local-roots-selected";
  try {
    if (parsed.roots.length && host.selectedHost && new Set(["mac", "linux"]).has(host.selectedHost.kind)) {
      const remainingMs = Math.max(100, Math.min(10_000, deadlineAt - Date.now()));
      const local = await runIsolatedLocalDiscovery(
        { id: host.selectedHost.id, kind: host.selectedHost.kind },
        parsed.roots,
        {
          now,
          limits: normalizeLocalDiscoveryLimits({ deadlineMs: remainingMs }),
          platform,
          homeDirectory: options.homeDirectory,
          childPath: options.localDiscoveryChildPath,
          signal: controller.signal,
        },
      );
      localDiscovery = local.document;
      localDiscoveryReason = local.document.reason;
    } else if (parsed.roots.length && host.selectedHost) {
      localDiscoveryReason = "local-discovery-platform-unsupported";
    }

    const setupArguments = [
      "--sources", parsed.selectedConnectorIds.join(","),
      "--deadline-ms", String(parsed.deadlineMs),
      ...(parsed.taskObservationPath ? ["--task-observation", parsed.taskObservationPath] : []),
      "--json",
    ];
    const setup = await runSetupRun(registryRoot, setupArguments, {
      paths,
      environment,
      now,
      deadlineAt,
      signal: controller.signal,
      sourceCatalog,
      localDiscoveryDocument: localDiscovery,
      discoveryReviewDocument,
      connectors: options.connectors,
      resolveCredential: options.resolveCredential,
      profileDocument: options.profileDocument,
      planning: options.planning,
      sessionId: options.sessionId,
    });
    const plan = createOnboardPlan({
      workflowContractVersion: options.workflowContractVersion ?? 2,
      runtimeVersion: options.runtimeVersion,
      catalog: {
        mode: catalogMode,
        destinationState,
        hostCount: sourceCatalog.hosts.length,
        projectCount: sourceCatalog.projects.length,
        binding: catalogRevision.binding,
        starterHost: catalogMode === "empty" ? proposedHost : null,
      },
      host: {
        suggestion,
        selectedId: host.selectedId,
        selectedSource: host.selectedSource,
        reviewRequired: host.reviewRequired,
      },
      rootIds: parsed.roots.map(localRootId),
      localDiscovery,
      localDiscoveryReason,
      sourceCatalog,
      setupReview: setup.result,
      validation: { state: "passed" },
    });
    return Object.freeze({ parsed, plan });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener?.("abort", externalAbort);
  }
}

export { formatOnboardPlan };
