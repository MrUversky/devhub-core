import catalogData from "@/app/generated/catalog.json";
import type { ConnectionSnapshot } from "@/lib/connection-status.mjs";

export type Lifecycle = "discovery" | "active" | "production" | "paused" | "archived";
export type ObservedState = "up" | "down" | "stopped" | "degraded" | "registered" | "unknown";

export type Host = {
  id: string;
  name: string;
  kind: "mac" | "windows" | "linux" | "cloud";
  location: "local" | "remote" | "cloud";
  tailscaleName?: string;
  tailscaleIPv4?: string;
};

export type HttpProbe = {
  type: "http";
  url: string;
  successStatuses: number[];
  timeoutMs?: number;
  publish?: ProbePublisher;
};

export type ProbePublisher = {
  type: "tailscale-serve";
  visibility: "tailnet";
  targetUrl: string;
  path: string;
};

export type ReportedStatus = {
  state: ObservedState;
  observedAt?: string;
  note?: string;
};

export type ServiceLinkType = "primary" | "dashboard" | "docs" | "repository" | "logs" | "console";

export type ServiceLink = {
  id: string;
  type: ServiceLinkType;
  label: string;
  url: string;
};

export type ServiceEndpoint = {
  canonical?: string;
  fallback: string;
};

export type ResolvedServiceEndpoint = {
  url: string;
  source: "canonical" | "host-fallback" | "primary-link" | "legacy-url";
  reason: string;
};

export type ReadinessCheck = "monitoring" | "alerting" | "backup" | "restore" | "rollback" | "security-review" | "privacy" | "ownership" | "cost" | "deployment";

export type ReadinessEvidence = {
  id: string;
  check: ReadinessCheck;
  state: "verified" | "declared" | "missing" | "not-applicable" | "unknown";
  source: "operator" | "agent" | "integration" | "catalog";
  note: string;
  observedAt?: string;
  validUntil?: string;
  url?: string;
};

export type ServiceReadiness = {
  profile?: "personal" | "internal" | "customer-facing" | "sensitive";
  owner?: string;
  dataClassification?: "none" | "internal" | "personal" | "sensitive" | "regulated" | "unknown";
  costModel?: "free" | "fixed" | "metered" | "unknown";
  deployment?: {
    source: "operator" | "agent" | "integration" | "catalog";
    provider?: string;
    revision?: string;
    deployedAt?: string;
    url?: string;
  };
  dependencies?: Array<{
    id: string;
    kind: "data-store" | "external-api" | "auth" | "payment" | "messaging" | "storage" | "ai-model" | "other";
    name: string;
    criticality: "required" | "degraded" | "optional";
    provider?: string;
    url?: string;
    note?: string;
  }>;
  evidence: ReadinessEvidence[];
};

export type ProjectReadinessDefaults = Pick<ServiceReadiness, "profile" | "owner" | "dataClassification" | "costModel">;

export type ReviewedSource = "operator" | "agent" | "integration" | "catalog";
export type StewardshipSource = Exclude<ReviewedSource, "catalog">;

export type Steward = {
  id: string;
  name: string;
  kind: "person" | "team";
  source: StewardshipSource;
  observedAt?: string;
  validUntil?: string;
};

export type StewardshipRole = "accountableOwner" | "operator" | "billingOwner" | "credentialOwner";
export type Stewardship = Partial<Record<StewardshipRole, string | null>>;

export type AccessFact = {
  id: string;
  kind: "provider" | "repository" | "billing";
  subject: string;
  access: "yes" | "no" | "unknown";
  source: StewardshipSource;
  note: string;
  observedAt?: string;
  validUntil?: string;
};

export type ExternalCredentialReference = {
  kind: "environment" | "keychain" | "secret-manager";
  locator: string;
};

export type PresentedCredentialReference = {
  kind: ExternalCredentialReference["kind"];
  configured: true;
};

export type CredentialReference = ExternalCredentialReference | PresentedCredentialReference;

export type CredentialInventoryItem = {
  id: string;
  provider: string;
  purpose: string;
  secretRef: CredentialReference;
  consumers: string[];
  owner: string;
  payer?: string;
  source: StewardshipSource;
  lastVerifiedAt?: string;
  rotationDueAt?: string;
};

export type Service = {
  id: string;
  name: string;
  kind: string;
  environment: string;
  host: string;
  runtime: string;
  runtimeIdentifier?: string;
  mode: "always-on" | "on-demand" | "managed" | "internal";
  visibility: "public" | "authenticated" | "tailnet" | "local" | "internal";
  description?: string;
  url?: string;
  endpoint?: ServiceEndpoint;
  readiness?: ServiceReadiness;
  stewardship?: Stewardship;
  links?: ServiceLink[];
  probe?: HttpProbe;
  reported?: ReportedStatus;
  commands?: Record<string, string>;
};

export type Project = {
  version: 1;
  id: string;
  title: string;
  registration: "native" | "overlay";
  aliases?: string[];
  description: string;
  lifecycle: Lifecycle;
  kind: string;
  repository?: string;
  tags?: string[];
  workspaces?: Array<{ host: string; path: string }>;
  readinessDefaults?: ProjectReadinessDefaults;
  stewards?: Steward[];
  stewardshipDefaults?: Partial<Record<StewardshipRole, string>>;
  access?: AccessFact[];
  credentials?: CredentialInventoryItem[];
  services: Service[];
};

export type Catalog = {
  version: 1;
  instance: {
    mode: "private" | "demo";
    label: string;
  };
  hosts: Host[];
  projects: Project[];
  connections: ConnectionSnapshot;
};

export type LiveServiceStatus = {
  key: string;
  state: ObservedState | "protected";
  source: "probe" | "reported" | "catalog";
  reason: "live-probe" | "reported" | "catalog-only" | "remote-loopback" | "probe-timeout" | "probe-failed";
  checkedAt: string;
  observedAt?: string;
  latencyMs?: number;
  httpStatus?: number;
  note?: string;
  ageMs?: number;
  freshness?: "fresh" | "stale";
  refreshAfter?: string;
};

export type ViewerContext = {
  runtimeHostId: string;
  detectedHostId: string | null;
  source: "tailscale" | "local" | "unknown";
};

export const catalog = catalogData as Catalog;

export function serviceKey(projectId: string, serviceId: string) {
  return `${projectId}/${serviceId}`;
}

export function resolveServiceEndpoint(service: Service): ResolvedServiceEndpoint | null {
  if (service.endpoint?.canonical) {
    return {
      url: service.endpoint.canonical,
      source: "canonical",
      reason: "Stable service address is registered; the host address remains available as a fallback.",
    };
  }
  if (service.endpoint?.fallback) {
    return {
      url: service.endpoint.fallback,
      source: "host-fallback",
      reason: "No stable service address is registered yet, so DevHub selected the reviewed host address.",
    };
  }
  const primary = service.links?.find((link) => link.type === "primary");
  if (primary) {
    return {
      url: primary.url,
      source: "primary-link",
      reason: "Selected from the reviewed primary service link.",
    };
  }
  if (service.url) {
    return {
      url: service.url,
      source: "legacy-url",
      reason: "Selected from the backward-compatible service URL.",
    };
  }
  return null;
}
