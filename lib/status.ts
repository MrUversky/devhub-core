import { catalog, serviceKey, type LiveServiceStatus, type Service } from "@/lib/catalog";
import {
  createStatusPollingRuntime,
  parseStatusPollingConfig,
  statusCadenceForService,
  type StatusPollingEntry,
  type StatusPollingRuntime,
} from "@/lib/status-polling.mjs";

type CatalogPollingInput = { projectId: string; service: Service };
type CatalogPollingEntry = StatusPollingEntry<CatalogPollingInput>;

const statusPollingConfig = parseStatusPollingConfig(process.env);

export function runtimeHostId() {
  return process.env.DEVHUB_HOST_ID?.trim() || "unknown";
}

function isLoopback(url: string) {
  const hostname = new URL(url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export async function probeCatalogService(
  projectId: string,
  service: Service,
  hostId = runtimeHostId(),
): Promise<LiveServiceStatus> {
  const key = serviceKey(projectId, service.id);
  const checkedAt = new Date().toISOString();

  if (!service.probe) {
    return {
      key,
      state: service.reported?.state ?? "registered",
      source: service.reported ? "reported" : "catalog",
      reason: service.reported ? "reported" : "catalog-only",
      checkedAt,
      observedAt: service.reported?.observedAt,
      note: service.reported?.note,
    };
  }

  if (isLoopback(service.probe.url) && service.host !== hostId) {
    return {
      key,
      state: service.reported?.state ?? "registered",
      source: service.reported ? "reported" : "catalog",
      reason: service.reported ? "reported" : "remote-loopback",
      checkedAt,
      observedAt: service.reported?.observedAt,
      note: service.reported?.note ?? `Local probe belongs to ${service.host}; DevHub runs on ${hostId}.`,
    };
  }

  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), service.probe.timeoutMs ?? 5000);

  try {
    const response = await fetch(service.probe.url, {
      method: "GET",
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "DevHub/0.2 health-probe" },
    });
    const latencyMs = Math.round(performance.now() - started);
    const accepted = service.probe.successStatuses.includes(response.status);
    const protectedResponse = accepted && (response.status === 401 || response.status === 403);

    return {
      key,
      state: protectedResponse ? "protected" : accepted ? "up" : "down",
      source: "probe",
      reason: "live-probe",
      checkedAt,
      observedAt: checkedAt,
      latencyMs,
      httpStatus: response.status,
      note: protectedResponse ? "Reachable and access-protected." : undefined,
    };
  } catch (error) {
    return {
      key,
      state: "down",
      source: "probe",
      reason: error instanceof Error && error.name === "AbortError" ? "probe-timeout" : "probe-failed",
      checkedAt,
      observedAt: checkedAt,
      latencyMs: Math.round(performance.now() - started),
      note: error instanceof Error && error.name === "AbortError" ? "Probe timed out." : "Endpoint is unreachable.",
    };
  } finally {
    clearTimeout(timer);
  }
}

function unexpectedStatusFailure(entry: CatalogPollingEntry, checkedAt: string): LiveServiceStatus {
  const { projectId, service } = entry.input;
  return service.probe ? {
    key: serviceKey(projectId, service.id),
    state: "down",
    source: "probe",
    reason: "probe-failed",
    checkedAt,
    observedAt: checkedAt,
    note: "Probe failed before a health result was available.",
  } : {
    key: serviceKey(projectId, service.id),
    state: "unknown",
    source: "catalog",
    reason: "catalog-only",
    checkedAt,
    note: "Status evaluation failed.",
  };
}

function createCatalogPollingRuntime() {
  return createStatusPollingRuntime<CatalogPollingEntry, LiveServiceStatus>({
    config: statusPollingConfig,
    load: (entry) => probeCatalogService(entry.input.projectId, entry.input.service),
    onLoadError: (entry, _error, checkedAt) => unexpectedStatusFailure(entry, checkedAt),
    logger: (summary) => console.info(`[devhub-status] ${JSON.stringify(summary)}`),
  });
}

type StatusPollingGlobal = typeof globalThis & {
  __DEVHUB_STATUS_POLLING_RUNTIME_V1__?: StatusPollingRuntime<CatalogPollingEntry, LiveServiceStatus>;
};

const statusPollingGlobal = globalThis as StatusPollingGlobal;
const statusPollingRuntime = statusPollingGlobal.__DEVHUB_STATUS_POLLING_RUNTIME_V1__ ??= createCatalogPollingRuntime();

export async function getCatalogStatusSnapshot(filter?: { projectId?: string; serviceId?: string }) {
  const hosts = new Map(catalog.hosts.map((host) => [host.id, host]));
  const selected = catalog.projects.flatMap((project) =>
    project.id === filter?.projectId || !filter?.projectId
      ? project.services
        .filter((service) => !filter?.serviceId || service.id === filter.serviceId)
        .map((service): CatalogPollingEntry => ({
          key: serviceKey(project.id, service.id),
          cadence: statusCadenceForService(service, hosts.get(service.host)),
          input: { projectId: project.id, service },
        }))
      : [],
  );

  return statusPollingRuntime.getSnapshot(selected);
}

export async function getCatalogStatuses(filter?: { projectId?: string; serviceId?: string }) {
  return (await getCatalogStatusSnapshot(filter)).statuses;
}
