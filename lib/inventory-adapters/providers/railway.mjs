const RAILWAY_GRAPHQL_URL = "https://backboard.railway.com/graphql/v2";
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const HARD_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const PAGE_SIZE = 50;

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORBIDDEN_QUERY_PATTERN = /\b(?:mutation|variables|deploymentLogs|logs|metrics)\b/i;

const PROJECTS_QUERY = `
  query DevHubRailwayProjects($workspaceId: String!, $first: Int!, $after: String) {
    workspace(workspaceId: $workspaceId) {
      id
      projects(first: $first, after: $after) {
        edges { cursor node { id name } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const PROJECT_QUERY = `
  query DevHubRailwayProject($projectId: String!) {
    project(id: $projectId) {
      id
      name
      services(first: 50) {
        edges { node { id name } }
        pageInfo { hasNextPage }
      }
      environments(first: 50) {
        edges { node { id name } }
        pageInfo { hasNextPage }
      }
    }
  }
`;

const RUNTIME_QUERY = `
  query DevHubRailwayRuntime($projectId: String!, $serviceId: String!, $environmentId: String!) {
    deployments(
      input: { projectId: $projectId, serviceId: $serviceId, environmentId: $environmentId }
      first: 1
    ) {
      edges { node { id status createdAt } }
    }
    domains(projectId: $projectId, serviceId: $serviceId, environmentId: $environmentId) {
      customDomains { id domain }
      serviceDomains { id domain }
    }
  }
`;

for (const query of [PROJECTS_QUERY, PROJECT_QUERY, RUNTIME_QUERY]) {
  if (FORBIDDEN_QUERY_PATTERN.test(query)) {
    throw new Error("Railway inventory query must remain read-only and metadata-only");
  }
}

export const RAILWAY_INVENTORY_ADAPTER_ID = "railway-inventory-v1";

export function createRailwayInventoryAdapter({
  fetch: fetchImpl = globalThis.fetch,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("Railway inventory adapter requires an injected fetch function");
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > HARD_MAX_RESPONSE_BYTES) {
    throw new TypeError(`Railway inventory maxResponseBytes must be between 1 and ${HARD_MAX_RESPONSE_BYTES}`);
  }

  return Object.freeze({
    id: RAILWAY_INVENTORY_ADAPTER_ID,
    provider: "railway",
    validateScope,
    async collect(request) {
      if (request?.provider !== "railway" || !validateScope(request?.scope)) {
        return unavailable("binding-not-applicable");
      }
      if (typeof request.credential !== "string" || request.credential.length === 0) {
        return unavailable("credential-unavailable");
      }
      if (!validRequest(request)) return unavailable("invalid-adapter-request");

      const observedAt = new Date(request.now).toISOString();
      const state = createRequestState(
        request,
        fetchImpl,
        Math.min(maxResponseBytes, request.limits.maxResponseBytes ?? maxResponseBytes),
      );
      try {
        const projects = await collectProjects(state, request.scope);
        if (!projects.ok) return unavailable(projects.reason);

        const candidates = [];
        for (const summary of projects.value) {
          const projectResult = await state.graphql(PROJECT_QUERY, { projectId: summary.id });
          if (!projectResult.ok) return unavailable(projectResult.reason);
          const project = parseProject(projectResult.value, summary);
          if (!project.ok) return unavailable(project.reason);

          candidates.push(projectCandidate(project.value, workspaceIdForScope(request.scope), observedAt));
          if (candidates.length > request.limits.maxResources) return unavailable("provider-resource-limit-exceeded");

          for (const service of project.value.services) {
            for (const environment of project.value.environments) {
              const runtimeResult = await state.graphql(RUNTIME_QUERY, {
                projectId: project.value.id,
                serviceId: service.id,
                environmentId: environment.id,
              });
              if (!runtimeResult.ok) return unavailable(runtimeResult.reason);
              const runtime = parseRuntime(runtimeResult.value);
              if (!runtime.ok) return unavailable(runtime.reason);
              candidates.push(serviceCandidate({
                project: project.value,
                service,
                environment,
                runtime: runtime.value,
                observedAt,
              }));
              if (candidates.length > request.limits.maxResources) return unavailable("provider-resource-limit-exceeded");
            }
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

export const railwayInventoryAdapter = createRailwayInventoryAdapter();

function validateScope(scope) {
  if (!plainObject(scope)) return false;
  if (scope.kind === "workspace") {
    return exactKeys(scope, ["id", "kind"]) && validId(scope.id);
  }
  return scope.kind === "project"
    && exactKeys(scope, ["id", "kind", "parent"])
    && validId(scope.id)
    && plainObject(scope.parent)
    && scope.parent.kind === "workspace"
    && exactKeys(scope.parent, ["id", "kind"])
    && validId(scope.parent.id);
}

function validRequest(request) {
  const limits = request.limits;
  return plainObject(limits)
    && !Number.isNaN(Date.parse(request.now))
    && Number.isSafeInteger(limits.maxResources)
    && limits.maxResources > 0
    && Number.isSafeInteger(limits.maxPages)
    && limits.maxPages > 0
    && Number.isSafeInteger(limits.deadlineMs)
    && limits.deadlineMs > 0
    && (limits.maxResponseBytes === undefined
      || (Number.isSafeInteger(limits.maxResponseBytes) && limits.maxResponseBytes > 0))
    && (!request.signal || typeof request.signal.addEventListener === "function");
}

function createRequestState(request, fetchImpl, maxResponseBytes) {
  const controller = new AbortController();
  let timedOut = false;
  let pageCount = 0;
  let externalAbortHandler;
  let resolveDeadline;
  const deadline = new Promise((resolve) => {
    resolveDeadline = resolve;
  });

  if (request.signal) {
    externalAbortHandler = () => {
      controller.abort();
      resolveDeadline({ ok: false, reason: "provider-unavailable" });
    };
    if (request.signal.aborted) externalAbortHandler();
    request.signal.addEventListener("abort", externalAbortHandler, { once: true });
  }
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
    resolveDeadline({ ok: false, reason: "provider-timeout" });
  }, request.limits.deadlineMs);

  async function graphql(query, variables) {
    if (![PROJECTS_QUERY, PROJECT_QUERY, RUNTIME_QUERY].includes(query)) {
      return { ok: false, reason: "provider-query-not-allowlisted" };
    }
    if (pageCount >= request.limits.maxPages) {
      return { ok: false, reason: "provider-page-limit-exceeded" };
    }
    pageCount += 1;

    const operation = (async () => {
      const response = await fetchImpl(RAILWAY_GRAPHQL_URL, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${request.credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        return { ok: false, reason: "provider-access-denied" };
      }
      if (!response.ok) return { ok: false, reason: "provider-unavailable" };
      const parsed = await boundedJson(response, maxResponseBytes);
      if (!parsed.ok) return parsed;
      if (Array.isArray(parsed.value?.errors) && parsed.value.errors.length > 0) {
        return { ok: false, reason: "provider-query-failed" };
      }
      if (!plainObject(parsed.value?.data)) return { ok: false, reason: "provider-invalid-response" };
      return { ok: true, value: parsed.value.data };
    })();
    try {
      return await Promise.race([operation, deadline]);
    } catch {
      return { ok: false, reason: timedOut ? "provider-timeout" : "provider-unavailable" };
    }
  }

  return {
    graphql,
    pagesRead: () => pageCount,
    didTimeout: () => timedOut,
    dispose() {
      clearTimeout(timeout);
      if (request.signal && externalAbortHandler) request.signal.removeEventListener("abort", externalAbortHandler);
    },
  };
}

async function boundedJson(response, maximum) {
  if (!response.body || typeof response.body.getReader !== "function") {
    return { ok: false, reason: "provider-empty-response" };
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        return { ok: false, reason: "provider-response-too-large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "provider-unavailable" };
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, reason: "provider-invalid-json" };
  }
}

async function collectProjects(state, scope) {
  const workspaceId = workspaceIdForScope(scope);
  const projects = [];
  let after = null;
  while (true) {
    const result = await state.graphql(PROJECTS_QUERY, { workspaceId, first: PAGE_SIZE, after });
    if (!result.ok) return result;
    const workspace = result.value.workspace;
    if (!plainObject(workspace) || workspace.id !== workspaceId) {
      return { ok: false, reason: "provider-scope-mismatch" };
    }
    const connection = parseConnection(workspace.projects, parseProjectSummary);
    if (!connection.ok) return connection;
    for (const project of connection.value.items) {
      if (scope.kind === "workspace" || project.id === scope.id) projects.push(project);
    }
    if (scope.kind === "project" && projects.length > 0) break;
    if (!connection.value.hasNextPage) break;
    after = connection.value.endCursor;
  }
  if (scope.kind === "project" && projects.length !== 1) {
    return { ok: false, reason: "provider-scope-mismatch" };
  }
  return { ok: true, value: projects };
}

function parseProject(data, summary) {
  const project = data.project;
  if (!plainObject(project) || project.id !== summary.id || project.name !== summary.name || !validName(project.name)) {
    return { ok: false, reason: "provider-identity-mismatch" };
  }
  const services = parseFiniteConnection(project.services, parseService);
  if (!services.ok) return services;
  const environments = parseFiniteConnection(project.environments, parseEnvironment);
  if (!environments.ok) return environments;
  return { ok: true, value: { id: project.id, name: project.name, services: services.value, environments: environments.value } };
}

function parseRuntime(data) {
  if (!plainObject(data.deployments) || !Array.isArray(data.deployments.edges) || data.deployments.edges.length > 1) {
    return { ok: false, reason: "provider-invalid-response" };
  }
  let deployment = null;
  if (data.deployments.edges.length === 1) {
    const node = data.deployments.edges[0]?.node;
    if (!plainObject(node) || !validId(node.id) || !validName(node.status) || !validIso(node.createdAt)) {
      return { ok: false, reason: "provider-invalid-response" };
    }
    deployment = { id: node.id, status: mapRailwayStatus(node.status) };
  }
  if (!plainObject(data.domains) || !Array.isArray(data.domains.customDomains) || !Array.isArray(data.domains.serviceDomains)) {
    return { ok: false, reason: "provider-invalid-response" };
  }
  const urls = [];
  for (const item of [...data.domains.customDomains, ...data.domains.serviceDomains]) {
    if (!plainObject(item) || !validId(item.id)) return { ok: false, reason: "provider-invalid-response" };
    const url = domainUrl(item.domain);
    if (!url) return { ok: false, reason: "provider-invalid-response" };
    if (!urls.some((candidate) => candidate.url === url)) urls.push({ kind: "service", url });
  }
  return { ok: true, value: { deployment, urls } };
}

function parseConnection(value, parseNode) {
  if (!plainObject(value) || !Array.isArray(value.edges) || !plainObject(value.pageInfo)) {
    return { ok: false, reason: "provider-invalid-response" };
  }
  const { hasNextPage, endCursor } = value.pageInfo;
  if (typeof hasNextPage !== "boolean" || (hasNextPage && !validCursor(endCursor))) {
    return { ok: false, reason: "provider-invalid-response" };
  }
  const items = [];
  const cursors = new Set();
  for (const edge of value.edges) {
    if (!plainObject(edge) || !validCursor(edge.cursor) || cursors.has(edge.cursor)) {
      return { ok: false, reason: "provider-invalid-response" };
    }
    cursors.add(edge.cursor);
    const parsed = parseNode(edge.node);
    if (!parsed) return { ok: false, reason: "provider-invalid-response" };
    items.push(parsed);
  }
  return { ok: true, value: { items, hasNextPage, endCursor: hasNextPage ? endCursor : null } };
}

function parseFiniteConnection(value, parseNode) {
  if (!plainObject(value) || !Array.isArray(value.edges) || !plainObject(value.pageInfo) || typeof value.pageInfo.hasNextPage !== "boolean") {
    return { ok: false, reason: "provider-invalid-response" };
  }
  if (value.pageInfo.hasNextPage) return { ok: false, reason: "provider-resource-limit-exceeded" };
  const items = [];
  const ids = new Set();
  for (const edge of value.edges) {
    const parsed = parseNode(edge?.node);
    if (!parsed || ids.has(parsed.id)) return { ok: false, reason: "provider-invalid-response" };
    ids.add(parsed.id);
    items.push(parsed);
  }
  return { ok: true, value: items };
}

function parseProjectSummary(node) {
  return plainObject(node) && validId(node.id) && validName(node.name) ? { id: node.id, name: node.name } : null;
}

function parseService(node) {
  if (!plainObject(node) || !validId(node.id) || !validName(node.name)) return null;
  const repository = parseRepository(node.source?.repo);
  return { id: node.id, name: node.name, ...(repository ? { repository } : {}) };
}

function parseEnvironment(node) {
  return plainObject(node) && validId(node.id) && validName(node.name) ? { id: node.id, name: node.name } : null;
}

function parseRepository(value) {
  if (typeof value !== "string") return null;
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9._-]{1,100})$/.exec(value);
  if (!match || match[2] === "." || match[2] === "..") return null;
  return { provider: "github", owner: match[1], name: match[2] };
}

function projectCandidate(project, workspaceId, observedAt) {
  return {
    provider: "railway",
    resourceType: "project",
    resourceId: project.id,
    parentResourceId: workspaceId,
    name: project.name,
    urls: [],
    observedAt,
    metadata: { workspaceId, projectId: project.id },
  };
}

function serviceCandidate({ project, service, environment, runtime, observedAt }) {
  return {
    provider: "railway",
    resourceType: "service-instance",
    resourceId: `${service.id}:${environment.id}`,
    parentResourceId: project.id,
    name: service.name,
    environment: environment.name,
    status: runtime.deployment?.status ?? "unknown",
    urls: runtime.urls,
    ...(service.repository ? { repository: service.repository } : {}),
    observedAt,
    metadata: {
      projectId: project.id,
      serviceId: service.id,
      environmentId: environment.id,
      ...(runtime.deployment ? { deploymentId: runtime.deployment.id } : {}),
    },
  };
}

function mapRailwayStatus(value) {
  const status = value.toUpperCase();
  if (status === "SUCCESS") return "running";
  if (["SLEEPING", "REMOVED", "SKIPPED"].includes(status)) return "stopped";
  if (["FAILED", "CRASHED"].includes(status)) return "failed";
  if (["BUILDING", "DEPLOYING", "INITIALIZING", "WAITING", "QUEUED"].includes(status)) return "deploying";
  return "unknown";
}

function domainUrl(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 253 || value !== value.trim()) return null;
  try {
    const url = new URL(`https://${value.toLowerCase()}`);
    if (url.hostname !== value.toLowerCase() || url.pathname !== "/" || url.search || url.hash || url.username || url.password) return null;
    if (!url.hostname.includes(".") || /[^a-z0-9.-]/.test(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function validId(value) {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function validName(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 255
    && ![...value].some((character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127);
}

function validCursor(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && ![...value].some((character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127);
}

function validIso(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function workspaceIdForScope(scope) {
  return scope.kind === "workspace" ? scope.id : scope.parent.id;
}

function exactKeys(value, keys) {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unavailable(reason) {
  return { status: "unavailable", reason };
}
