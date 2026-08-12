import { catalog, serviceKey, type LiveServiceStatus, type Service } from "@/lib/catalog";

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

export async function getCatalogStatuses(filter?: { projectId?: string; serviceId?: string }) {
  const selected = catalog.projects.flatMap((project) =>
    project.id === filter?.projectId || !filter?.projectId
      ? project.services
        .filter((service) => !filter?.serviceId || service.id === filter.serviceId)
        .map((service) => ({ projectId: project.id, service }))
      : [],
  );

  return Promise.all(selected.map(({ projectId, service }) => probeCatalogService(projectId, service)));
}
