const OPENAI_API_ORIGIN = "https://api.openai.com";
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const HARD_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const ORGANIZATION_ID_PATTERN = /^org[-_][A-Za-z0-9_-]{3,124}$/;
const PROJECT_ID_PATTERN = /^proj_[A-Za-z0-9_-]{3,123}$/;
const KEY_ID_PATTERN = /^key_[A-Za-z0-9_-]{3,124}$/;
const CURSOR_PATTERN = /^[A-Za-z0-9_+/=-]{1,500}$/;
const ALLOWED_QUERY_KEYS = new Set([
  "after", "api_key_ids", "bucket_width", "end_time", "group_by", "limit",
  "page", "project_ids", "start_time",
]);

export function validateOpenAIOrganizationId(value) {
  return typeof value === "string" && ORGANIZATION_ID_PATTERN.test(value);
}

export function validateOpenAIProjectId(value) {
  return typeof value === "string" && PROJECT_ID_PATTERN.test(value);
}

export function validateOpenAIKeyId(value) {
  return typeof value === "string" && KEY_ID_PATTERN.test(value);
}

export function validateOpenAIProjectScope(scope) {
  return plainObject(scope)
    && exactKeys(scope, ["id", "kind", "parent"])
    && scope.kind === "project"
    && validateOpenAIProjectId(scope.id)
    && plainObject(scope.parent)
    && exactKeys(scope.parent, ["id", "kind"])
    && scope.parent.kind === "workspace"
    && validateOpenAIOrganizationId(scope.parent.id);
}

export function createOpenAIAdminRequestState({
  fetch: fetchImpl,
  credential,
  scope,
  keyId = null,
  deadlineMs,
  maxPages,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  signal,
}) {
  if (typeof fetchImpl !== "function") throw new TypeError("OpenAI Admin request state requires an injected fetch function");
  if (typeof credential !== "string" || credential.length === 0) throw new TypeError("OpenAI Admin request state requires an ephemeral credential");
  if (!validateOpenAIProjectScope(scope)) throw new TypeError("OpenAI Admin request state requires an exact organization/project scope");
  if (keyId !== null && !validateOpenAIKeyId(keyId)) throw new TypeError("OpenAI Admin request state keyId is invalid");
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 30_000) throw new TypeError("OpenAI Admin deadlineMs is invalid");
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new TypeError("OpenAI Admin maxPages is invalid");
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > HARD_MAX_RESPONSE_BYTES) {
    throw new TypeError(`OpenAI Admin maxResponseBytes must be between 1 and ${HARD_MAX_RESPONSE_BYTES}`);
  }

  const controller = new AbortController();
  let pageCount = 0;
  let timedOut = false;
  let externalAbortHandler;
  let resolveDeadline;
  const deadline = new Promise((resolve) => { resolveDeadline = resolve; });
  if (signal) {
    externalAbortHandler = () => {
      controller.abort();
      resolveDeadline({ ok: false, reason: "provider-unavailable" });
    };
    if (signal.aborted) externalAbortHandler();
    signal.addEventListener("abort", externalAbortHandler, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    resolveDeadline({ ok: false, reason: "provider-timeout" });
  }, deadlineMs);

  async function get(path, query = {}) {
    if (!allowedPath(path, scope) || !validQuery(path, query, scope, keyId)) {
      return { ok: false, reason: "provider-query-not-allowlisted" };
    }
    if (pageCount >= maxPages) return { ok: false, reason: "provider-page-limit-exceeded" };
    pageCount += 1;
    const url = new URL(path, OPENAI_API_ORIGIN);
    appendQuery(url, query);

    const operation = (async () => {
      const response = await fetchImpl(url.toString(), {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${credential}`,
          "openai-organization": scope.parent.id,
        },
        signal: controller.signal,
      });
      if (response.status === 401) return { ok: false, reason: "provider-credential-rejected" };
      if (response.status === 403) return { ok: false, reason: "provider-access-denied" };
      if (response.status === 404) return { ok: false, reason: "provider-resource-not-found" };
      if (response.status === 429) return { ok: false, reason: "provider-rate-limited" };
      if (!response.ok) return { ok: false, reason: "provider-unavailable" };
      return boundedJson(response, maxResponseBytes);
    })();

    try {
      return await Promise.race([operation, deadline]);
    } catch {
      return { ok: false, reason: timedOut ? "provider-timeout" : "provider-unavailable" };
    }
  }

  return Object.freeze({
    get,
    pagesRead: () => pageCount,
    didTimeout: () => timedOut,
    dispose() {
      clearTimeout(timer);
      if (signal && externalAbortHandler) signal.removeEventListener("abort", externalAbortHandler);
    },
  });
}

export async function verifyOpenAIProject(state, scope, expectedName = null) {
  const result = await state.get(`/v1/organization/projects/${encodeURIComponent(scope.id)}`);
  if (!result.ok) return result;
  const project = parseProject(result.value);
  if (!project) return { ok: false, reason: "provider-invalid-response" };
  if (project.id !== scope.id || (expectedName !== null && project.name !== expectedName)) {
    return { ok: false, reason: "provider-identity-mismatch" };
  }
  return { ok: true, value: project };
}

export async function listOpenAIProjectKeys(state, scope, { maxKeys = 49 } = {}) {
  if (!validateOpenAIProjectScope(scope)
      || !Number.isSafeInteger(maxKeys)
      || maxKeys < 0
      || maxKeys > 999) {
    return { ok: false, reason: "invalid-adapter-request" };
  }
  if (maxKeys === 0) return { ok: true, value: [] };

  const keys = [];
  const ids = new Set();
  const cursors = new Set();
  let after;
  while (true) {
    const limit = Math.min(100, maxKeys - keys.length);
    const result = await state.get(`/v1/organization/projects/${encodeURIComponent(scope.id)}/api_keys`, {
      limit,
      ...(after ? { after } : {}),
    });
    if (!result.ok) return result;
    const page = parseProjectKeyPage(result.value);
    if (!page.ok) return page;
    if (page.value.keys.length > limit) return { ok: false, reason: "provider-invalid-response" };
    for (const key of page.value.keys) {
      if (ids.has(key.id)) return { ok: false, reason: "provider-invalid-pagination" };
      ids.add(key.id);
      keys.push(key);
    }
    if (!page.value.hasMore) return { ok: true, value: keys };
    if (keys.length >= maxKeys) return { ok: false, reason: "provider-resource-limit-exceeded" };
    if (!page.value.lastId || cursors.has(page.value.lastId)) return { ok: false, reason: "provider-invalid-pagination" };
    cursors.add(page.value.lastId);
    after = page.value.lastId;
  }
}

function parseProject(value) {
  if (!plainObject(value)
      || !validateOpenAIProjectId(value.id)
      || typeof value.name !== "string"
      || value.name.length < 1
      || value.name.length > 200
      || value.name !== value.name.trim()
      || !Number.isSafeInteger(value.created_at)
      || value.created_at < 1
      || !new Set(["active", "archived"]).has(value.status)) return null;
  if (value.archived_at !== null && (!Number.isSafeInteger(value.archived_at) || value.archived_at < 1)) return null;
  return {
    id: value.id,
    name: value.name,
    status: value.status,
    createdAt: new Date(value.created_at * 1000).toISOString(),
    archivedAt: value.archived_at === null ? null : new Date(value.archived_at * 1000).toISOString(),
  };
}

function parseProjectKeyPage(value) {
  if (!plainObject(value)
      || value.object !== "list"
      || !Array.isArray(value.data)
      || typeof value.has_more !== "boolean") {
    return { ok: false, reason: "provider-invalid-response" };
  }
  const keys = [];
  const ids = new Set();
  for (const raw of value.data) {
    const key = parseProjectKey(raw);
    if (!key || ids.has(key.id)) return { ok: false, reason: "provider-invalid-response" };
    ids.add(key.id);
    keys.push(key);
  }
  if (value.last_id !== null && value.last_id !== undefined && !validateOpenAIKeyId(value.last_id)) {
    return { ok: false, reason: "provider-invalid-response" };
  }
  return { ok: true, value: { keys, hasMore: value.has_more, lastId: value.last_id ?? null } };
}

function parseProjectKey(value) {
  if (!plainObject(value)
      || value.object !== "organization.project.api_key"
      || !validateOpenAIKeyId(value.id)
      || !Number.isSafeInteger(value.created_at)
      || value.created_at < 1
      || (value.last_used_at !== null && (!Number.isSafeInteger(value.last_used_at) || value.last_used_at < 1))
      || typeof value.redacted_value !== "string"
      || !/^sk-[A-Za-z0-9_-]{1,32}\.\.\.[A-Za-z0-9_-]{1,32}$/.test(value.redacted_value)
      || !plainObject(value.owner)
      || !new Set(["user", "service_account"]).has(value.owner.type)) return null;
  const owner = value.owner[value.owner.type];
  if (!plainObject(owner) || typeof owner.id !== "string" || !/^[A-Za-z0-9_-]{3,150}$/.test(owner.id)) return null;
  return {
    id: value.id,
    name: safeProjectKeyLabel(value.name),
    createdAt: new Date(value.created_at * 1000).toISOString(),
    lastUsedAt: value.last_used_at === null ? null : new Date(value.last_used_at * 1000).toISOString(),
    ownerType: value.owner.type,
    ownerId: owner.id,
  };
}

function safeProjectKeyLabel(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 200 || value !== value.trim()) return null;
  if ([...value].some((character) => {
    const code = character.codePointAt(0);
    return code < 32 || code === 127;
  })) return null;
  if (/\b(?:bearer|password|secret|token)\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}/i.test(value)) return null;
  return value;
}

function allowedPath(path, scope) {
  const encodedProjectId = encodeURIComponent(scope.id);
  return path === `/v1/organization/projects/${encodedProjectId}`
    || path === `/v1/organization/projects/${encodedProjectId}/api_keys`
    || path === "/v1/organization/usage/completions"
    || path === "/v1/organization/costs";
}

function validQuery(path, query, scope, keyId) {
  if (!plainObject(query) || Object.keys(query).some((name) => !ALLOWED_QUERY_KEYS.has(name))) return false;
  if (path.endsWith(`/projects/${encodeURIComponent(scope.id)}`)) return Object.keys(query).length === 0;
  if (path.endsWith("/api_keys")) {
    if (Object.keys(query).some((name) => !new Set(["after", "limit"]).has(name))) return false;
    if (query.after !== undefined && !validCursor(query.after)) return false;
  } else {
    if (query.project_ids !== scope.id) return false;
    if (keyId !== null && query.api_key_ids !== keyId) return false;
    if (query.bucket_width !== "1d") return false;
    if (!Number.isSafeInteger(query.start_time) || query.start_time < 1) return false;
    if (!Number.isSafeInteger(query.end_time) || query.end_time <= query.start_time) return false;
    if (query.page !== undefined && !validCursor(query.page)) return false;
    const expectedGroup = path.endsWith("/costs") ? "project_id,api_key_id" : "project_id,api_key_id";
    if (query.group_by !== expectedGroup) return false;
  }
  return query.limit === undefined || (Number.isSafeInteger(query.limit) && query.limit >= 1 && query.limit <= 100);
}

function appendQuery(url, query) {
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (new Set(["project_ids", "api_key_ids", "group_by"]).has(key)) {
      for (const item of String(value).split(",")) url.searchParams.append(key, item);
    } else {
      url.searchParams.set(key, String(value));
    }
  }
}

async function boundedJson(response, maximum) {
  if (!response.body || typeof response.body.getReader !== "function") return { ok: false, reason: "provider-empty-response" };
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

function validCursor(value) {
  return typeof value === "string" && CURSOR_PATTERN.test(value);
}

function exactKeys(value, keys) {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
