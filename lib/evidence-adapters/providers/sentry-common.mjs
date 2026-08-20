const SENTRY_API_ORIGIN = "https://sentry.io";
const SENTRY_WEB_HOSTS = new Set(["sentry.io", "www.sentry.io"]);
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const HARD_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,98}[a-z0-9])?$/;

export function validateSentryIdentity(identity) {
  if (!plainObject(identity)) return false;
  const keys = Object.keys(identity).sort();
  if (JSON.stringify(keys) !== JSON.stringify([
    "environment",
    "expectedRelease",
    "lookbackHours",
    "organizationSlug",
    "projectSlug",
  ])) return false;
  return SLUG_PATTERN.test(identity.organizationSlug)
    && SLUG_PATTERN.test(identity.projectSlug)
    && safeLabel(identity.environment, 100)
    && safeLabel(identity.expectedRelease, 200)
    && Number.isInteger(identity.lookbackHours)
    && identity.lookbackHours >= 1
    && identity.lookbackHours <= 168;
}

export function asSentryNow(value) {
  const now = new Date(value ?? Date.now());
  return Number.isNaN(now.getTime()) ? null : now;
}

export async function sentryJson(fetchImpl, path, credential, options = {}) {
  if (typeof credential !== "string" || credential.length === 0) {
    return { ok: false, reason: "credential-unavailable" };
  }
  if (typeof path !== "string" || !path.startsWith("/api/0/") || path.includes("..")) {
    return { ok: false, reason: "provider-path-not-allowlisted" };
  }
  const timeoutMs = boundedOption(options.timeoutMs, DEFAULT_TIMEOUT_MS, 100, 30_000, "timeoutMs");
  const maxResponseBytes = boundedOption(
    options.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
    1,
    HARD_MAX_RESPONSE_BYTES,
    "maxResponseBytes",
  );
  const controller = new AbortController();
  const parentSignal = options.signal;
  const abortFromParent = () => controller.abort();
  if (parentSignal?.aborted) controller.abort();
  else parentSignal?.addEventListener?.("abort", abortFromParent, { once: true });
  let timer;
  try {
    const operation = (async () => {
      const response = await fetchImpl(`${SENTRY_API_ORIGIN}${path}`, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${credential}`,
        },
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) return { ok: false, reason: "provider-access-denied" };
      if (response.status === 404) return { ok: false, reason: "provider-identity-unavailable" };
      if (!response.ok) return { ok: false, reason: "provider-unavailable" };
      return boundedJson(response, maxResponseBytes);
    })();
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ ok: false, reason: "provider-timeout" });
      }, timeoutMs);
    });
    return await Promise.race([operation, deadline]);
  } catch {
    return { ok: false, reason: controller.signal.aborted ? "provider-timeout" : "provider-unavailable" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    parentSignal?.removeEventListener?.("abort", abortFromParent);
  }
}

export function safeSentryUrl(value) {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !SENTRY_WEB_HOSTS.has(url.hostname) || url.username || url.password) return undefined;
    for (const key of url.searchParams.keys()) {
      if (/(?:token|key|secret|signature|authorization)/i.test(key)) return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

export function sentryIsoDate(value) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function sentryUnavailable(reason) {
  return { status: "unavailable", reason };
}

function safeLabel(value, maximum) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && ![...value].some((character) => {
      const code = character.codePointAt(0);
      return code < 32 || code === 127;
    });
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedOption(value, fallback, minimum, maximum, field) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new TypeError(`Sentry ${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return resolved;
}

async function boundedJson(response, maximum) {
  if (!response.body) return { ok: false, reason: "provider-empty-response" };
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
