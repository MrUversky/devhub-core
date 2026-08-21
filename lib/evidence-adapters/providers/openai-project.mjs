import {
  createOpenAIAdminRequestState,
  validateOpenAIKeyId,
  validateOpenAIOrganizationId,
  validateOpenAIProjectId,
  verifyOpenAIProject,
} from "../../openai-admin-api.mjs";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const HARD_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const IDENTITY_KEYS = Object.freeze([
  "access", "keyId", "organizationId", "projectId", "projectName", "stewardship", "window",
]);
const CONSOLE_URL = "https://platform.openai.com/settings/organization/projects";

export const OPENAI_PROJECT_EVIDENCE_ADAPTER_ID = "openai-project-evidence-v1";

export function createOpenAIProjectEvidenceAdapter({
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("OpenAI project evidence adapter requires an injected fetch function");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new TypeError("OpenAI project evidence timeoutMs must be between 100 and 30000");
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > HARD_MAX_RESPONSE_BYTES) {
    throw new TypeError(`OpenAI project evidence maxResponseBytes must be between 1 and ${HARD_MAX_RESPONSE_BYTES}`);
  }

  return Object.freeze({
    id: OPENAI_PROJECT_EVIDENCE_ADAPTER_ID,
    provider: "openai",
    validateIdentity: validateOpenAIProjectEvidenceIdentity,
    async collect(request) {
      const now = new Date(request?.now);
      if (Number.isNaN(now.getTime())) throw new TypeError("OpenAI project evidence adapter requires a valid now value");
      if (request?.provider !== "openai" || !request?.checks?.some((check) => check === "ownership" || check === "cost")) {
        return unavailable("binding-not-applicable");
      }
      const identity = request.reviewedIdentity;
      if (!validateOpenAIProjectEvidenceIdentity(identity)) return unavailable("invalid-reviewed-identity");
      if (Date.parse(identity.window.endTime) > now.getTime()
          || (identity.stewardship.lastVerifiedAt !== null
            && Date.parse(identity.stewardship.lastVerifiedAt) > now.getTime())) {
        return unavailable("invalid-reviewed-identity");
      }
      if (typeof request.credential !== "string" || request.credential.length === 0) return unavailable("credential-unavailable");

      const scope = {
        kind: "project",
        id: identity.projectId,
        parent: { kind: "workspace", id: identity.organizationId },
      };
      let state;
      try {
        state = createOpenAIAdminRequestState({
          fetch: fetchImpl,
          credential: request.credential,
          scope,
          keyId: identity.keyId,
          deadlineMs: Math.min(timeoutMs, request.limits?.deadlineMs ?? timeoutMs),
          maxPages: request.limits?.maxPages ?? 20,
          maxResponseBytes: Math.min(maxResponseBytes, request.limits?.maxResponseBytes ?? maxResponseBytes),
          signal: request.signal,
        });
      } catch {
        return unavailable("invalid-adapter-request");
      }

      try {
        const project = await verifyOpenAIProject(state, scope, identity.projectName);
        if (!project.ok) return unavailable(project.reason);

        const evidence = [];
        if (request.checks.includes("ownership")) {
          const keyResult = await collectProjectKey(state, identity);
          if (hardFailure(keyResult)) return unavailable(keyResult.reason);
          evidence.push(ownershipEvidence(project.value, keyResult, identity, now));
        }

        let recurringCost;
        if (request.checks.includes("cost")) {
          const usage = await collectUsage(state, identity);
          if (hardFailure(usage)) return unavailable(usage.reason);
          if (identity.access.billing === "yes") {
            const costs = await collectCosts(state, identity);
            if (hardFailure(costs)) return unavailable(costs.reason);
            evidence.push(usageCostEvidence(usage, costs, identity));
            recurringCost = {
              state: costs.ok ? (costs.value.amount > 0 ? "present" : "absent") : "unknown",
              url: CONSOLE_URL,
            };
          } else {
            evidence.push(usageCostEvidence(usage, unavailableResult(`billing-access-${identity.access.billing}`), identity));
            recurringCost = { state: "unknown", url: CONSOLE_URL };
          }
        }

        if (evidence.length > (request.limits?.maxCandidates ?? 50)) return unavailable("provider-resource-limit-exceeded");
        return {
          status: "success",
          observedIdentity: structuredClone(identity),
          observedAt: now.toISOString(),
          evidence,
          ...(recurringCost ? { recurringCost } : {}),
        };
      } catch {
        return unavailable(state.didTimeout() ? "provider-timeout" : "provider-unavailable");
      } finally {
        state.dispose();
      }
    },
  });
}

export const openAIProjectEvidenceAdapter = createOpenAIProjectEvidenceAdapter();

export function validateOpenAIProjectEvidenceIdentity(identity) {
  if (!plainObject(identity) || !exactKeys(identity, IDENTITY_KEYS)) return false;
  if (!validateOpenAIOrganizationId(identity.organizationId)
      || !validateOpenAIProjectId(identity.projectId)
      || !validateOpenAIKeyId(identity.keyId)
      || !validReviewedText(identity.projectName, 200)) return false;
  if (!plainObject(identity.access) || !exactKeys(identity.access, ["billing", "project"])) return false;
  if (identity.access.project !== "yes" || !new Set(["yes", "no", "unknown"]).has(identity.access.billing)) return false;
  if (!plainObject(identity.stewardship) || !exactKeys(identity.stewardship, [
    "billingOwner", "credentialOwner", "lastVerifiedAt", "purpose", "rotationDueAt",
  ])) return false;
  if (!validReviewedText(identity.stewardship.credentialOwner, 100)
      || (identity.stewardship.billingOwner !== null && !validReviewedText(identity.stewardship.billingOwner, 100))
      || !validReviewedText(identity.stewardship.purpose, 200)
      || !nullableDateTime(identity.stewardship.lastVerifiedAt)
      || !nullableDateTime(identity.stewardship.rotationDueAt)) return false;
  if (!plainObject(identity.window) || !exactKeys(identity.window, ["endTime", "startTime"])) return false;
  const start = Date.parse(identity.window.startTime);
  const end = Date.parse(identity.window.endTime);
  return Number.isFinite(start)
    && Number.isFinite(end)
    && start < end
    && start % 1000 === 0
    && end % 1000 === 0
    && end - start <= 31 * 24 * 60 * 60 * 1000
    && new Date(start).toISOString() === identity.window.startTime
    && new Date(end).toISOString() === identity.window.endTime;
}

async function collectProjectKey(state, identity) {
  let after;
  const cursors = new Set();
  let match = null;
  while (true) {
    const result = await state.get(`/v1/organization/projects/${encodeURIComponent(identity.projectId)}/api_keys`, {
      limit: 100,
      ...(after ? { after } : {}),
    });
    if (!result.ok) return result;
    const page = parseKeyPage(result.value);
    if (!page.ok) return page;
    for (const key of page.value.keys) {
      if (key.id !== identity.keyId) continue;
      if (match) return unavailableResult("provider-invalid-response");
      match = key;
    }
    if (!page.value.hasMore) break;
    if (!page.value.lastId || cursors.has(page.value.lastId)) return unavailableResult("provider-invalid-pagination");
    cursors.add(page.value.lastId);
    after = page.value.lastId;
  }
  return match ? { ok: true, value: match } : unavailableResult("provider-resource-not-found");
}

function parseKeyPage(value) {
  if (!plainObject(value) || value.object !== "list" || !Array.isArray(value.data) || typeof value.has_more !== "boolean") {
    return unavailableResult("provider-invalid-response");
  }
  const keys = [];
  const ids = new Set();
  for (const raw of value.data) {
    const key = parseKey(raw);
    if (!key || ids.has(key.id)) return unavailableResult("provider-invalid-response");
    ids.add(key.id);
    keys.push(key);
  }
  if (value.last_id !== null && value.last_id !== undefined && !validateOpenAIKeyId(value.last_id)) {
    return unavailableResult("provider-invalid-response");
  }
  return { ok: true, value: { keys, hasMore: value.has_more, lastId: value.last_id ?? null } };
}

function parseKey(value) {
  if (!plainObject(value)
      || value.object !== "organization.project.api_key"
      || !validateOpenAIKeyId(value.id)
      || !Number.isSafeInteger(value.created_at)
      || value.created_at < 1
      || (value.last_used_at !== null && (!Number.isSafeInteger(value.last_used_at) || value.last_used_at < 1))) return null;
  if (typeof value.redacted_value !== "string" || !/^sk-[A-Za-z0-9_-]{1,32}\.\.\.[A-Za-z0-9_-]{1,32}$/.test(value.redacted_value)) return null;
  if (!plainObject(value.owner) || !new Set(["user", "service_account"]).has(value.owner.type)) return null;
  const owner = value.owner[value.owner.type];
  if (!plainObject(owner) || typeof owner.id !== "string" || !/^[A-Za-z0-9_-]{3,150}$/.test(owner.id)) return null;
  return {
    id: value.id,
    name: safeLabel(value.name),
    createdAt: new Date(value.created_at * 1000).toISOString(),
    lastUsedAt: value.last_used_at === null ? null : new Date(value.last_used_at * 1000).toISOString(),
    ownerType: value.owner.type,
    ownerId: owner.id,
  };
}

async function collectUsage(state, identity) {
  const collected = await collectWindowPages(state, "/v1/organization/usage/completions", identity, parseUsagePage);
  if (!collected.ok) return collected;
  return {
    ok: true,
    value: collected.value.reduce((total, item) => ({
      inputTokens: total.inputTokens + item.inputTokens,
      outputTokens: total.outputTokens + item.outputTokens,
      requests: total.requests + item.requests,
    }), { inputTokens: 0, outputTokens: 0, requests: 0 }),
  };
}

async function collectCosts(state, identity) {
  const collected = await collectWindowPages(state, "/v1/organization/costs", identity, parseCostPage);
  if (!collected.ok) return collected;
  const currencies = new Set(collected.value.map((item) => item.currency));
  if (currencies.size > 1) return unavailableResult("provider-invalid-response");
  return {
    ok: true,
    value: {
      amount: collected.value.reduce((sum, item) => sum + item.amount, 0),
      currency: [...currencies][0] ?? "usd",
    },
  };
}

async function collectWindowPages(state, path, identity, parsePage) {
  const startTime = Math.floor(Date.parse(identity.window.startTime) / 1000);
  const endTime = Math.floor(Date.parse(identity.window.endTime) / 1000);
  let page;
  const cursors = new Set();
  const bucketIntervals = [];
  const values = [];
  while (true) {
    const result = await state.get(path, {
      start_time: startTime,
      end_time: endTime,
      bucket_width: "1d",
      project_ids: identity.projectId,
      api_key_ids: identity.keyId,
      group_by: "project_id,api_key_id",
      limit: 31,
      ...(page ? { page } : {}),
    });
    if (!result.ok) return result;
    const parsed = parsePage(result.value, identity);
    if (!parsed.ok) return parsed;
    for (const bucket of parsed.value.buckets) {
      if (bucketIntervals.some(([seenStart, seenEnd]) => bucket.start_time < seenEnd && bucket.end_time > seenStart)) {
        return unavailableResult("provider-invalid-pagination");
      }
      bucketIntervals.push([bucket.start_time, bucket.end_time]);
    }
    values.push(...parsed.value.results);
    if (!parsed.value.hasMore) break;
    if (!parsed.value.nextPage || cursors.has(parsed.value.nextPage)) return unavailableResult("provider-invalid-pagination");
    cursors.add(parsed.value.nextPage);
    page = parsed.value.nextPage;
  }
  return { ok: true, value: values };
}

function parseUsagePage(value, identity) {
  const buckets = parseBuckets(value, identity);
  if (!buckets.ok) return buckets;
  const results = [];
  for (const bucket of buckets.value.buckets) {
    for (const raw of bucket.results) {
      if (!plainObject(raw)
          || raw.object !== "organization.usage.completions.result"
          || raw.project_id !== identity.projectId
          || raw.api_key_id !== identity.keyId
          || !nonNegativeInteger(raw.input_tokens)
          || !nonNegativeInteger(raw.output_tokens)
          || !nonNegativeInteger(raw.num_model_requests)) return unavailableResult("provider-invalid-response");
      results.push({ inputTokens: raw.input_tokens, outputTokens: raw.output_tokens, requests: raw.num_model_requests });
    }
  }
  return { ok: true, value: { ...buckets.value, results } };
}

function parseCostPage(value, identity) {
  const buckets = parseBuckets(value, identity);
  if (!buckets.ok) return buckets;
  const results = [];
  for (const bucket of buckets.value.buckets) {
    for (const raw of bucket.results) {
      if (!plainObject(raw)
          || raw.object !== "organization.costs.result"
          || raw.project_id !== identity.projectId
          || raw.api_key_id !== identity.keyId
          || !plainObject(raw.amount)
          || typeof raw.amount.value !== "number"
          || !Number.isFinite(raw.amount.value)
          || raw.amount.value < 0
          || typeof raw.amount.currency !== "string"
          || !/^[a-z]{3}$/i.test(raw.amount.currency)) return unavailableResult("provider-invalid-response");
      results.push({ amount: raw.amount.value, currency: raw.amount.currency.toLowerCase() });
    }
  }
  return { ok: true, value: { ...buckets.value, results } };
}

function parseBuckets(value, identity) {
  if (!plainObject(value)
      || value.object !== "page"
      || !Array.isArray(value.data)
      || typeof value.has_more !== "boolean"
      || (value.next_page !== null && value.next_page !== undefined && (typeof value.next_page !== "string" || value.next_page.length > 500))) {
    return unavailableResult("provider-invalid-response");
  }
  const requestedStart = Math.floor(Date.parse(identity.window.startTime) / 1000);
  const requestedEnd = Math.floor(Date.parse(identity.window.endTime) / 1000);
  const buckets = [];
  for (const bucket of value.data) {
    if (!plainObject(bucket)
        || bucket.object !== "bucket"
        || !Number.isSafeInteger(bucket.start_time)
        || !Number.isSafeInteger(bucket.end_time)
        || bucket.start_time >= bucket.end_time
        || bucket.start_time < requestedStart
        || bucket.end_time > requestedEnd
        || !Array.isArray(bucket.results)) return unavailableResult("provider-invalid-response");
    buckets.push(bucket);
  }
  return {
    ok: true,
    value: { buckets, hasMore: value.has_more, nextPage: value.next_page ?? null },
  };
}

function ownershipEvidence(project, key, identity, now) {
  const { stewardship } = identity;
  const rotationDue = stewardship.rotationDueAt !== null && Date.parse(stewardship.rotationDueAt) < now.getTime();
  const gaps = [];
  if (!key.ok) gaps.push(`key metadata unavailable (${key.reason})`);
  if (stewardship.billingOwner === null) gaps.push("billing owner unknown");
  if (stewardship.lastVerifiedAt === null) gaps.push("verification date unknown");
  if (rotationDue) gaps.push(`rotation due ${stewardship.rotationDueAt}`);
  const keyNote = key.ok
    ? `key ${key.value.id}, provider owner type ${key.value.ownerType}, last used ${key.value.lastUsedAt ?? "not reported"}`
    : `key ${identity.keyId} metadata unavailable (${key.reason})`;
  return {
    id: "openai-project-key-ownership",
    check: "ownership",
    state: gaps.length ? "unknown" : "declared",
    note: `OpenAI Admin API verified exact project ${project.id}; ${keyNote}. Reviewed stewardship: credential owner ${stewardship.credentialOwner}, billing owner ${stewardship.billingOwner ?? "unknown"}, purpose ${stewardship.purpose}. ${gaps.length ? `Unknown: ${gaps.join(", ")}.` : `Last verified ${stewardship.lastVerifiedAt}; rotation due ${stewardship.rotationDueAt ?? "not scheduled"}.`} Access does not prove ownership; no key value was retained.`,
    url: CONSOLE_URL,
  };
}

function usageCostEvidence(usage, costs, identity) {
  const usageNote = usage.ok
    ? `Completions Usage API: ${usage.value.requests} requests, ${usage.value.inputTokens} input and ${usage.value.outputTokens} output tokens`
    : `Completions Usage API unavailable (${usage.reason})`;
  const costNote = costs.ok
    ? `Costs API: ${formatAmount(costs.value.amount)} ${costs.value.currency.toUpperCase()} currency units`
    : `Costs API unavailable (${costs.reason})`;
  return {
    id: "openai-usage-cost-window",
    check: "cost",
    state: usage.ok && costs.ok ? "verified" : "unknown",
    note: `OpenAI ${windowNote(identity.window)} for exact project ${identity.projectId} and key ${identity.keyId}. ${usageNote}; ${costNote}. Source is the named API; normalized evidence adds observation time and freshness. Usage is not billing proof.`,
    url: CONSOLE_URL,
  };
}

function windowNote(window) {
  return `period [${window.startTime}, ${window.endTime})`;
}

function formatAmount(value) {
  return Number(value.toFixed(8)).toString();
}

function safeLabel(value) {
  if (!validReviewedText(value, 200)) return null;
  return /\b(?:bearer|password|secret|token)\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}/i.test(value) ? null : value;
}

function validReviewedText(value, maximum) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value === value.trim() && !/[\r\n]/.test(value);
}

function nullableDateTime(value) {
  return value === null || (typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value);
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
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

function hardFailure(result) {
  return !result.ok && new Set(["provider-credential-rejected", "provider-resource-not-found"]).has(result.reason);
}
