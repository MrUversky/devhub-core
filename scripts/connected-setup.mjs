import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  CONNECTED_SETUP,
  CONNECTED_SETUP_ENTRY_POINTS,
  CONNECTED_SETUP_NEXT_ACTIONS,
  CONNECTED_SETUP_RUN_STAGES,
  listConnectors,
  recommendedConnectors,
} from "../lib/connectors.mjs";
import { getConnectionOnboardingPresentation } from "../lib/connection-onboarding-presentation.mjs";
import { runIsolatedMarkerProbePlan } from "./connected-setup-probes.mjs";

const executableMarker = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEFAULT_PLANNING_DEADLINE_MS = 5_000;
const MAX_PLANNING_DEADLINE_MS = 30_000;

function fail(message) {
  throw new ConnectedSetupError("setup-contract-invalid", message);
}

export class ConnectedSetupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ConnectedSetupError";
    this.code = code;
  }
}

function safeFilesystemMarker(marker, cwd, homeDirectory) {
  if (typeof marker !== "string" || !marker.trim()) fail("filesystem detection marker must be a non-empty string");
  const normalized = marker.replaceAll("\\", "/");
  if (normalized.startsWith("~/")) {
    const relative = normalized.slice(2);
    if (!relative || relative.split("/").some((part) => part === "..")) fail(`unsafe filesystem detection marker: ${marker}`);
    return { display: marker, absolute: path.resolve(homeDirectory, relative) };
  }
  if (path.isAbsolute(normalized) || normalized.split("/").some((part) => part === "..")) {
    fail(`unsafe filesystem detection marker: ${marker}`);
  }
  return { display: marker, absolute: path.resolve(cwd, normalized) };
}

function executableCandidates(marker, pathValue, platform) {
  if (!executableMarker.test(marker)) fail(`unsafe CLI detection marker: ${marker}`);
  const extensions = platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  return String(pathValue ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((directory) => extensions.map((extension) => path.join(directory, `${marker}${extension}`)));
}

async function markerPresent(candidates, check, signal) {
  for (const candidate of candidates) {
    if (signal?.aborted) return "unknown";
    const operation = Promise.resolve().then(() => check(candidate)).then(() => "present", () => "absent");
    let state;
    if (!signal) state = await operation;
    else state = await new Promise((resolve) => {
      const aborted = () => resolve("unknown");
      signal.addEventListener("abort", aborted, { once: true });
      operation.then((outcome) => {
        signal.removeEventListener("abort", aborted);
        resolve(outcome);
      });
    });
    if (state !== "absent") return state;
  }
  return "absent";
}

async function detectConnector(connector, options) {
  const evidence = [];
  for (const marker of connector.detection.commands) {
    const state = await markerPresent(
      executableCandidates(marker, options.pathValue, options.platform),
      (filename) => options.access(filename, constants.X_OK),
      options.signal,
    );
    evidence.push({ kind: "cli", marker, state });
  }
  for (const marker of connector.detection.markers) {
    const resolved = safeFilesystemMarker(marker, options.cwd, options.homeDirectory);
    const state = await markerPresent([resolved.absolute], (filename) => options.lstat(filename), options.signal);
    evidence.push({ kind: "filesystem", marker: resolved.display, state });
  }
  return { state: detectionState(evidence), evidence };
}

function detectionState(evidence) {
  return !evidence.length
    ? "not-detectable"
    : evidence.some((item) => item.state === "present") ? "detected"
      : evidence.some((item) => item.state === "unknown") ? "unknown" : "not-detected";
}

function isolatedProbePlan(connectors, runtime) {
  const probes = [];
  const descriptors = new Map();
  for (const connector of connectors) {
    const items = [];
    connector.detection.commands.forEach((marker, index) => {
      const id = `${connector.id}.cli.${index}`;
      probes.push({ id, kind: "access", candidates: executableCandidates(marker, runtime.pathValue, runtime.platform) });
      items.push({ id, kind: "cli", marker });
    });
    connector.detection.markers.forEach((marker, index) => {
      const id = `${connector.id}.filesystem.${index}`;
      const resolved = safeFilesystemMarker(marker, runtime.cwd, runtime.homeDirectory);
      probes.push({ id, kind: "lstat", candidates: [resolved.absolute] });
      items.push({ id, kind: "filesystem", marker: resolved.display });
    });
    descriptors.set(connector.id, items);
  }
  return { probes, descriptors };
}

function isolatedDetection(connector, descriptors, result) {
  const states = new Map(result.results.map((item) => [item.id, item.state]));
  const evidence = (descriptors.get(connector.id) ?? []).map((item) => ({
    kind: item.kind,
    marker: item.marker,
    state: states.get(item.id) ?? "unknown",
  }));
  return { state: detectionState(evidence), evidence };
}

function connectionPlan(connector, detection) {
  const implementedOnboarding = getConnectionOnboardingPresentation(connector.id);
  const nextStep = connector.stage === "planned"
    ? "Keep this source as reviewed manual context until its read-only connector is available."
    : !implementedOnboarding
      ? "Use the connector's separate reviewed workflow; Connected Setup onboarding is not implemented for this source."
    : detection.state === "detected"
      ? "Review the detected markers and choose an exact read-only scope before collecting evidence."
      : "Review the implemented onboarding path and choose an exact read-only scope before collecting evidence.";
  return {
    method: connector.auth[0],
    alternatives: connector.auth.slice(1),
    summary: "These methods are advertised by the connector catalog; they do not prove an implemented Connected Setup path.",
    implementedOnboarding: implementedOnboarding ? {
      acquisition: implementedOnboarding.acquisition,
      title: implementedOnboarding.guidedCard.title,
      summary: implementedOnboarding.guidedCard.description,
    } : null,
    nextStep,
  };
}

function selectedConnectorDefinitions(selectedConnectorIds) {
  const definitions = listConnectors();
  if (selectedConnectorIds === undefined) return { definitions, selectedOnly: false };
  if (!Array.isArray(selectedConnectorIds) || !selectedConnectorIds.length || selectedConnectorIds.some((id) => typeof id !== "string" || !id.trim())) {
    fail("selected setup planning source IDs must be non-empty strings");
  }
  const requested = new Set(selectedConnectorIds);
  if (requested.size !== selectedConnectorIds.length) fail("selected setup planning source IDs must be unique");
  const selected = definitions.filter((connector) => requested.has(connector.id));
  if (selected.length !== requested.size || selected.some((connector) => connector.stage !== "available")) {
    fail("selected setup planning accepts only available canonical source IDs");
  }
  return { definitions: selected, selectedOnly: true };
}

export async function createConnectedSetup(options = {}) {
  const deadlineMs = options.deadlineMs ?? DEFAULT_PLANNING_DEADLINE_MS;
  if (!Number.isInteger(deadlineMs) || deadlineMs < 100 || deadlineMs > MAX_PLANNING_DEADLINE_MS) {
    fail(`setup planning deadline must be an integer from 100 to ${MAX_PLANNING_DEADLINE_MS}`);
  }
  const selection = selectedConnectorDefinitions(options.selectedConnectorIds);
  const controller = new AbortController();
  let timedOut = false;
  const externalAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener?.("abort", externalAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, deadlineMs);
  const useIsolatedDefaultProbes = options.access === undefined && options.lstat === undefined;
  const runtime = {
    cwd: path.resolve(options.cwd ?? process.cwd()),
    homeDirectory: path.resolve(options.homeDirectory ?? os.homedir()),
    pathValue: options.pathValue ?? process.env.PATH ?? "",
    platform: options.platform ?? process.platform,
    access: options.access ?? access,
    lstat: options.lstat ?? lstat,
    signal: controller.signal,
  };
  const connectors = [];
  const connectorDefinitions = selection.definitions;
  const recommendedIds = new Set(recommendedConnectors(6).map((connector) => connector.id));
  let isolated = null;
  let probeUnavailable = false;
  try {
    let descriptors = null;
    if (useIsolatedDefaultProbes) {
      const plan = isolatedProbePlan(connectorDefinitions, runtime);
      descriptors = plan.descriptors;
      isolated = await runIsolatedMarkerProbePlan(plan.probes, {
        signal: controller.signal,
        ...(options.probeChildPath ? { childPath: options.probeChildPath } : {}),
      });
      probeUnavailable = isolated.state === "unavailable";
    }
    for (const connector of connectorDefinitions) {
      const detection = useIsolatedDefaultProbes
        ? isolatedDetection(connector, descriptors, isolated)
        : await detectConnector(connector, runtime);
      connectors.push({
        id: connector.id,
        name: connector.name,
        category: connector.category,
        description: connector.summary,
        priority: connector.priority,
        recommended: recommendedIds.has(connector.id),
        availability: connector.stage,
        ...(connector.roadmap ? { roadmap: connector.roadmap } : {}),
        capabilities: connector.capabilities,
        detection,
        connection: connectionPlan(connector, detection),
      });
    }
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener?.("abort", externalAbort);
  }
  return {
    version: 1,
    command: "setup",
    readOnly: true,
    selectedOnly: selection.selectedOnly,
    execution: {
      state: timedOut || controller.signal.aborted || probeUnavailable ? "partial" : "complete",
      reason: timedOut
        ? "planning-deadline-exceeded"
        : options.signal?.aborted ? "planning-aborted"
          : probeUnavailable ? "planning-probe-unavailable" : "local-marker-plan",
      deadlineMs,
    },
    safety: {
      localMarkersOnly: true,
      credentialsRead: false,
      configContentsRead: false,
      commandsExecuted: false,
      networkAccess: false,
      catalogWrites: false,
      markerIsolation: useIsolatedDefaultProbes ? "dedicated-child-process" : "injected-library-probes",
    },
    recommendedConnectors: connectors.filter((connector) => connector.recommended).map((connector) => connector.id),
    connectors,
    buildMyMap: {
      title: "Build my map",
      description: CONNECTED_SETUP.description,
      entryPoints: CONNECTED_SETUP_ENTRY_POINTS,
      steps: CONNECTED_SETUP_RUN_STAGES,
    },
    nextActions: CONNECTED_SETUP_NEXT_ACTIONS,
  };
}

export function formatConnectedSetup(setup) {
  const lines = [
    "DevHub connected setup (read-only)",
    "Detection checks only local CLI and config markers. No credentials, config contents, network or catalog writes.",
    "",
    "Recommended connectors:",
  ];
  for (const connector of setup.connectors.filter((item) => item.recommended)) {
    const evidence = connector.detection.evidence.filter((item) => item.state === "present").map((item) => item.marker);
    lines.push(`  ${connector.name}: ${connector.detection.state}${evidence.length ? ` (${evidence.join(", ")})` : ""}`);
    lines.push(`    Advertised methods: ${[connector.connection.method, ...connector.connection.alternatives].join(", ")}.`);
    lines.push(connector.connection.implementedOnboarding
      ? `    Implemented setup: ${connector.connection.implementedOnboarding.acquisition} — ${connector.connection.implementedOnboarding.summary}`
      : "    Implemented setup: not available.");
    lines.push(`    Next: ${connector.connection.nextStep}`);
  }
  lines.push("", "Build my map:");
  for (const step of setup.buildMyMap.steps) lines.push(`  ${step.id}: ${step.title} — ${step.description}`);
  lines.push("", "This is a plan only. Review unclear matches before updating the catalog.");
  return lines.join("\n");
}
