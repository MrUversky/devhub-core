import {
  createVercelRequestState,
  validateVercelDeploymentId,
  validateVercelProjectId,
  validateVercelScope,
  verifyVercelScope,
} from "../../vercel-api.mjs";

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const HARD_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const IDENTITY_KEYS = Object.freeze(["deploymentId", "environment", "projectId", "revision", "scope"]);

export const VERCEL_DEPLOYMENT_ADAPTER_ID = "vercel-deployment-v1";

export function createVercelDeploymentAdapter({
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("Vercel deployment adapter requires an injected fetch function");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new TypeError("Vercel deployment timeoutMs must be between 100 and 30000");
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > HARD_MAX_RESPONSE_BYTES) {
    throw new TypeError(`Vercel deployment maxResponseBytes must be between 1 and ${HARD_MAX_RESPONSE_BYTES}`);
  }

  return Object.freeze({
    id: VERCEL_DEPLOYMENT_ADAPTER_ID,
    provider: "vercel",
    validateIdentity: validateVercelDeploymentIdentity,
    async collect(request) {
      const now = new Date(request?.now);
      if (Number.isNaN(now.getTime())) throw new TypeError("Vercel deployment adapter requires a valid now value");
      if (request?.provider !== "vercel" || !request?.checks?.includes("deployment")) return unavailable("binding-not-applicable");
      const identity = request.reviewedIdentity;
      if (!validateVercelDeploymentIdentity(identity)) return unavailable("invalid-reviewed-identity");
      if (typeof request.credential !== "string" || request.credential.length === 0) return unavailable("credential-unavailable");
      if ((request.limits?.maxPages ?? 2) < 2) return unavailable("provider-page-limit-exceeded");

      const state = createVercelRequestState({
        fetch: fetchImpl,
        credential: request.credential,
        scope: identity.scope,
        deadlineMs: Math.min(timeoutMs, request.limits?.deadlineMs ?? timeoutMs),
        maxPages: 2,
        maxResponseBytes: Math.min(maxResponseBytes, request.limits?.maxResponseBytes ?? maxResponseBytes),
        signal: request.signal,
      });
      try {
        const verifiedScope = await verifyVercelScope(state, identity.scope);
        if (!verifiedScope.ok) return unavailable(verifiedScope.reason);
        const result = await state.get(
          `/v13/deployments/${encodeURIComponent(identity.deploymentId)}`,
          identity.scope.kind === "team" ? { teamId: identity.scope.id } : {},
        );
        if (!result.ok) return unavailable(result.reason);
        const deployment = parseDeployment(result.value, identity);
        if (!deployment.ok) return unavailable(deployment.reason);

        const note = deployment.value.ready
          ? `Vercel verified the ${identity.environment} deployment ${identity.deploymentId} as READY; created ${deployment.value.createdAt}.`
          : `Vercel returned ${deployment.value.status} for the ${identity.environment} deployment ${identity.deploymentId}; created ${deployment.value.createdAt}.`;
        return {
          status: "success",
          observedIdentity: structuredClone(identity),
          observedAt: now.toISOString(),
          evidence: [{
            id: "vercel-deployment",
            check: "deployment",
            state: deployment.value.ready ? "verified" : "unknown",
            note,
            url: deployment.value.url,
          }],
          deployment: {
            identity: `${identity.scope.kind}/${identity.scope.id}/project/${identity.projectId}/deployment/${identity.deploymentId}/${identity.environment}`,
            ...(deployment.value.revision ? { revision: deployment.value.revision } : {}),
            url: deployment.value.url,
            host: new URL(deployment.value.url).hostname,
            deployedAt: deployment.value.createdAt,
          },
        };
      } catch {
        return unavailable(state.didTimeout() ? "provider-timeout" : "provider-unavailable");
      } finally {
        state.dispose();
      }
    },
  });
}

export const vercelDeploymentAdapter = createVercelDeploymentAdapter();

export function validateVercelDeploymentIdentity(identity) {
  if (!plainObject(identity) || !exactKeys(identity, IDENTITY_KEYS)) return false;
  return validateVercelScope(identity.scope)
    && validateVercelProjectId(identity.projectId)
    && validateVercelDeploymentId(identity.deploymentId)
    && new Set(["production", "preview"]).has(identity.environment)
    && (identity.revision === null || (typeof identity.revision === "string" && /^[0-9a-f]{7,64}$/.test(identity.revision)));
}

function parseDeployment(value, identity) {
  if (!plainObject(value)) return unavailableResult("provider-invalid-response");
  const id = value.id ?? value.uid;
  if (id !== identity.deploymentId || value.projectId !== identity.projectId) return unavailableResult("provider-identity-mismatch");
  if (identity.environment === "production" && value.target !== "production") return unavailableResult("provider-identity-mismatch");
  if (identity.environment === "preview" && value.target !== "preview" && value.target !== null) {
    return unavailableResult("provider-identity-mismatch");
  }
  const createdAt = normalizeTimestamp(value.created ?? value.createdAt);
  const url = domainUrl(value.url);
  const status = validStatus(value.readyState ?? value.state);
  if (!createdAt || !url || !status) return unavailableResult("provider-invalid-response");
  const revision = deploymentRevision(value.meta);
  if (revision !== identity.revision) return unavailableResult("provider-identity-mismatch");
  return {
    ok: true,
    value: { createdAt, url, status, ready: status === "READY", ...(revision ? { revision } : {}) },
  };
}

function deploymentRevision(meta) {
  if (!plainObject(meta)) return null;
  for (const field of ["githubCommitSha", "gitlabCommitSha", "bitbucketCommitSha"]) {
    if (typeof meta[field] === "string" && /^[0-9a-f]{7,64}$/i.test(meta[field])) return meta[field].toLowerCase();
  }
  return null;
}

function normalizeTimestamp(value) {
  const date = Number.isSafeInteger(value) && value > 0 ? new Date(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function validStatus(value) {
  if (typeof value !== "string" || !/^[A-Z_]{2,40}$/i.test(value)) return null;
  return value.toUpperCase();
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

function exactKeys(value, keys) {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
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
