import {
  createVercelRequestState,
  validateVercelDeploymentId,
  validateVercelProjectId,
  validateVercelScope,
  verifyVercelScope,
} from "../../vercel-api.mjs";

const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const HARD_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const PAGE_SIZE = 100;

export const VERCEL_INVENTORY_ADAPTER_ID = "vercel-inventory-v1";

export function createVercelInventoryAdapter({
  fetch: fetchImpl = globalThis.fetch,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("Vercel inventory adapter requires an injected fetch function");
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > HARD_MAX_RESPONSE_BYTES) {
    throw new TypeError(`Vercel inventory maxResponseBytes must be between 1 and ${HARD_MAX_RESPONSE_BYTES}`);
  }

  return Object.freeze({
    id: VERCEL_INVENTORY_ADAPTER_ID,
    provider: "vercel",
    validateScope: validateVercelScope,
    async collect(request) {
      if (request?.provider !== "vercel" || !validateVercelScope(request?.scope)) return unavailable("binding-not-applicable");
      if (typeof request.credential !== "string" || request.credential.length === 0) return unavailable("credential-unavailable");
      if (!validRequest(request)) return unavailable("invalid-adapter-request");

      const observedAt = new Date(request.now).toISOString();
      let state;
      try {
        state = createVercelRequestState({
          fetch: fetchImpl,
          credential: request.credential,
          scope: request.scope,
          deadlineMs: request.limits.deadlineMs,
          maxPages: request.limits.maxPages,
          maxResponseBytes: Math.min(maxResponseBytes, request.limits.maxResponseBytes ?? maxResponseBytes),
          signal: request.signal,
        });
      } catch {
        return unavailable("invalid-adapter-request");
      }

      try {
        const verifiedScope = await verifyVercelScope(state, request.scope);
        if (!verifiedScope.ok) return unavailable(verifiedScope.reason);
        const projects = await collectProjects(state, request.scope);
        if (!projects.ok) return unavailable(projects.reason);

        const candidates = [];
        for (const project of projects.value) {
          candidates.push(projectCandidate(project, request.scope, observedAt));
          if (candidates.length > request.limits.maxResources) return unavailable("provider-resource-limit-exceeded");

          const currentProduction = await collectCurrentProduction(state, request.scope, project);
          if (!currentProduction.ok) return unavailable(currentProduction.reason);
          let domains = [];
          if (currentProduction.value !== null) {
            const observedDomains = await collectProjectDomains(state, request.scope, project.id);
            if (!observedDomains.ok) return unavailable(observedDomains.reason);
            domains = observedDomains.value;
            candidates.push(deploymentCandidate({
              project,
              deployment: currentProduction.value,
              domains,
              environment: "production",
              observedAt,
            }));
            if (candidates.length > request.limits.maxResources) return unavailable("provider-resource-limit-exceeded");
          }

          const latestProduction = await collectLatestDeployment(state, request.scope, project.id, "production");
          if (!latestProduction.ok) return unavailable(latestProduction.reason);
          if (latestProduction.value !== null && latestProduction.value.id !== currentProduction.value?.id) {
            candidates.push(deploymentAttemptCandidate({
              project,
              deployment: latestProduction.value,
              observedAt,
            }));
            if (candidates.length > request.limits.maxResources) return unavailable("provider-resource-limit-exceeded");
          }

          const preview = await collectLatestDeployment(state, request.scope, project.id, "preview");
          if (!preview.ok) return unavailable(preview.reason);
          if (preview.value !== null) {
            candidates.push(deploymentCandidate({
              project,
              deployment: { ...preview.value, urls: preview.value.urls.slice(0, 1) },
              domains: [],
              environment: "preview",
              observedAt,
            }));
            if (candidates.length > request.limits.maxResources) return unavailable("provider-resource-limit-exceeded");
          }
        }

        return { status: "success", observedAt, pagesRead: state.pagesRead(), candidates };
      } catch {
        return unavailable(state.didTimeout() ? "provider-timeout" : "provider-unavailable");
      } finally {
        state.dispose();
      }
    },
  });
}

export const vercelInventoryAdapter = createVercelInventoryAdapter();

async function collectProjects(state, scope) {
  const projects = [];
  const ids = new Set();
  let until;
  const cursors = new Set();
  while (true) {
    const result = await state.get("/v9/projects", scopedQuery(scope, { limit: PAGE_SIZE, ...(until ? { until } : {}) }));
    if (!result.ok) return result;
    if (!plainObject(result.value) || !Array.isArray(result.value.projects)) return unavailableResult("provider-invalid-response");
    for (const value of result.value.projects) {
      const project = parseProject(value);
      if (!project || ids.has(project.id)) return unavailableResult("provider-invalid-response");
      ids.add(project.id);
      projects.push(project);
    }
    const pagination = parsePagination(result.value.pagination);
    if (!pagination.ok) return pagination;
    if (pagination.value === null) break;
    if (cursors.has(pagination.value)) return unavailableResult("provider-invalid-pagination");
    cursors.add(pagination.value);
    until = pagination.value;
  }
  return { ok: true, value: projects };
}

async function collectProjectDomains(state, scope, projectId) {
  const domains = [];
  const names = new Set();
  let until;
  const cursors = new Set();
  while (true) {
    const result = await state.get(
      `/v9/projects/${encodeURIComponent(projectId)}/domains`,
      scopedQuery(scope, { limit: PAGE_SIZE, ...(until ? { until } : {}) }),
    );
    if (!result.ok) return result;
    if (!plainObject(result.value) || !Array.isArray(result.value.domains)) return unavailableResult("provider-invalid-response");
    for (const value of result.value.domains) {
      const domain = parseProductionDomain(value);
      if (domain === false) return unavailableResult("provider-invalid-response");
      if (domain !== null && !names.has(domain)) {
        names.add(domain);
        domains.push(domain);
      }
    }
    const pagination = parsePagination(result.value.pagination);
    if (!pagination.ok) return pagination;
    if (pagination.value === null) break;
    if (cursors.has(pagination.value)) return unavailableResult("provider-invalid-pagination");
    cursors.add(pagination.value);
    until = pagination.value;
  }
  return { ok: true, value: domains };
}

async function collectCurrentProduction(state, scope, project) {
  const result = await state.get(
    `/v9/projects/${encodeURIComponent(project.id)}`,
    scopedQuery(scope, {}),
  );
  if (!result.ok) return result;
  if (!plainObject(result.value) || result.value.id !== project.id || result.value.name !== project.name) {
    return unavailableResult("provider-identity-mismatch");
  }
  if (result.value.targets === undefined || result.value.targets === null) return { ok: true, value: null };
  if (!plainObject(result.value.targets)) return unavailableResult("provider-invalid-response");
  const target = result.value.targets.production;
  if (target === undefined || target === null) return { ok: true, value: null };
  const deployment = parseCurrentProductionTarget(target, project.id);
  if (deployment === false) return unavailableResult("provider-invalid-response");
  return { ok: true, value: deployment };
}

async function collectLatestDeployment(state, scope, projectId, environment) {
  const result = await state.get("/v6/deployments", scopedQuery(scope, {
    projectId,
    target: environment,
    limit: 1,
  }));
  if (!result.ok) return result;
  if (!plainObject(result.value) || !Array.isArray(result.value.deployments) || result.value.deployments.length > 1) {
    return unavailableResult("provider-invalid-response");
  }
  const pagination = parsePagination(result.value.pagination);
  if (!pagination.ok) return pagination;
  if (result.value.deployments.length === 0) return { ok: true, value: null };
  const deployment = parseDeployment(result.value.deployments[0], projectId, environment);
  return deployment ? { ok: true, value: deployment } : unavailableResult("provider-invalid-response");
}

function parseProject(value) {
  if (!plainObject(value) || !validateVercelProjectId(value.id) || !validName(value.name)) return null;
  return { id: value.id, name: value.name };
}

function parseProductionDomain(value) {
  if (!plainObject(value)) return false;
  if (typeof value.verified !== "boolean") return false;
  if (value.gitBranch !== undefined && value.gitBranch !== null && !validName(value.gitBranch)) return false;
  if (value.customEnvironmentId !== undefined && value.customEnvironmentId !== null && !validName(value.customEnvironmentId)) return false;
  if (!value.verified || value.gitBranch || value.customEnvironmentId) return null;
  return domainUrl(value.name) ?? false;
}

function parseDeployment(value, projectId, environment) {
  if (!plainObject(value) || !validateVercelDeploymentId(value.uid ?? value.id)) return null;
  const id = value.uid ?? value.id;
  if (value.projectId !== projectId || !validTimestamp(value.created ?? value.createdAt)) return null;
  if (environment === "production" && value.target !== "production") return null;
  if (environment === "preview" && value.target !== "preview" && value.target !== null) return null;
  const status = mapVercelStatus(value.readyState ?? value.state);
  const deployedAt = normalizeTimestamp(value.created ?? value.createdAt);
  const urls = [];
  const deploymentUrl = domainUrl(value.url);
  if (!deploymentUrl) return null;
  urls.push(deploymentUrl);
  if (value.alias !== undefined) {
    if (!Array.isArray(value.alias) || value.alias.length > 20) return null;
    for (const alias of value.alias) {
      const url = domainUrl(alias);
      if (!url) return null;
      if (!urls.includes(url)) urls.push(url);
    }
  }
  const revision = deploymentRevision(value.meta);
  return { id, status, deployedAt, urls, ...(revision ? { revision } : {}) };
}

function parseCurrentProductionTarget(value, projectId) {
  if (!plainObject(value) || !validateVercelDeploymentId(value.id ?? value.uid)) return false;
  if (value.projectId !== undefined && value.projectId !== projectId) return false;
  if (value.target !== undefined && value.target !== null && value.target !== "production") return false;
  if (!validTimestamp(value.created ?? value.createdAt)) return false;
  const status = mapVercelStatus(value.readyState ?? value.state);
  const deployedAt = normalizeTimestamp(value.created ?? value.createdAt);
  const deploymentUrl = domainUrl(value.url);
  if (!deploymentUrl || !deployedAt) return false;
  if (status !== "running") return null;
  const urls = [deploymentUrl];
  if (value.alias !== undefined) {
    if (!Array.isArray(value.alias) || value.alias.length > 20) return false;
    for (const alias of value.alias) {
      const url = domainUrl(alias);
      if (!url) return false;
      if (!urls.includes(url)) urls.push(url);
    }
  }
  const revision = deploymentRevision(value.meta);
  return {
    id: value.id ?? value.uid,
    status,
    deployedAt,
    urls,
    ...(revision ? { revision } : {}),
  };
}

function deploymentRevision(meta) {
  if (!plainObject(meta)) return null;
  for (const field of ["githubCommitSha", "gitlabCommitSha", "bitbucketCommitSha"]) {
    if (typeof meta[field] === "string" && /^[0-9a-f]{7,64}$/i.test(meta[field])) return meta[field].toLowerCase();
  }
  return null;
}

function projectCandidate(project, scope, observedAt) {
  return {
    provider: "vercel",
    resourceType: "project",
    resourceId: project.id,
    parentResourceId: scope.id,
    name: project.name,
    urls: [],
    observedAt,
    metadata: { projectId: project.id },
  };
}

function deploymentCandidate({ project, deployment, domains, environment, observedAt }) {
  const urls = [];
  for (const url of [...deployment.urls, ...domains]) {
    if (!urls.some((entry) => entry.url === url)) urls.push({ kind: "service", url });
  }
  return {
    provider: "vercel",
    resourceType: "service-instance",
    resourceId: `${project.id}:${environment}`,
    parentResourceId: project.id,
    name: project.name,
    environment,
    runtime: "vercel",
    status: deployment.status,
    urls,
    observedAt,
    metadata: {
      projectId: project.id,
      environmentId: environment,
      deploymentId: deployment.id,
      deployedAt: deployment.deployedAt,
      ...(deployment.revision ? { revision: deployment.revision } : {}),
    },
  };
}

function deploymentAttemptCandidate({ project, deployment, observedAt }) {
  return {
    provider: "vercel",
    resourceType: "deployment-attempt",
    resourceId: deployment.id,
    parentResourceId: project.id,
    name: `${project.name} production attempt`,
    environment: "production",
    runtime: "vercel",
    status: deployment.status,
    urls: [{ kind: "service", url: deployment.urls[0] }],
    observedAt,
    metadata: {
      projectId: project.id,
      environmentId: "production",
      deploymentId: deployment.id,
      deployedAt: deployment.deployedAt,
      ...(deployment.revision ? { revision: deployment.revision } : {}),
    },
  };
}

function parsePagination(value) {
  if (!plainObject(value) || !("next" in value)) return unavailableResult("provider-invalid-response");
  if (value.next === null) return { ok: true, value: null };
  return Number.isSafeInteger(value.next) && value.next > 0
    ? { ok: true, value: value.next }
    : unavailableResult("provider-invalid-response");
}

function scopedQuery(scope, query) {
  return scope.kind === "team" ? { ...query, teamId: scope.id } : query;
}

function validRequest(request) {
  return plainObject(request.limits)
    && !Number.isNaN(Date.parse(request.now))
    && Number.isSafeInteger(request.limits.maxResources)
    && request.limits.maxResources > 0
    && Number.isSafeInteger(request.limits.maxPages)
    && request.limits.maxPages > 0
    && Number.isSafeInteger(request.limits.deadlineMs)
    && request.limits.deadlineMs > 0
    && (request.limits.maxResponseBytes === undefined
      || (Number.isSafeInteger(request.limits.maxResponseBytes) && request.limits.maxResponseBytes > 0))
    && (!request.signal || typeof request.signal.addEventListener === "function");
}

function mapVercelStatus(value) {
  if (typeof value !== "string") return "unknown";
  const status = value.toUpperCase();
  if (status === "READY") return "running";
  if (["BUILDING", "INITIALIZING", "QUEUED"].includes(status)) return "deploying";
  if (["ERROR", "FAILED"].includes(status)) return "failed";
  if (["CANCELED", "CANCELLED", "DELETED"].includes(status)) return "stopped";
  return "unknown";
}

function domainUrl(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 253 || value !== value.trim()) return null;
  try {
    const candidate = value.startsWith("https://") ? value : `https://${value}`;
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    if (!url.hostname.includes(".") || /[^a-z0-9.-]/.test(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function validTimestamp(value) {
  if (Number.isSafeInteger(value) && value > 0) return true;
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function normalizeTimestamp(value) {
  const date = Number.isSafeInteger(value) && value > 0 ? new Date(value) : new Date(value);
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

function validName(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 300
    && value === value.trim()
    && ![...value].some((character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127);
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unavailable(reason) {
  return { status: "unavailable", reason };
}

function unavailableResult(reason) {
  return { ok: false, reason };
}
