const supportedStatusFilters = new Set(["all", "live", "reported", "unchecked", "attention"]);

export const serviceStatusFilterLabels = Object.freeze({
  all: "All statuses",
  live: "Live",
  reported: "Reported up",
  unchecked: "Not checked",
  attention: "Needs action",
});

export function matchesServiceStatusFilter(service, status, filter) {
  if (!supportedStatusFilters.has(filter)) throw new TypeError(`Unsupported service status filter: ${filter}`);
  if (filter === "all") return true;
  if (filter === "live") return status.source === "probe" && status.state === "up" && status.freshness !== "stale";
  if (filter === "reported") return status.source === "reported" && status.state === "up";
  if (filter === "unchecked") return status.state === "registered" || status.state === "unknown" || status.state === "checking";
  return service.mode === "always-on" && (status.state === "down" || status.state === "degraded");
}
