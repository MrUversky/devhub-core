export type ServiceStatusFilter = "all" | "live" | "reported" | "unchecked" | "attention";

export type FilterableService = {
  mode: "always-on" | "on-demand" | "managed" | "internal";
};

export type FilterableStatus = {
  state: string;
  source: "probe" | "reported" | "catalog";
  freshness?: "fresh" | "stale";
};

export const serviceStatusFilterLabels: Readonly<Record<ServiceStatusFilter, string>>;

export function matchesServiceStatusFilter(
  service: FilterableService,
  status: FilterableStatus,
  filter: ServiceStatusFilter,
): boolean;
