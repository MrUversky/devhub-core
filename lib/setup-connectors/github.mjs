import { githubDeploymentAdapter } from "../evidence-adapters/providers/github-deployment.mjs";
import { githubReleaseDeploymentAdapter } from "../evidence-adapters/providers/github-release-deployment.mjs";
import { githubWorkflowMonitoringAdapter } from "../evidence-adapters/providers/github-workflow-monitoring.mjs";
import { createScopedConnectionOnboarding } from "../connection-onboarding.mjs";
import { getConnectionOnboardingPresentation } from "../connection-onboarding-presentation.mjs";

const API_VERSION = "2026-03-10";
const PAGE_SIZE = 100;
const HARD_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const HARD_MAX_REPOSITORIES = 500;
const HARD_MAX_PAGES = 12;
const HARD_MAX_DEADLINE_MS = 30_000;
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const REASON_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const AUTHORIZATION_METHODS = new Set(["cli-session", "github-app", "browser-session"]);
const TRANSPORT_REASONS = new Set([
  "authorization-required",
  "credential-unavailable",
  "provider-access-denied",
  "provider-network-unavailable",
  "provider-rate-limited",
  "provider-timeout",
  "provider-unavailable",
  "provider-response-too-large",
  "provider-invalid-response",
]);

export const GITHUB_SETUP_CONNECTOR_ID = "github-connected-setup-v1";
export const GITHUB_SETUP_CONNECTOR = "github";

const EXACT_EVIDENCE = Object.freeze([
  Object.freeze({
    adapterId: githubDeploymentAdapter.id,
    check: "deployment",
    state: "requires-reviewed-identity",
  }),
  Object.freeze({
    adapterId: githubReleaseDeploymentAdapter.id,
    check: "deployment",
    state: "requires-reviewed-identity",
  }),
  Object.freeze({
    adapterId: githubWorkflowMonitoringAdapter.id,
    check: "monitoring",
    state: "requires-reviewed-identity",
  }),
]);

export function validateGitHubSetupScope(scope) {
  return plainObject(scope)
    && exactKeys(scope, ["kind", "login"])
    && ["user", "organization"].includes(scope.kind)
    && typeof scope.login === "string"
    && LOGIN_PATTERN.test(scope.login);
}

const githubScopeSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["kind", "login"],
  properties: {
    kind: { enum: ["user", "organization"] },
    login: { type: "string", pattern: "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$" },
  },
});

export function createGitHubConnectionOnboarding(authorizationMethod = "cli-session") {
  if (!["cli-session", "github-app"].includes(authorizationMethod)) throw new TypeError("GitHub onboarding requires an implemented reviewed session method");
  const presentation = getConnectionOnboardingPresentation(GITHUB_SETUP_CONNECTOR);
  return createScopedConnectionOnboarding({
    connectorId: GITHUB_SETUP_CONNECTOR,
    acquisition: presentation.acquisition,
    authorizationMethod,
    scopeSchema: githubScopeSchema,
    validateScope: validateGitHubSetupScope,
    guidedCard: presentation.guidedCard,
  });
}

export const githubConnectionOnboarding = createGitHubConnectionOnboarding();

export function createGitHubGhSessionTransport({ runGh, maxResponseBytes = 1024 * 1024 } = {}) {
  if (typeof runGh !== "function") throw new TypeError("GitHub gh-session transport requires an injected runGh function");
  validateMaximumBytes(maxResponseBytes);

  return createTransport({
    method: "cli-session",
    maxResponseBytes,
    async request(path, { signal }) {
      try {
        const result = await runGh([
          "api",
          "--method", "GET",
          "--header", "Accept: application/vnd.github+json",
          "--header", `X-GitHub-Api-Version: ${API_VERSION}`,
          path,
        ], { signal, maxBuffer: maxResponseBytes });
        const stdout = typeof result === "string" ? result : result?.stdout;
        if (typeof stdout !== "string") return unavailable("provider-invalid-response");
        return { status: "success", body: stdout };
      } catch (error) {
        return unavailable(classifyGhFailure(error, signal));
      }
    },
  });
}

export function createGitHubAuthorizedTransport({ method, request, maxResponseBytes = 1024 * 1024 } = {}) {
  if (!["github-app", "browser-session"].includes(method)) {
    throw new TypeError("GitHub authorized transport method must be github-app or browser-session");
  }
  if (typeof request !== "function") throw new TypeError("GitHub authorized transport requires an injected request function");
  validateMaximumBytes(maxResponseBytes);
  return createTransport({ method, request, maxResponseBytes });
}

export function createGitHubSetupConnector({ transport } = {}) {
  if (!plainObject(transport)
    || !AUTHORIZATION_METHODS.has(transport.method)
    || typeof transport.request !== "function"
    || !Number.isSafeInteger(transport.maxResponseBytes)) {
    throw new TypeError("GitHub setup connector requires a reviewed GitHub transport");
  }

  return Object.freeze({
    id: GITHUB_SETUP_CONNECTOR_ID,
    provider: "github",
    validateScope: validateGitHubSetupScope,
    async collect(request) {
      if (request?.provider !== "github" || !validateGitHubSetupScope(request?.scope)) {
        return unknown("binding-not-applicable");
      }
      const authorization = normalizeAuthorization(request.authorization);
      if (!authorization || authorization.method !== transport.method) {
        return unknown("authorization-required");
      }
      const now = normalizeNow(request.now);
      const limits = normalizeLimits(request.limits, transport.maxResponseBytes);
      if (!now || !limits) return unknown("invalid-setup-request");

      const controller = new AbortController();
      let timedOut = false;
      let externalAbortHandler;
      let resolveDeadline;
      const deadline = new Promise((resolve) => {
        resolveDeadline = resolve;
      });
      if (request.signal) {
        if (typeof request.signal.addEventListener !== "function") return unknown("invalid-setup-request");
        externalAbortHandler = () => {
          controller.abort();
          resolveDeadline(unavailable("provider-unavailable"));
        };
        if (request.signal.aborted) externalAbortHandler();
        request.signal.addEventListener("abort", externalAbortHandler, { once: true });
      }
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
        resolveDeadline(unavailable("provider-timeout"));
      }, limits.deadlineMs);

      let pagesRead = 0;
      const get = async (path) => {
        if (pagesRead >= limits.maxPages) return unavailable("provider-observation-partial");
        pagesRead += 1;
        try {
          const operation = transport.request(path, {
            signal: controller.signal,
            maxResponseBytes: limits.maxResponseBytes,
          });
          const response = await Promise.race([operation, deadline]);
          return normalizeTransportResponse(response, limits.maxResponseBytes);
        } catch {
          return unavailable(timedOut ? "provider-timeout" : "provider-unavailable");
        }
      };

      try {
        const accountResponse = await get("/user");
        if (accountResponse.status !== "success") return unknown(accountResponse.reason);
        const account = normalizeAccount(accountResponse.value);
        if (!account) return unknown("provider-identity-mismatch");

        let scopeIdentity = account;
        if (request.scope.kind === "user") {
          if (!sameIdentity(request.scope.login, account.login)) return unknown("provider-scope-mismatch");
        } else {
          const organizationResponse = await get(`/orgs/${encodeURIComponent(request.scope.login)}`);
          if (organizationResponse.status !== "success") return unknown(organizationResponse.reason);
          scopeIdentity = normalizeOrganization(organizationResponse.value);
          if (!scopeIdentity || !sameIdentity(request.scope.login, scopeIdentity.login)) {
            return unknown("provider-scope-mismatch");
          }
        }

        const repositories = [];
        let page = 1;
        while (true) {
          const path = repositoryPagePath(request.scope, page);
          const repositoryResponse = await get(path);
          if (repositoryResponse.status !== "success") return unknown(repositoryResponse.reason);
          if (!Array.isArray(repositoryResponse.value)) return unknown("provider-invalid-response");
          if (repositoryResponse.value.length > PAGE_SIZE) return unknown("provider-invalid-response");

          for (const rawRepository of repositoryResponse.value) {
            const repository = normalizeRepository(rawRepository, request.scope);
            if (!repository) return unknown("provider-identity-mismatch");
            repositories.push(repository);
            if (repositories.length > limits.maxRepositories) return unknown("provider-observation-partial");
          }
          if (repositoryResponse.value.length < PAGE_SIZE) break;
          page += 1;
        }

        repositories.sort((left, right) => left.fullName.localeCompare(right.fullName, "en"));
        if (new Set(repositories.map((repository) => repository.id)).size !== repositories.length) {
          return unknown("provider-invalid-response");
        }

        return deepFreeze({
          status: "success",
          state: "connected",
          observedAt: now,
          pagesRead,
          authorization,
          identity: account,
          scope: {
            kind: request.scope.kind,
            login: scopeIdentity.login,
            providerId: scopeIdentity.providerId,
          },
          repositories,
          limitations: buildLimitations(repositories),
          exactEvidence: EXACT_EVIDENCE.map((item) => ({ ...item })),
          safety: {
            readOnly: true,
            credentialsStored: false,
            rawPayloadsRetained: false,
            catalogWrites: false,
            ownershipInferred: false,
          },
        });
      } finally {
        clearTimeout(timeout);
        if (request.signal && externalAbortHandler) {
          request.signal.removeEventListener("abort", externalAbortHandler);
        }
      }
    },
  });
}

export function createGitHubSetupSessionConnector({
  transport,
  limits = Object.freeze({
    maxRepositories: 200,
    maxPages: 8,
    deadlineMs: 10_000,
    maxResponseBytes: 1024 * 1024,
  }),
} = {}) {
  const collector = createGitHubSetupConnector({ transport });
  return Object.freeze({
    connectorId: GITHUB_SETUP_CONNECTOR,
    onboarding: createGitHubConnectionOnboarding(transport.method),
    validateProfile(profile) {
      if (profile?.connectorId !== GITHUB_SETUP_CONNECTOR || !validateGitHubSetupScope(profile.scope)) {
        throw new TypeError("GitHub connection profile requires one explicit user or organization scope");
      }
      if (!["cli-session", "github-app"].includes(profile.authorization?.method)) {
        throw new TypeError("GitHub connection profile requires cli-session or github-app authorization");
      }
      if (profile.authorization.method !== transport.method) {
        throw new TypeError("GitHub connection profile authorization must match the injected reviewed transport");
      }
    },
    async collect({ profile, now, signal }) {
      const authorization = {
        method: profile.authorization.method,
        reference: profile.authorization.method === "cli-session"
          ? "gh:current"
          : `github-app:profile-${profile.id}`,
        state: "reviewed",
      };
      const observation = await collector.collect({
        provider: "github",
        scope: profile.scope,
        authorization,
        now,
        limits,
        signal,
      });
      if (observation.status !== "success") {
        return {
          state: observation.state,
          observedAt: now,
          message: observation.nextAction.label,
          observations: [{
            kind: "provider-limitation",
            provider: "github",
            code: observation.reason,
            state: "unknown",
            nextActionId: observation.nextAction.id,
          }],
        };
      }
      return {
        state: "connected",
        observedAt: observation.observedAt,
        message: `${observation.repositories.length} GitHub repositories observed in the reviewed ${observation.scope.kind} scope.`,
        observations: setupSessionObservations(observation),
      };
    },
  });
}

function setupSessionObservations(observation) {
  return [
    {
      kind: "account-identity",
      provider: "github",
      providerId: observation.identity.providerId,
      login: observation.identity.login,
      accountKind: observation.identity.kind,
    },
    {
      kind: "reviewed-scope",
      provider: "github",
      providerId: observation.scope.providerId,
      login: observation.scope.login,
      scopeKind: observation.scope.kind,
    },
    ...observation.repositories.map((repository) => ({
      kind: "repository-candidate",
      provider: "github",
      providerId: repository.id,
      owner: repository.owner,
      name: repository.name,
      fullName: repository.fullName,
      url: repository.url,
      visibility: repository.visibility,
      archived: repository.archived,
      disabled: repository.disabled,
      access: repository.access,
      ownership: "unknown",
      identity: repository.candidateIdentity,
    })),
    ...observation.limitations.map((limitation) => ({
      kind: "provider-limitation",
      provider: "github",
      code: limitation.code,
      state: limitation.state,
      summary: limitation.summary,
    })),
    ...observation.exactEvidence.map((evidence) => ({
      kind: "exact-evidence-capability",
      provider: "github",
      adapterId: evidence.adapterId,
      check: evidence.check,
      state: evidence.state,
    })),
  ];
}

function createTransport({ method, request, maxResponseBytes }) {
  return Object.freeze({ method, request, maxResponseBytes });
}

function normalizeAuthorization(value) {
  if (!plainObject(value) || !exactKeys(value, ["method", "reference", "state"])) return null;
  if (!AUTHORIZATION_METHODS.has(value.method) || value.state !== "reviewed") return null;
  if (typeof value.reference !== "string" || value.reference.length > 120) return null;
  if (value.method === "cli-session" && value.reference !== "gh:current") return null;
  if (value.method === "github-app" && !/^github-app:(?:installation-[1-9][0-9]{0,19}|profile-[a-z0-9]+(?:-[a-z0-9]+)*)$/.test(value.reference)) return null;
  if (value.method === "browser-session" && !/^browser:github-app-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.reference)) return null;
  return Object.freeze({ method: value.method, reference: value.reference, state: "reviewed" });
}

function normalizeLimits(value, transportMaximum) {
  if (!plainObject(value) || !exactKeys(value, ["deadlineMs", "maxPages", "maxRepositories", "maxResponseBytes"])) return null;
  if (!boundedInteger(value.maxRepositories, 1, HARD_MAX_REPOSITORIES)) return null;
  if (!boundedInteger(value.maxPages, 2, HARD_MAX_PAGES)) return null;
  if (!boundedInteger(value.deadlineMs, 100, HARD_MAX_DEADLINE_MS)) return null;
  if (!boundedInteger(value.maxResponseBytes, 1, Math.min(HARD_MAX_RESPONSE_BYTES, transportMaximum))) return null;
  return value;
}

function normalizeNow(value) {
  const now = new Date(value);
  return Number.isNaN(now.getTime()) ? null : now.toISOString();
}

function normalizeTransportResponse(response, maximum) {
  if (!plainObject(response)) return unavailable("provider-invalid-response");
  if (response.status === "unavailable") {
    return unavailable(TRANSPORT_REASONS.has(response.reason) ? response.reason : "provider-unavailable");
  }
  if (response.status !== "success" || typeof response.body !== "string") return unavailable("provider-invalid-response");
  if (Buffer.byteLength(response.body, "utf8") > maximum) return unavailable("provider-response-too-large");
  try {
    return { status: "success", value: JSON.parse(response.body) };
  } catch {
    return unavailable("provider-invalid-response");
  }
}

function normalizeAccount(value) {
  if (!plainObject(value) || !validProviderId(value.id) || !LOGIN_PATTERN.test(value.login)) return null;
  if (!new Set(["User", "Bot"]).has(value.type)) return null;
  return {
    providerId: String(value.id),
    login: value.login,
    kind: value.type === "Bot" ? "bot" : "user",
  };
}

function normalizeOrganization(value) {
  if (!plainObject(value) || !validProviderId(value.id) || !LOGIN_PATTERN.test(value.login)) return null;
  return { providerId: String(value.id), login: value.login, kind: "organization" };
}

function normalizeRepository(value, scope) {
  if (!plainObject(value)
    || !validProviderId(value.id)
    || !REPOSITORY_PATTERN.test(value.name)
    || !plainObject(value.owner)
    || !LOGIN_PATTERN.test(value.owner.login)
    || !sameIdentity(value.owner.login, scope.login)
    || value.full_name !== `${value.owner.login}/${value.name}`
    || typeof value.archived !== "boolean"
    || typeof value.disabled !== "boolean") return null;
  const url = safeRepositoryUrl(value.html_url, value.owner.login, value.name);
  if (!url) return null;
  const visibility = normalizeVisibility(value.visibility, value.private);
  if (!visibility) return null;
  return {
    id: String(value.id),
    owner: value.owner.login,
    name: value.name,
    fullName: value.full_name,
    url,
    visibility,
    archived: value.archived,
    disabled: value.disabled,
    access: normalizeRepositoryAccess(value.permissions),
    ownership: "unknown",
    candidateIdentity: { provider: "github", owner: value.owner.login, name: value.name },
  };
}

function normalizeRepositoryAccess(value) {
  if (!plainObject(value)) return "unknown";
  if (value.admin === true) return "admin";
  if (value.maintain === true || value.push === true) return "write";
  if (value.triage === true || value.pull === true) return "read";
  return "unknown";
}

function normalizeVisibility(visibility, privateFlag) {
  if (["public", "private", "internal"].includes(visibility)) return visibility;
  if (typeof privateFlag === "boolean") return privateFlag ? "private" : "public";
  return null;
}

function safeRepositoryUrl(value, owner, repository) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const expectedPath = `/${owner}/${repository}`.toLowerCase();
    if (url.protocol !== "https:"
      || url.hostname !== "github.com"
      || url.pathname.toLowerCase() !== expectedPath
      || url.username
      || url.password
      || url.search
      || url.hash) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function buildLimitations(repositories) {
  const permissionsUnknown = repositories.some((repository) => repository.access === "unknown");
  return [
    {
      code: "repository-permissions",
      state: permissionsUnknown ? "unknown" : "observed",
      summary: permissionsUnknown
        ? "GitHub did not expose a repository permission level for every result."
        : "Repository access levels are provider observations, not ownership claims.",
    },
    {
      code: "actions-evidence",
      state: "unknown",
      summary: "Actions evidence stays unknown until a workflow identity is reviewed by the exact adapter.",
    },
    {
      code: "deployment-evidence",
      state: "unknown",
      summary: "Deployment evidence stays unknown until a release or deployment identity is reviewed by the exact adapter.",
    },
    {
      code: "ownership",
      state: "unknown",
      summary: "Repository access and account scope do not establish human or business ownership.",
    },
  ];
}

function repositoryPagePath(scope, page) {
  const query = new URLSearchParams({
    ...(scope.kind === "user" ? { affiliation: "owner" } : { type: "all" }),
    sort: "full_name",
    direction: "asc",
    per_page: String(PAGE_SIZE),
    page: String(page),
  });
  return scope.kind === "user"
    ? `/user/repos?${query}`
    : `/orgs/${encodeURIComponent(scope.login)}/repos?${query}`;
}

function classifyGhFailure(error, signal) {
  if (signal?.aborted) return "provider-timeout";
  const summary = `${error?.message ?? ""}\n${error?.stderr ?? ""}`.slice(0, 2_000);
  if (/rate.?limit|secondary rate|http 429/i.test(summary)) return "provider-rate-limited";
  if (/not logged into any github hosts|run:\s*gh auth login|gh auth login|bad credentials|http 401/i.test(summary)) return "authorization-required";
  if (/http 403|forbidden|resource not accessible|permission denied/i.test(summary)) return "provider-access-denied";
  if (/enotfound|eai_again|econnrefused|econnreset|network is unreachable|temporary failure in name resolution|could not resolve host|tls handshake|certificate verify/i.test(summary)) return "provider-network-unavailable";
  if (/maxbuffer|too large|stdout maxbuffer/i.test(summary)) return "provider-response-too-large";
  return "provider-unavailable";
}

function validateMaximumBytes(value) {
  if (!boundedInteger(value, 1, HARD_MAX_RESPONSE_BYTES)) {
    throw new TypeError(`GitHub transport maxResponseBytes must be between 1 and ${HARD_MAX_RESPONSE_BYTES}`);
  }
}

function boundedInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function validProviderId(value) {
  return (Number.isSafeInteger(value) && value > 0)
    || (typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value));
}

function sameIdentity(left, right) {
  return typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function unavailable(reason) {
  return { status: "unavailable", reason };
}

function unknown(reason) {
  const authorizationRequired = ["authorization-required", "credential-unavailable"].includes(reason);
  const nextAction = authorizationRequired || reason === "provider-access-denied"
    ? { id: "reconnect-github", label: "Reconnect GitHub with reviewed read-only access", safe: true }
    : reason === "provider-rate-limited"
      ? { id: "retry-github-later", label: "Retry GitHub after the provider rate-limit window", safe: true }
      : reason === "provider-network-unavailable"
        ? { id: "retry-github-network", label: "Retry GitHub from a network-enabled environment", safe: true }
        : { id: "retry-github", label: "Retry the bounded GitHub observation", safe: true };
  return deepFreeze({
    status: "unavailable",
    state: authorizationRequired ? "authorization-required" : "unknown",
    reason: REASON_PATTERN.test(reason) ? reason : "provider-unavailable",
    repositories: [],
    nextAction,
  });
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
