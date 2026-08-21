const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const projectFields = new Set([
  "version", "id", "title", "registration", "aliases", "description", "lifecycle",
  "kind", "repository", "tags", "workspaces", "readinessDefaults", "stewards",
  "stewardshipDefaults", "access", "credentials", "services",
]);
const hostFields = new Set(["id", "name", "kind", "location", "tailscaleName", "tailscaleIPv4"]);
const serviceFields = new Set([
  "id", "name", "kind", "environment", "host", "runtime", "runtimeIdentifier", "mode", "visibility",
  "description", "url", "endpoint", "links", "probe", "reported", "commands",
  "readiness", "stewardship",
]);
const serviceEndpointFields = new Set(["canonical", "fallback"]);
const readinessFields = new Set([
  "profile", "owner", "dataClassification", "costModel", "deployment", "dependencies", "evidence",
]);
const readinessDefaultFields = new Set(["profile", "owner", "dataClassification", "costModel"]);
const readinessEvidenceFields = new Set(["id", "check", "state", "source", "note", "observedAt", "validUntil", "url"]);
const passportDeploymentFields = new Set(["source", "provider", "revision", "deployedAt", "url"]);
const passportDependencyFields = new Set(["id", "kind", "name", "criticality", "provider", "url", "note"]);
const serviceLinkFields = new Set(["id", "type", "label", "url"]);
const probeFields = new Set(["type", "url", "successStatuses", "timeoutMs", "publish"]);
const probePublisherFields = new Set(["type", "visibility", "targetUrl", "path"]);
const reportFields = new Set(["state", "observedAt", "note"]);
const commandFields = new Set(["start", "stop", "restart", "logs", "verify", "deploy"]);
const workspaceFields = new Set(["host", "path"]);
const stewardFields = new Set(["id", "name", "kind", "source", "observedAt", "validUntil"]);
const stewardshipFields = new Set(["accountableOwner", "operator", "billingOwner", "credentialOwner"]);
const accessFactFields = new Set(["id", "kind", "subject", "access", "source", "note", "observedAt", "validUntil"]);
const credentialFields = new Set(["id", "provider", "purpose", "secretRef", "consumers", "owner", "payer", "source", "lastVerifiedAt", "rotationDueAt"]);
const credentialRefFields = new Set(["kind", "locator"]);
const lifecycles = new Set(["discovery", "active", "production", "paused", "archived"]);
const registrations = new Set(["native", "overlay"]);
const visibilities = new Set(["public", "authenticated", "tailnet", "local", "internal"]);
const modes = new Set(["always-on", "on-demand", "managed", "internal"]);
const serviceLinkTypes = new Set(["primary", "dashboard", "docs", "repository", "logs", "console"]);
const readinessProfiles = new Set(["personal", "internal", "customer-facing", "sensitive"]);
const readinessChecks = new Set(["monitoring", "alerting", "backup", "restore", "rollback", "security-review", "privacy", "ownership", "cost", "deployment"]);
const readinessStates = new Set(["verified", "declared", "missing", "not-applicable", "unknown"]);
const readinessSources = new Set(["operator", "agent", "integration", "catalog"]);
const stewardshipSources = new Set(["operator", "agent", "integration"]);
const dataClassifications = new Set(["none", "internal", "personal", "sensitive", "regulated", "unknown"]);
const costModels = new Set(["free", "fixed", "metered", "unknown"]);
const dependencyKinds = new Set(["data-store", "external-api", "auth", "payment", "messaging", "storage", "ai-model", "other"]);
const dependencyCriticalities = new Set(["required", "degraded", "optional"]);
const hostKinds = new Set(["mac", "windows", "linux", "cloud"]);
const hostLocations = new Set(["local", "remote", "cloud"]);
const observedStates = new Set(["up", "down", "stopped", "degraded", "registered", "unknown"]);
const stewardKinds = new Set(["person", "team"]);
const accessKinds = new Set(["provider", "repository", "billing"]);
const accessStates = new Set(["yes", "no", "unknown"]);
const credentialRefKinds = new Set(["environment", "keychain", "secret-manager"]);
const environmentRefPattern = /^[A-Z][A-Z0-9_]{0,99}$/;
const runtimeIdentifierPattern = /^[A-Za-z0-9_.@:-]{1,150}$/;
const keychainRefPattern = /^generic-password:[A-Za-z0-9._@+-]{1,100}:[A-Za-z0-9._@+-]{1,100}$/;
const secretManagerRefPattern = /^op:\/\/[A-Za-z0-9._@+%/-]{3,290}$/;
const sensitiveNamePattern = /^(?:api[-_]?key|access[-_]?token|auth(?:orization)?|client[-_]?secret|password|passwd|secret|signature|token)$/i;
const secretAssignmentPattern = /\b(?:api[-_]?key|access[-_]?token|client[-_]?secret|password|passwd|secret|token)\s*[:=]\s*["']?(?!\$|\$\{|<|example\b|redacted\b)[A-Za-z0-9_./+=-]{8,}/i;
const privateKeyPattern = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
const bearerPattern = /\bBearer(?:\s|[-_%])+[A-Za-z0-9._~+/-]{8,}={0,2}\b/i;
const knownTokenPattern = /\b(?:sk-(?:proj-)?|gh[pousr]_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{8,}\b/;
const jwtPattern = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/;
const credentialConnectionPattern = /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s/:@]+:[^\s/@]+@/i;

export class CatalogValidationError extends Error {
  constructor(source, fieldPath, message) {
    super(`${source}: ${fieldPath}: ${message}`);
    this.name = "CatalogValidationError";
    this.source = source;
    this.fieldPath = fieldPath;
  }
}

function fail(source, fieldPath, message) {
  throw new CatalogValidationError(source, fieldPath, message);
}

function requireObject(value, source, fieldPath) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(source, fieldPath, "must be an object");
}

function requireArray(value, source, fieldPath) {
  if (!Array.isArray(value)) fail(source, fieldPath, "must be an array");
}

function requireString(value, source, fieldPath) {
  if (typeof value !== "string" || value.trim() === "") fail(source, fieldPath, "must be a non-empty string");
}

function requireId(value, source, fieldPath) {
  requireString(value, source, fieldPath);
  if (!idPattern.test(value)) fail(source, fieldPath, "must use lowercase kebab-case");
}

function rejectUnknownFields(value, allowed, source, fieldPath) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(source, `${fieldPath}.${key}`, "is not a supported field");
  }
}

function requireEnum(value, allowed, source, fieldPath) {
  if (!allowed.has(value)) fail(source, fieldPath, `must be one of: ${[...allowed].join(", ")}`);
}

function requireHttpUrl(value, source, fieldPath) {
  requireString(value, source, fieldPath);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(source, fieldPath, "must be a valid absolute URL");
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) fail(source, fieldPath, "must use http or https");
  if (parsed.username || parsed.password) fail(source, fieldPath, "must not contain URL credentials");
  for (const key of parsed.searchParams.keys()) {
    if (sensitiveNamePattern.test(key)) fail(source, fieldPath, `must not contain secret-bearing query parameter ${key}`);
  }
}

function validateNonSecretMetadata(value, source, fieldPath) {
  requireString(value, source, fieldPath);
  for (const candidate of value.match(/https?:\/\/[^\s"']+/gi) ?? []) {
    let parsed;
    try { parsed = new URL(candidate); } catch { continue; }
    if (parsed.username || parsed.password) fail(source, fieldPath, "must not contain URL credentials");
    for (const key of parsed.searchParams.keys()) {
      if (sensitiveNamePattern.test(key)) fail(source, fieldPath, `must not contain secret-bearing query parameter ${key}`);
    }
  }
  if (privateKeyPattern.test(value) || bearerPattern.test(value) || knownTokenPattern.test(value) || jwtPattern.test(value)
      || credentialConnectionPattern.test(value) || secretAssignmentPattern.test(value)) {
    fail(source, fieldPath, "must not contain credential material");
  }
}

function validateCommand(command, source, fieldPath) {
  requireString(command, source, fieldPath);
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(command)) {
    fail(source, fieldPath, "must not contain private key material");
  }
  if (/https?:\/\/[^/\s:@]+:[^@\s]+@/i.test(command)) {
    fail(source, fieldPath, "must not contain URL credentials");
  }
  const query = command.match(/https?:\/\/[^\s"']+/gi) ?? [];
  for (const candidate of query) {
    let parsed;
    try {
      parsed = new URL(candidate);
    } catch {
      // Command fragments are not required to be standalone URLs.
      continue;
    }
    for (const key of parsed.searchParams.keys()) {
      if (sensitiveNamePattern.test(key)) fail(source, fieldPath, `must not contain secret-bearing query parameter ${key}`);
    }
  }
  if (secretAssignmentPattern.test(command)) {
    fail(source, fieldPath, "must not contain an inline secret assignment");
  }
}

function validateTailscaleIPv4(value, source, fieldPath) {
  requireString(value, source, fieldPath);
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    fail(source, fieldPath, "must be a valid IPv4 address");
  }
  if (octets[0] !== 100 || octets[1] < 64 || octets[1] > 127) {
    fail(source, fieldPath, "must be inside the Tailscale CGNAT address range");
  }
}

function validateProbe(probe, source, fieldPath) {
  requireObject(probe, source, fieldPath);
  rejectUnknownFields(probe, probeFields, source, fieldPath);
  if (probe.type !== "http") fail(source, `${fieldPath}.type`, "must be http");
  requireHttpUrl(probe.url, source, `${fieldPath}.url`);
  requireArray(probe.successStatuses, source, `${fieldPath}.successStatuses`);
  if (probe.successStatuses.length === 0) fail(source, `${fieldPath}.successStatuses`, "must not be empty");
  const seen = new Set();
  for (const [index, status] of probe.successStatuses.entries()) {
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      fail(source, `${fieldPath}.successStatuses[${index}]`, "must be an integer from 100 to 599");
    }
    if (seen.has(status)) fail(source, `${fieldPath}.successStatuses[${index}]`, `duplicates status ${status}`);
    seen.add(status);
  }
  if (probe.timeoutMs !== undefined && (!Number.isInteger(probe.timeoutMs) || probe.timeoutMs < 100 || probe.timeoutMs > 60000)) {
    fail(source, `${fieldPath}.timeoutMs`, "must be an integer from 100 to 60000");
  }
  if (probe.publish !== undefined) {
    const publishPath = `${fieldPath}.publish`;
    requireObject(probe.publish, source, publishPath);
    rejectUnknownFields(probe.publish, probePublisherFields, source, publishPath);
    if (probe.publish.type !== "tailscale-serve") fail(source, `${publishPath}.type`, "must be tailscale-serve");
    if (probe.publish.visibility !== "tailnet") fail(source, `${publishPath}.visibility`, "must be tailnet");
    requireHttpUrl(probe.publish.targetUrl, source, `${publishPath}.targetUrl`);
    const rawTargetUrl = probe.publish.targetUrl;
    const target = new URL(rawTargetUrl);
    if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || target.username || target.password
        || target.search || target.hash || target.pathname === "/"
        || !/^http:\/\/127\.0\.0\.1(?::[0-9]{1,5})?\/[^/?#]+(?:\/[^/?#]+)*$/.test(rawTargetUrl)
        || /\/\.{1,2}(?:\/|$)/.test(rawTargetUrl)) {
      fail(source, `${publishPath}.targetUrl`, "must be a path-specific http://127.0.0.1 loopback URL without credentials, query or fragment");
    }
    requireString(probe.publish.path, source, `${publishPath}.path`);
    if (probe.publish.path.length > 200 || !/^\/[A-Za-z0-9._~/-]+$/.test(probe.publish.path)
        || probe.publish.path.includes("//") || probe.publish.path.split("/").some((part) => part === "." || part === "..")) {
      fail(source, `${publishPath}.path`, "must be a normalized absolute URL path of at most 200 characters");
    }
    const published = new URL(probe.url);
    if (published.protocol !== "https:" || published.pathname !== probe.publish.path || published.search || published.hash) {
      fail(source, `${fieldPath}.url`, "must be an HTTPS URL with exactly the published Tailscale Serve path and no query or fragment");
    }
  }
}

function validateReported(reported, source, fieldPath) {
  requireObject(reported, source, fieldPath);
  rejectUnknownFields(reported, reportFields, source, fieldPath);
  requireEnum(reported.state, observedStates, source, `${fieldPath}.state`);
  if (reported.observedAt !== undefined) {
    requireString(reported.observedAt, source, `${fieldPath}.observedAt`);
    if (!Number.isFinite(Date.parse(reported.observedAt)) || !/T/.test(reported.observedAt)) {
      fail(source, `${fieldPath}.observedAt`, "must be an ISO 8601 date-time");
    }
  }
  if (reported.note !== undefined) requireString(reported.note, source, `${fieldPath}.note`);
}

function validateCommands(commands, source, fieldPath) {
  requireObject(commands, source, fieldPath);
  rejectUnknownFields(commands, commandFields, source, fieldPath);
  for (const [name, command] of Object.entries(commands)) validateCommand(command, source, `${fieldPath}.${name}`);
}

function validateServiceLinks(links, source, fieldPath) {
  requireArray(links, source, fieldPath);
  if (links.length > 50) fail(source, fieldPath, "must contain at most 50 links");
  const linkIds = new Set();
  for (const [index, link] of links.entries()) {
    const linkPath = `${fieldPath}[${index}]`;
    requireObject(link, source, linkPath);
    rejectUnknownFields(link, serviceLinkFields, source, linkPath);
    requireId(link.id, source, `${linkPath}.id`);
    if (linkIds.has(link.id)) fail(source, `${linkPath}.id`, `duplicates link ${link.id}`);
    linkIds.add(link.id);
    requireEnum(link.type, serviceLinkTypes, source, `${linkPath}.type`);
    requireString(link.label, source, `${linkPath}.label`);
    requireHttpUrl(link.url, source, `${linkPath}.url`);
  }
}

function validateServiceEndpoint(endpoint, source, fieldPath) {
  requireObject(endpoint, source, fieldPath);
  rejectUnknownFields(endpoint, serviceEndpointFields, source, fieldPath);
  if (endpoint.canonical !== undefined) requireHttpUrl(endpoint.canonical, source, `${fieldPath}.canonical`);
  if (endpoint.fallback === undefined) fail(source, `${fieldPath}.fallback`, "is required");
  requireHttpUrl(endpoint.fallback, source, `${fieldPath}.fallback`);
  if (endpoint.canonical === endpoint.fallback) {
    fail(source, fieldPath, "canonical and fallback must be different URLs");
  }
}

function validateDateTime(value, source, fieldPath) {
  requireString(value, source, fieldPath);
  if (!Number.isFinite(Date.parse(value)) || !/T/.test(value)) {
    fail(source, fieldPath, "must be an ISO 8601 date-time");
  }
}

function validateObservedDateTime(value, source, fieldPath) {
  validateDateTime(value, source, fieldPath);
  if (Date.parse(value) > Date.now() + 5 * 60 * 1000) {
    fail(source, fieldPath, "must not be more than five minutes in the future");
  }
}

function validateReadinessDefaults(defaults, source, fieldPath) {
  requireObject(defaults, source, fieldPath);
  rejectUnknownFields(defaults, readinessDefaultFields, source, fieldPath);
  if (Object.keys(defaults).length === 0) fail(source, fieldPath, "must contain at least one default");
  if (defaults.profile !== undefined) requireEnum(defaults.profile, readinessProfiles, source, `${fieldPath}.profile`);
  if (defaults.owner !== undefined) {
    requireString(defaults.owner, source, `${fieldPath}.owner`);
    if (secretAssignmentPattern.test(defaults.owner)) fail(source, `${fieldPath}.owner`, "must not contain an inline secret assignment");
  }
  if (defaults.dataClassification !== undefined) {
    requireEnum(defaults.dataClassification, dataClassifications, source, `${fieldPath}.dataClassification`);
  }
  if (defaults.costModel !== undefined) requireEnum(defaults.costModel, costModels, source, `${fieldPath}.costModel`);
}

function validateReadiness(readiness, source, fieldPath, defaultProfile) {
  requireObject(readiness, source, fieldPath);
  rejectUnknownFields(readiness, readinessFields, source, fieldPath);
  if (readiness.profile !== undefined) requireEnum(readiness.profile, readinessProfiles, source, `${fieldPath}.profile`);
  else if (defaultProfile === undefined) fail(source, `${fieldPath}.profile`, "is required when readinessDefaults.profile is absent");
  if (readiness.owner !== undefined) {
    requireString(readiness.owner, source, `${fieldPath}.owner`);
    if (secretAssignmentPattern.test(readiness.owner)) fail(source, `${fieldPath}.owner`, "must not contain an inline secret assignment");
  }
  if (readiness.dataClassification !== undefined) {
    requireEnum(readiness.dataClassification, dataClassifications, source, `${fieldPath}.dataClassification`);
  }
  if (readiness.costModel !== undefined) requireEnum(readiness.costModel, costModels, source, `${fieldPath}.costModel`);
  if (readiness.deployment !== undefined) {
    const deploymentPath = `${fieldPath}.deployment`;
    requireObject(readiness.deployment, source, deploymentPath);
    rejectUnknownFields(readiness.deployment, passportDeploymentFields, source, deploymentPath);
    requireEnum(readiness.deployment.source, readinessSources, source, `${deploymentPath}.source`);
    for (const field of ["provider", "revision"]) {
      if (readiness.deployment[field] !== undefined) {
        requireString(readiness.deployment[field], source, `${deploymentPath}.${field}`);
        if (secretAssignmentPattern.test(readiness.deployment[field])) fail(source, `${deploymentPath}.${field}`, "must not contain an inline secret assignment");
      }
    }
    if (readiness.deployment.revision !== undefined && readiness.deployment.revision.length > 200) {
      fail(source, `${deploymentPath}.revision`, "must contain at most 200 characters");
    }
    if (readiness.deployment.deployedAt !== undefined) validateDateTime(readiness.deployment.deployedAt, source, `${deploymentPath}.deployedAt`);
    if (readiness.deployment.url !== undefined) requireHttpUrl(readiness.deployment.url, source, `${deploymentPath}.url`);
  }
  if (readiness.dependencies !== undefined) {
    requireArray(readiness.dependencies, source, `${fieldPath}.dependencies`);
    if (readiness.dependencies.length > 50) fail(source, `${fieldPath}.dependencies`, "must contain at most 50 items");
    const dependencyIds = new Set();
    for (const [index, dependency] of readiness.dependencies.entries()) {
      const dependencyPath = `${fieldPath}.dependencies[${index}]`;
      requireObject(dependency, source, dependencyPath);
      rejectUnknownFields(dependency, passportDependencyFields, source, dependencyPath);
      requireId(dependency.id, source, `${dependencyPath}.id`);
      if (dependencyIds.has(dependency.id)) fail(source, `${dependencyPath}.id`, `duplicates dependency ${dependency.id}`);
      dependencyIds.add(dependency.id);
      requireEnum(dependency.kind, dependencyKinds, source, `${dependencyPath}.kind`);
      requireString(dependency.name, source, `${dependencyPath}.name`);
      requireEnum(dependency.criticality, dependencyCriticalities, source, `${dependencyPath}.criticality`);
      for (const field of ["provider", "note"]) {
        if (dependency[field] !== undefined) {
          requireString(dependency[field], source, `${dependencyPath}.${field}`);
          if (secretAssignmentPattern.test(dependency[field])) fail(source, `${dependencyPath}.${field}`, "must not contain an inline secret assignment");
        }
      }
      if (dependency.url !== undefined) requireHttpUrl(dependency.url, source, `${dependencyPath}.url`);
    }
  }
  requireArray(readiness.evidence, source, `${fieldPath}.evidence`);
  if (readiness.evidence.length > 50) fail(source, `${fieldPath}.evidence`, "must contain at most 50 items");
  const evidenceIds = new Set();
  for (const [index, evidence] of readiness.evidence.entries()) {
    const evidencePath = `${fieldPath}.evidence[${index}]`;
    requireObject(evidence, source, evidencePath);
    rejectUnknownFields(evidence, readinessEvidenceFields, source, evidencePath);
    requireId(evidence.id, source, `${evidencePath}.id`);
    if (evidenceIds.has(evidence.id)) fail(source, `${evidencePath}.id`, `duplicates evidence ${evidence.id}`);
    evidenceIds.add(evidence.id);
    requireEnum(evidence.check, readinessChecks, source, `${evidencePath}.check`);
    requireEnum(evidence.state, readinessStates, source, `${evidencePath}.state`);
    requireEnum(evidence.source, readinessSources, source, `${evidencePath}.source`);
    requireString(evidence.note, source, `${evidencePath}.note`);
    if (secretAssignmentPattern.test(evidence.note)) fail(source, `${evidencePath}.note`, "must not contain an inline secret assignment");
    if (evidence.observedAt !== undefined) validateDateTime(evidence.observedAt, source, `${evidencePath}.observedAt`);
    if (evidence.validUntil !== undefined) validateDateTime(evidence.validUntil, source, `${evidencePath}.validUntil`);
    if (evidence.observedAt !== undefined && evidence.validUntil !== undefined && Date.parse(evidence.validUntil) < Date.parse(evidence.observedAt)) {
      fail(source, `${evidencePath}.validUntil`, "must not be earlier than observedAt");
    }
    if (evidence.url !== undefined) requireHttpUrl(evidence.url, source, `${evidencePath}.url`);
  }
}

function validateStewardship(stewardship, stewardIds, source, fieldPath, { allowExplicitUnknown = false } = {}) {
  requireObject(stewardship, source, fieldPath);
  rejectUnknownFields(stewardship, stewardshipFields, source, fieldPath);
  if (Object.keys(stewardship).length === 0) fail(source, fieldPath, "must contain at least one role assignment");
  for (const [role, stewardId] of Object.entries(stewardship)) {
    if (stewardId === null && allowExplicitUnknown) continue;
    requireId(stewardId, source, `${fieldPath}.${role}`);
    if (!stewardIds.has(stewardId)) fail(source, `${fieldPath}.${role}`, `references unknown steward ${stewardId}`);
  }
}

function validateCredentialRef(reference, source, fieldPath) {
  requireObject(reference, source, fieldPath);
  rejectUnknownFields(reference, credentialRefFields, source, fieldPath);
  requireEnum(reference.kind, credentialRefKinds, source, `${fieldPath}.kind`);
  validateNonSecretMetadata(reference.locator, source, `${fieldPath}.locator`);
  if (reference.locator.length > 300) fail(source, `${fieldPath}.locator`, "must contain at most 300 characters");
  const valid = reference.kind === "environment"
    ? environmentRefPattern.test(reference.locator)
    : reference.kind === "keychain"
      ? keychainRefPattern.test(reference.locator)
      : secretManagerRefPattern.test(reference.locator);
  if (!valid) {
    const expected = reference.kind === "environment"
      ? "must name an uppercase environment variable"
      : reference.kind === "keychain"
        ? "must use generic-password:<service>:<account>"
        : "must use a non-secret op:// reference";
    fail(source, `${fieldPath}.locator`, expected);
  }
}

export function validateHostsDocument(document, source = "hosts.yaml") {
  requireObject(document, source, "$root");
  rejectUnknownFields(document, new Set(["version", "hosts"]), source, "$root");
  if (document.version !== 1) fail(source, "version", "must be 1");
  requireArray(document.hosts, source, "hosts");
  if (document.hosts.length === 0) fail(source, "hosts", "must not be empty");

  const hostIds = new Set();
  const tailscaleAddresses = new Set();
  for (const [index, host] of document.hosts.entries()) {
    const fieldPath = `hosts[${index}]`;
    requireObject(host, source, fieldPath);
    rejectUnknownFields(host, hostFields, source, fieldPath);
    requireId(host.id, source, `${fieldPath}.id`);
    if (hostIds.has(host.id)) fail(source, `${fieldPath}.id`, `duplicates host ${host.id}`);
    hostIds.add(host.id);
    requireString(host.name, source, `${fieldPath}.name`);
    requireEnum(host.kind, hostKinds, source, `${fieldPath}.kind`);
    requireEnum(host.location, hostLocations, source, `${fieldPath}.location`);
    if (host.tailscaleName !== undefined) requireString(host.tailscaleName, source, `${fieldPath}.tailscaleName`);
    if (host.tailscaleIPv4 !== undefined) {
      validateTailscaleIPv4(host.tailscaleIPv4, source, `${fieldPath}.tailscaleIPv4`);
      if (tailscaleAddresses.has(host.tailscaleIPv4)) fail(source, `${fieldPath}.tailscaleIPv4`, `duplicates address ${host.tailscaleIPv4}`);
      tailscaleAddresses.add(host.tailscaleIPv4);
    }
  }
  return { hostIds };
}

export function validateProjectDocument(project, { source = "project.yaml", hostIds, expectedId } = {}) {
  requireObject(project, source, "$root");
  rejectUnknownFields(project, projectFields, source, "$root");
  if (project.version !== 1) fail(source, "version", "must be 1");
  requireId(project.id, source, "id");
  if (expectedId && project.id !== expectedId) fail(source, "id", `must match filename ${expectedId}.yaml`);
  requireString(project.title, source, "title");
  requireEnum(project.registration, registrations, source, "registration");
  requireString(project.description, source, "description");
  requireEnum(project.lifecycle, lifecycles, source, "lifecycle");
  requireString(project.kind, source, "kind");
  if (project.repository !== undefined) {
    requireString(project.repository, source, "repository");
    if (!/^[^/\s]+\/[^/\s]+$/.test(project.repository)) fail(source, "repository", "must use owner/repository form");
  }
  for (const field of ["aliases", "tags"]) {
    if (project[field] !== undefined) {
      requireArray(project[field], source, field);
      const seen = new Set();
      for (const [index, value] of project[field].entries()) {
        if (field === "tags") requireId(value, source, `${field}[${index}]`);
        else requireString(value, source, `${field}[${index}]`);
        if (seen.has(value)) fail(source, `${field}[${index}]`, `duplicates ${JSON.stringify(value)}`);
        seen.add(value);
      }
    }
  }

  if (project.workspaces !== undefined) {
    requireArray(project.workspaces, source, "workspaces");
    for (const [index, workspace] of project.workspaces.entries()) {
      const fieldPath = `workspaces[${index}]`;
      requireObject(workspace, source, fieldPath);
      rejectUnknownFields(workspace, workspaceFields, source, fieldPath);
      requireId(workspace.host, source, `${fieldPath}.host`);
      if (hostIds && !hostIds.has(workspace.host)) fail(source, `${fieldPath}.host`, `references unknown host ${workspace.host}`);
      requireString(workspace.path, source, `${fieldPath}.path`);
    }
  }

  if (project.readinessDefaults !== undefined) {
    validateReadinessDefaults(project.readinessDefaults, source, "readinessDefaults");
  }

  const stewardIds = new Set();
  if (project.stewards !== undefined) {
    requireArray(project.stewards, source, "stewards");
    if (project.stewards.length > 100) fail(source, "stewards", "must contain at most 100 items");
    for (const [index, steward] of project.stewards.entries()) {
      const fieldPath = `stewards[${index}]`;
      requireObject(steward, source, fieldPath);
      rejectUnknownFields(steward, stewardFields, source, fieldPath);
      requireId(steward.id, source, `${fieldPath}.id`);
      if (stewardIds.has(steward.id)) fail(source, `${fieldPath}.id`, `duplicates steward ${steward.id}`);
      stewardIds.add(steward.id);
      validateNonSecretMetadata(steward.name, source, `${fieldPath}.name`);
      requireEnum(steward.kind, stewardKinds, source, `${fieldPath}.kind`);
      requireEnum(steward.source, stewardshipSources, source, `${fieldPath}.source`);
      if (steward.observedAt !== undefined) validateObservedDateTime(steward.observedAt, source, `${fieldPath}.observedAt`);
      if (steward.validUntil !== undefined) validateDateTime(steward.validUntil, source, `${fieldPath}.validUntil`);
      if (steward.observedAt !== undefined && steward.validUntil !== undefined && Date.parse(steward.validUntil) < Date.parse(steward.observedAt)) {
        fail(source, `${fieldPath}.validUntil`, "must not be earlier than observedAt");
      }
    }
  }
  if (project.stewardshipDefaults !== undefined) {
    validateStewardship(project.stewardshipDefaults, stewardIds, source, "stewardshipDefaults");
  }

  if (project.access !== undefined) {
    requireArray(project.access, source, "access");
    if (project.access.length > 100) fail(source, "access", "must contain at most 100 items");
    const accessIds = new Set();
    const accessSubjects = new Set();
    for (const [index, fact] of project.access.entries()) {
      const fieldPath = `access[${index}]`;
      requireObject(fact, source, fieldPath);
      rejectUnknownFields(fact, accessFactFields, source, fieldPath);
      requireId(fact.id, source, `${fieldPath}.id`);
      if (accessIds.has(fact.id)) fail(source, `${fieldPath}.id`, `duplicates access fact ${fact.id}`);
      accessIds.add(fact.id);
      requireEnum(fact.kind, accessKinds, source, `${fieldPath}.kind`);
      validateNonSecretMetadata(fact.subject, source, `${fieldPath}.subject`);
      const logicalSubject = `${fact.kind}\u0000${fact.subject.trim().toLocaleLowerCase("en-US")}`;
      if (accessSubjects.has(logicalSubject)) {
        fail(source, `${fieldPath}.subject`, `duplicates logical ${fact.kind} access subject ${fact.subject.trim()}`);
      }
      accessSubjects.add(logicalSubject);
      requireEnum(fact.access, accessStates, source, `${fieldPath}.access`);
      requireEnum(fact.source, stewardshipSources, source, `${fieldPath}.source`);
      validateNonSecretMetadata(fact.note, source, `${fieldPath}.note`);
      if (fact.observedAt !== undefined) validateObservedDateTime(fact.observedAt, source, `${fieldPath}.observedAt`);
      if (fact.validUntil !== undefined) validateDateTime(fact.validUntil, source, `${fieldPath}.validUntil`);
      if (fact.observedAt !== undefined && fact.validUntil !== undefined && Date.parse(fact.validUntil) < Date.parse(fact.observedAt)) {
        fail(source, `${fieldPath}.validUntil`, "must not be earlier than observedAt");
      }
    }
  }

  requireArray(project.services, source, "services");
  const serviceIds = new Set();
  for (const [index, service] of project.services.entries()) {
    const fieldPath = `services[${index}]`;
    requireObject(service, source, fieldPath);
    rejectUnknownFields(service, serviceFields, source, fieldPath);
    requireId(service.id, source, `${fieldPath}.id`);
    if (serviceIds.has(service.id)) fail(source, `${fieldPath}.id`, `duplicates service ${service.id}`);
    serviceIds.add(service.id);
    for (const field of ["name", "kind", "environment", "runtime"]) requireString(service[field], source, `${fieldPath}.${field}`);
    if (service.runtimeIdentifier !== undefined && !runtimeIdentifierPattern.test(service.runtimeIdentifier)) {
      fail(source, `${fieldPath}.runtimeIdentifier`, "must be a bounded runtime-native identifier");
    }
    requireId(service.host, source, `${fieldPath}.host`);
    if (hostIds && !hostIds.has(service.host)) fail(source, `${fieldPath}.host`, `references unknown host ${service.host}`);
    requireEnum(service.mode, modes, source, `${fieldPath}.mode`);
    requireEnum(service.visibility, visibilities, source, `${fieldPath}.visibility`);
    if (service.description !== undefined) requireString(service.description, source, `${fieldPath}.description`);
    if (service.url !== undefined) requireHttpUrl(service.url, source, `${fieldPath}.url`);
    if (service.endpoint !== undefined) validateServiceEndpoint(service.endpoint, source, `${fieldPath}.endpoint`);
    if (service.readiness !== undefined) {
      validateReadiness(service.readiness, source, `${fieldPath}.readiness`, project.readinessDefaults?.profile);
    }
    if (service.stewardship !== undefined) {
      validateStewardship(service.stewardship, stewardIds, source, `${fieldPath}.stewardship`, { allowExplicitUnknown: true });
    }
    if (service.links !== undefined) validateServiceLinks(service.links, source, `${fieldPath}.links`);
    if (service.probe !== undefined) validateProbe(service.probe, source, `${fieldPath}.probe`);
    if (service.reported !== undefined) validateReported(service.reported, source, `${fieldPath}.reported`);
    if (service.commands !== undefined) validateCommands(service.commands, source, `${fieldPath}.commands`);
  }

  if (project.credentials !== undefined) {
    requireArray(project.credentials, source, "credentials");
    if (project.credentials.length > 100) fail(source, "credentials", "must contain at most 100 items");
    const credentialIds = new Set();
    for (const [index, credential] of project.credentials.entries()) {
      const fieldPath = `credentials[${index}]`;
      requireObject(credential, source, fieldPath);
      rejectUnknownFields(credential, credentialFields, source, fieldPath);
      requireId(credential.id, source, `${fieldPath}.id`);
      if (credentialIds.has(credential.id)) fail(source, `${fieldPath}.id`, `duplicates credential ${credential.id}`);
      credentialIds.add(credential.id);
      for (const field of ["provider", "purpose"]) {
        validateNonSecretMetadata(credential[field], source, `${fieldPath}.${field}`);
      }
      validateCredentialRef(credential.secretRef, source, `${fieldPath}.secretRef`);
      requireArray(credential.consumers, source, `${fieldPath}.consumers`);
      if (credential.consumers.length > 50) fail(source, `${fieldPath}.consumers`, "must contain at most 50 items");
      const consumers = new Set();
      for (const [consumerIndex, serviceId] of credential.consumers.entries()) {
        requireId(serviceId, source, `${fieldPath}.consumers[${consumerIndex}]`);
        if (consumers.has(serviceId)) fail(source, `${fieldPath}.consumers[${consumerIndex}]`, `duplicates consumer ${serviceId}`);
        if (!serviceIds.has(serviceId)) fail(source, `${fieldPath}.consumers[${consumerIndex}]`, `references unknown service ${serviceId}`);
        consumers.add(serviceId);
      }
      for (const role of ["owner", "payer"]) {
        if (credential[role] === undefined && role === "payer") continue;
        requireId(credential[role], source, `${fieldPath}.${role}`);
        if (!stewardIds.has(credential[role])) fail(source, `${fieldPath}.${role}`, `references unknown steward ${credential[role]}`);
      }
      requireEnum(credential.source, stewardshipSources, source, `${fieldPath}.source`);
      if (credential.lastVerifiedAt !== undefined) validateObservedDateTime(credential.lastVerifiedAt, source, `${fieldPath}.lastVerifiedAt`);
      if (credential.rotationDueAt !== undefined) validateDateTime(credential.rotationDueAt, source, `${fieldPath}.rotationDueAt`);
      if (credential.lastVerifiedAt !== undefined && credential.rotationDueAt !== undefined && Date.parse(credential.rotationDueAt) < Date.parse(credential.lastVerifiedAt)) {
        fail(source, `${fieldPath}.rotationDueAt`, "must not be earlier than lastVerifiedAt");
      }
    }
  }
  return project;
}
