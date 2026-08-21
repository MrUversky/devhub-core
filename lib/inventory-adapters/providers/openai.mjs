import {
  createOpenAIAdminRequestState,
  listOpenAIProjectKeys,
  validateOpenAIProjectScope,
  verifyOpenAIProject,
} from "../../openai-admin-api.mjs";

const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const HARD_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export const OPENAI_PROJECT_INVENTORY_ADAPTER_ID = "openai-project-inventory-v1";

export function createOpenAIProjectInventoryAdapter({
  fetch: fetchImpl = globalThis.fetch,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("OpenAI project inventory adapter requires an injected fetch function");
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > HARD_MAX_RESPONSE_BYTES) {
    throw new TypeError(`OpenAI project inventory maxResponseBytes must be between 1 and ${HARD_MAX_RESPONSE_BYTES}`);
  }

  return Object.freeze({
    id: OPENAI_PROJECT_INVENTORY_ADAPTER_ID,
    provider: "openai",
    validateScope: validateOpenAIProjectScope,
    async collect(request) {
      if (request?.provider !== "openai" || !validateOpenAIProjectScope(request?.scope)) return unavailable("binding-not-applicable");
      if (typeof request.credential !== "string" || request.credential.length === 0) return unavailable("credential-unavailable");
      if (!validRequest(request)) return unavailable("invalid-adapter-request");

      const observedAt = new Date(request.now).toISOString();
      let state;
      try {
        state = createOpenAIAdminRequestState({
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
        const project = await verifyOpenAIProject(state, request.scope);
        if (!project.ok) return unavailable(project.reason);
        if (request.limits.maxResources < 1) return unavailable("provider-resource-limit-exceeded");
        const keys = await listOpenAIProjectKeys(state, request.scope, {
          maxKeys: request.limits.maxResources - 1,
        });
        if (!keys.ok) return unavailable(keys.reason);
        return {
          status: "success",
          observedAt,
          pagesRead: state.pagesRead(),
          candidates: [
            projectCandidate(project.value, request.scope, observedAt),
            ...keys.value.map((key) => projectKeyCandidate(key, request.scope, observedAt)),
          ],
        };
      } catch {
        return unavailable(state.didTimeout() ? "provider-timeout" : "provider-unavailable");
      } finally {
        state.dispose();
      }
    },
  });
}

function projectKeyCandidate(key, scope, observedAt) {
  return {
    provider: "openai",
    resourceType: "api-key",
    resourceId: key.id,
    parentResourceId: scope.id,
    name: key.name ?? "Unnamed OpenAI project key",
    urls: [{ kind: "console", url: "https://platform.openai.com/api-keys" }],
    observedAt,
    metadata: {
      ownerType: key.ownerType,
      ownerId: key.ownerId,
      createdAt: key.createdAt,
      ...(key.lastUsedAt ? { lastUsedAt: key.lastUsedAt } : {}),
    },
  };
}

export const openAIProjectInventoryAdapter = createOpenAIProjectInventoryAdapter();

function projectCandidate(project, scope, observedAt) {
  return {
    provider: "openai",
    resourceType: "project",
    resourceId: project.id,
    parentResourceId: scope.parent.id,
    name: safeLabel(project.name) ?? project.id,
    urls: [{ kind: "console", url: "https://platform.openai.com/settings/organization/projects" }],
    observedAt,
    metadata: {
      workspaceId: scope.parent.id,
      projectId: project.id,
      version: project.status,
    },
  };
}

function safeLabel(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 200 || value !== value.trim()) return null;
  if (/\b(?:bearer|password|secret|token)\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}/i.test(value)) return null;
  return value;
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
    && Number.isSafeInteger(request.limits.maxResponseBytes)
    && request.limits.maxResponseBytes > 0;
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unavailable(reason) {
  return { status: "unavailable", reason };
}
