const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_WEB_HOST = "github.com";
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

const DEPLOYMENT_KEYS = ["deploymentId", "environment", "owner", "repository", "runId", "statusId", "workflowId"];
const MONITORING_KEYS = ["branch", "lookbackHours", "owner", "repository", "workflowId"];
const RELEASE_KEYS = ["owner", "releaseId", "repository", "tag", "targetCommitish", "targetSha"];

export function validateGitHubIdentity(identity, kind) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) return false;
  const expectedKeys = kind === "deployment"
    ? DEPLOYMENT_KEYS
    : kind === "monitoring"
      ? MONITORING_KEYS
      : kind === "release"
        ? RELEASE_KEYS
        : null;
  if (!expectedKeys || JSON.stringify(Object.keys(identity).sort()) !== JSON.stringify(expectedKeys)) return false;
  if (!validRepository(identity.owner, identity.repository)) return false;
  if (kind === "deployment") {
    return validId(identity.workflowId)
      && validId(identity.runId)
      && validName(identity.environment)
      && validId(identity.deploymentId)
      && validId(identity.statusId);
  }
  if (kind === "release") {
    return validName(identity.tag)
      && validId(identity.releaseId)
      && validName(identity.targetCommitish)
      && /^[0-9a-f]{40}$/.test(identity.targetSha);
  }
  return validId(identity.workflowId)
    && validName(identity.branch)
    && Number.isInteger(identity.lookbackHours)
    && identity.lookbackHours >= 1
    && identity.lookbackHours <= 168;
}

function validRepository(owner, repository) {
  return OWNER_PATTERN.test(owner)
    && REPOSITORY_PATTERN.test(repository)
    && repository !== "."
    && repository !== "..";
}

function validId(value) {
  return /^[1-9][0-9]{0,19}$/.test(value);
}

function validName(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 255
    && ![...value].some((character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127);
}

export function asNow(value) {
  const now = value instanceof Date ? new Date(value) : new Date(value ?? Date.now());
  return Number.isNaN(now.getTime()) ? null : now;
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

export async function githubJson(fetchImpl, path, credential, options = {}) {
  if (credential !== null && credential !== undefined && (typeof credential !== "string" || credential.length === 0)) {
    return { ok: false, reason: "credential-unavailable" };
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const controller = new AbortController();
  let timer;
  try {
    const request = (async () => {
      const headers = {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2026-03-10",
      };
      if (typeof credential === "string") headers.authorization = `Bearer ${credential}`;
      const response = await fetchImpl(`${GITHUB_API_ORIGIN}${path}`, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      if (!response.ok) return { ok: false, reason: `provider-http-${response.status}` };
      return await boundedJson(response, maxResponseBytes);
    })();
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ ok: false, reason: "provider-timeout" });
      }, timeoutMs);
    });
    return await Promise.race([request, timeout]);
  } catch {
    if (controller.signal.aborted) return { ok: false, reason: "provider-timeout" };
    return { ok: false, reason: "provider-unavailable" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function safeGitHubUrl(value) {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== GITHUB_WEB_HOST || url.username || url.password || url.search || url.hash) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function repositoryMatches(value, owner, repository) {
  return typeof value === "string" && value.toLowerCase() === `${owner}/${repository}`.toLowerCase();
}

export function providerIdMatches(value, expected) {
  if (typeof value === "string") return validId(value) && value === expected;
  return Number.isSafeInteger(value) && String(value) === expected;
}

export function deploymentUrlMatches(value, identity) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const expectedPath = `/repos/${identity.owner}/${identity.repository}/deployments/${identity.deploymentId}`.toLowerCase();
    return url.origin === GITHUB_API_ORIGIN
      && url.pathname.toLowerCase() === expectedPath
      && !url.search
      && !url.hash
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

export function isoDate(value) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function unavailableResult(reason) {
  return { status: "unavailable", reason };
}
