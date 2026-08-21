const SHA256_PATTERN = /^(?:sha256:)?([a-f0-9]{64})$/;
const REVISION_PATTERN = /^[a-f0-9]{40,64}$/;
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function invalid(code, message) {
  throw new SitesCompanionError(code, message);
}

function exactHttpsOrigin(value, label) {
  if (typeof value !== "string" || !value.trim()) invalid("sites-companion-origin-invalid", `${label} is required`);
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    invalid("sites-companion-origin-invalid", `${label} must be an exact HTTPS origin`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/"
      || parsed.search || parsed.hash || parsed.origin === "null") {
    invalid("sites-companion-origin-invalid", `${label} must be an exact HTTPS origin without credentials, path, query or fragment`);
  }
  return parsed.origin;
}

function text(value, label) {
  if (typeof value !== "string" || !value.trim() || /[\r\n\t]/.test(value)) {
    invalid("sites-companion-input-invalid", `${label} must be one non-empty line`);
  }
  return value.trim();
}

function sha256(value, label) {
  const match = typeof value === "string" ? value.toLowerCase().match(SHA256_PATTERN) : null;
  if (!match) invalid("sites-companion-input-invalid", `${label} must be a SHA-256 digest`);
  return `sha256:${match[1]}`;
}

function revision(value, label) {
  if (typeof value !== "string" || !REVISION_PATTERN.test(value)) {
    invalid("sites-companion-input-invalid", `${label} must be an exact Git commit`);
  }
  return value;
}

function safeId(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    invalid("sites-companion-catalog-invalid", `${label} must be a stable kebab-case ID`);
  }
  return value;
}

function requiredCatalogText(value, label) {
  if (typeof value !== "string" || !value.trim()) invalid("sites-companion-catalog-invalid", `${label} is required`);
  return value.trim();
}

function sanitizeHost(host) {
  return {
    id: safeId(host?.id, "host id"),
    name: requiredCatalogText(host?.name, `host ${host?.id ?? "unknown"} name`),
    kind: host?.kind,
    location: host?.location,
  };
}

function sanitizeService(service, projectId, hostIds) {
  if (!hostIds.has(service?.host)) invalid("sites-companion-catalog-invalid", `${projectId}/${service?.id ?? "unknown"} references an unknown host`);
  return {
    id: safeId(service?.id, `${projectId} service id`),
    name: requiredCatalogText(service?.name, `${projectId}/${service?.id ?? "unknown"} name`),
    kind: requiredCatalogText(service?.kind, `${projectId}/${service?.id ?? "unknown"} kind`),
    environment: requiredCatalogText(service?.environment, `${projectId}/${service?.id ?? "unknown"} environment`),
    host: service.host,
    runtime: requiredCatalogText(service?.runtime, `${projectId}/${service?.id ?? "unknown"} runtime`),
    mode: service.mode,
    visibility: service.visibility,
  };
}

function sanitizeProject(entry, hostIds) {
  const project = entry?.manifest ?? entry;
  const id = safeId(project?.id, "project id");
  if (!Array.isArray(project?.services)) invalid("sites-companion-catalog-invalid", `${id} services are required`);
  return {
    version: 1,
    id,
    title: requiredCatalogText(project.title, `${id} title`),
    registration: project.registration,
    description: `${requiredCatalogText(project.kind, `${id} kind`)} project from the reviewed owner catalog. Private operating details remain in canonical DevHub.`,
    lifecycle: project.lifecycle,
    kind: project.kind,
    services: project.services.map((service) => sanitizeService(service, id, hostIds)),
  };
}

export class SitesCompanionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SitesCompanionError";
    this.code = code;
  }
}

export function sanitizeSitesCompanionCatalog(sourceCatalog) {
  if (!sourceCatalog || !Array.isArray(sourceCatalog.hosts) || !Array.isArray(sourceCatalog.projects)) {
    invalid("sites-companion-catalog-invalid", "a validated DevHub source catalog is required");
  }
  const hosts = sourceCatalog.hosts.map(sanitizeHost);
  const hostIds = new Set(hosts.map((host) => host.id));
  const projects = sourceCatalog.projects.map((project) => sanitizeProject(project, hostIds));
  return freeze({
    version: 1,
    instance: { mode: "private", label: "Owner-only DevHub companion" },
    hosts,
    projects,
    connections: { version: 1, source: "not-configured", profiles: [] },
  });
}

export function parseSitesCompanionBinding(document) {
  if (document === undefined || document === null) return null;
  if (!document || typeof document !== "object" || Array.isArray(document) || document.version !== 1
      || document.kind !== "devhub-sites-companion") {
    invalid("sites-companion-binding-invalid", "the companion binding must be a version 1 devhub-sites-companion object");
  }
  const allowed = new Set(["version", "kind", "projectId", "siteOrigin", "currentVersionId", "previousVersionId"]);
  const extra = Object.keys(document).filter((field) => !allowed.has(field));
  if (extra.length) invalid("sites-companion-binding-invalid", `the companion binding contains unsupported fields: ${extra.join(", ")}`);
  const projectId = text(document.projectId, "binding projectId");
  const currentVersionId = text(document.currentVersionId, "binding currentVersionId");
  const previousVersionId = document.previousVersionId === null || document.previousVersionId === undefined
    ? null
    : text(document.previousVersionId, "binding previousVersionId");
  return freeze({
    version: 1,
    kind: "devhub-sites-companion",
    projectId,
    siteOrigin: exactHttpsOrigin(document.siteOrigin, "binding siteOrigin"),
    currentVersionId,
    previousVersionId,
  });
}

export function createSitesCompanionPlan(input) {
  if (!input || typeof input !== "object") invalid("sites-companion-input-invalid", "companion input is required");
  const binding = parseSitesCompanionBinding(input.binding);
  const source = freeze({
    releaseTag: text(input.source?.releaseTag, "source release tag"),
    sourceCommit: revision(input.source?.sourceCommit, "source manifest commit"),
    manifestSha256: sha256(input.source?.manifestSha256, "source manifest digest"),
  });
  const catalog = freeze({
    revision: revision(input.catalog?.revision, "catalog revision"),
    fingerprint: sha256(input.catalog?.fingerprint, "catalog fingerprint"),
  });
  const statusApiOrigin = exactHttpsOrigin(input.statusApiOrigin, "status API origin");
  return freeze({
    version: 1,
    command: "sites-companion",
    readOnly: input.apply !== true,
    state: input.apply === true ? "staged" : "preview",
    source,
    catalog,
    backend: {
      statusApiOrigin,
      statusApiEndpoint: `${statusApiOrigin}/api/status`,
      transport: "viewer-browser",
      credentials: "omit",
      contextRoute: false,
      workerProbe: false,
    },
    site: {
      action: binding ? "reuse" : "create",
      projectId: binding?.projectId ?? null,
      siteOrigin: binding?.siteOrigin ?? null,
      access: {
        visibility: "custom",
        ownerSource: "invoking-sites-account",
        allowedOwnerCount: 1,
        allowedGroupCount: 0,
        externalVisitorCount: 0,
      },
      currentVersionId: binding?.currentVersionId ?? null,
      previousVersionId: binding?.previousVersionId ?? null,
    },
    publication: {
      automatic: false,
      requiresExplicitApproval: true,
      approvalLabel: "Publish this private companion",
      hostingMetadataSource: "ephemeral-sites-session",
    },
    rollback: {
      restoreVersionId: binding?.previousVersionId ?? null,
      removeBindingOnly: true,
    },
  });
}
