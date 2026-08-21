const VERCEL_API_ORIGIN = "https://api.vercel.com";
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const HARD_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const TEAM_ID_PATTERN = /^team_[A-Za-z0-9]{1,95}$/;
const PROJECT_ID_PATTERN = /^prj_[A-Za-z0-9]{1,96}$/;
const DEPLOYMENT_ID_PATTERN = /^dpl_[A-Za-z0-9]{1,96}$/;
const ALLOWED_QUERY_KEYS = new Set(["limit", "projectId", "target", "teamId", "until"]);

export function validateVercelScope(scope) {
  if (!plainObject(scope) || !exactKeys(scope, ["id", "kind"])) return false;
  if (scope.kind === "team") return TEAM_ID_PATTERN.test(scope.id);
  return scope.kind === "account" && validSafeId(scope.id);
}

export function validateVercelProjectId(value) {
  return typeof value === "string" && PROJECT_ID_PATTERN.test(value);
}

export function validateVercelDeploymentId(value) {
  return typeof value === "string" && DEPLOYMENT_ID_PATTERN.test(value);
}

export function validVercelSafeId(value) {
  return validSafeId(value);
}

export function createVercelRequestState({
  fetch: fetchImpl,
  credential,
  scope,
  deadlineMs,
  maxPages,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  signal,
}) {
  if (typeof fetchImpl !== "function") throw new TypeError("Vercel request state requires an injected fetch function");
  if (typeof credential !== "string" || credential.length === 0) throw new TypeError("Vercel request state requires an ephemeral credential");
  if (!validateVercelScope(scope)) throw new TypeError("Vercel request state requires an exact account or team scope");
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 30_000) throw new TypeError("Vercel deadlineMs is invalid");
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new TypeError("Vercel maxPages is invalid");
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > HARD_MAX_RESPONSE_BYTES) {
    throw new TypeError(`Vercel maxResponseBytes must be between 1 and ${HARD_MAX_RESPONSE_BYTES}`);
  }

  const controller = new AbortController();
  let pageCount = 0;
  let timedOut = false;
  let externalAbortHandler;
  let resolveDeadline;
  const deadline = new Promise((resolve) => {
    resolveDeadline = resolve;
  });
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
    if (!allowedPath(path) || !validQuery(query, scope)) return { ok: false, reason: "provider-query-not-allowlisted" };
    if (pageCount >= maxPages) return { ok: false, reason: "provider-page-limit-exceeded" };
    pageCount += 1;
    const url = new URL(path, VERCEL_API_ORIGIN);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const operation = (async () => {
      const response = await fetchImpl(url.toString(), {
        method: "GET",
        headers: { accept: "application/json", authorization: `Bearer ${credential}` },
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) return { ok: false, reason: "provider-access-denied" };
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

export async function verifyVercelScope(state, scope) {
  const result = scope.kind === "team"
    ? await state.get(`/v2/teams/${encodeURIComponent(scope.id)}`)
    : await state.get("/v2/user");
  if (!result.ok) return result;
  const observedId = scope.kind === "team"
    ? result.value?.id
    : result.value?.user?.uid;
  return observedId === scope.id
    ? { ok: true }
    : { ok: false, reason: "provider-scope-mismatch" };
}

function allowedPath(path) {
  if (path === "/v2/user" || path === "/v9/projects" || path === "/v6/deployments") return true;
  if (/^\/v2\/teams\/team_[A-Za-z0-9]{1,95}$/.test(path)) return true;
  if (/^\/v9\/projects\/prj_[A-Za-z0-9]{1,96}$/.test(path)) return true;
  if (/^\/v9\/projects\/prj_[A-Za-z0-9]{1,96}\/domains$/.test(path)) return true;
  return /^\/v13\/deployments\/dpl_[A-Za-z0-9]{1,96}$/.test(path);
}

function validQuery(query, scope) {
  if (!plainObject(query) || Object.keys(query).some((key) => !ALLOWED_QUERY_KEYS.has(key))) return false;
  if (scope.kind === "team") {
    if (query.teamId !== scope.id && Object.keys(query).length > 0) return false;
  } else if (query.teamId !== undefined) return false;
  if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100)) return false;
  if (query.until !== undefined && (!Number.isSafeInteger(query.until) || query.until < 1)) return false;
  if (query.projectId !== undefined && !validateVercelProjectId(query.projectId)) return false;
  if (query.target !== undefined && !new Set(["production", "preview"]).has(query.target)) return false;
  return true;
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

function validSafeId(value) {
  return typeof value === "string" && SAFE_ID_PATTERN.test(value);
}

function exactKeys(value, keys) {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
