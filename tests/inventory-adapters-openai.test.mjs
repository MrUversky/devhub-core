import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  OPENAI_PROJECT_INVENTORY_ADAPTER_ID,
  createOpenAIProjectInventoryAdapter,
} from "../lib/inventory-adapters/providers/openai.mjs";
import { createInventoryAdapterRegistry } from "../lib/inventory-adapters/registry.mjs";
import { runInventoryAdapter } from "../lib/inventory-adapters.mjs";

const [PROJECT, KEYS] = await Promise.all([
  readFile(new URL("fixtures/inventory-adapters/openai-project.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("fixtures/evidence-adapters/openai-project-api-keys.json", import.meta.url), "utf8").then(JSON.parse),
]);
const NOW = "2026-08-13T09:00:00.000Z";
const SCOPE = { kind: "project", id: PROJECT.id, parent: { kind: "workspace", id: "org_fictional_studio" } };

test("OpenAI inventory verifies one exact organization/project without enumerating the organization", async () => {
  const calls = [];
  const adapter = createOpenAIProjectInventoryAdapter({ fetch: async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    return Response.json(url.pathname.endsWith("/api_keys") ? KEYS : PROJECT);
  } });
  const result = await runInventoryAdapter({
    adapter,
    binding: {
      adapterId: adapter.id,
      provider: "openai",
      scope: SCOPE,
      credentialEnv: "OPENAI_ADMIN_KEY",
      freshForSeconds: 3600,
      maxResources: 50,
      maxPages: 20,
      deadlineMs: 1000,
      maxResponseBytes: 1024 * 1024,
    },
    environment: { OPENAI_ADMIN_KEY: "fictional-admin-credential-never-returned" },
    now: NOW,
  });

  assert.equal(result.execution.state, "succeeded");
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.candidates[0].metadata, {
    version: "active",
    workspaceId: "org_fictional_studio",
    projectId: PROJECT.id,
  });
  assert.deepEqual(result.candidates[1], {
    provider: "openai",
    resourceType: "api-key",
    resourceId: "key_fictional_shared",
    parentResourceId: PROJECT.id,
    name: "Fictional shared runtime",
    urls: [{ kind: "console", url: "https://platform.openai.com/api-keys" }],
    observedAt: NOW,
    validUntil: "2026-08-13T10:00:00.000Z",
    freshness: "fresh",
    metadata: {
      ownerType: "service_account",
      ownerId: "svc_fictional_runtime",
      createdAt: "2026-08-01T00:00:00.000Z",
      lastUsedAt: "2026-08-10T00:00:00.000Z",
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.pathname, `/v1/organization/projects/${PROJECT.id}`);
  assert.equal(calls[1].url.pathname, `/v1/organization/projects/${PROJECT.id}/api_keys`);
  for (const call of calls) {
    assert.equal(call.init.method, "GET");
    assert.equal(call.init.headers["openai-organization"], "org_fictional_studio");
  }
  assert.doesNotMatch(JSON.stringify(result), /fictional-admin-credential|private_note|redacted_value|sk-fiction/);
});

test("OpenAI key inventory fails closed instead of truncating a project at the reviewed candidate limit", async () => {
  const adapter = createOpenAIProjectInventoryAdapter({ fetch: async (input) => {
    const url = new URL(input);
    if (!url.pathname.endsWith("/api_keys")) return Response.json(PROJECT);
    return Response.json({ ...KEYS, has_more: true });
  } });
  const result = await runInventoryAdapter({
    adapter,
    binding: {
      adapterId: adapter.id,
      provider: "openai",
      scope: SCOPE,
      credentialEnv: "OPENAI_ADMIN_KEY",
      freshForSeconds: 3600,
      maxResources: 2,
      maxPages: 20,
      deadlineMs: 1000,
      maxResponseBytes: 1024 * 1024,
    },
    environment: { OPENAI_ADMIN_KEY: "fictional" },
    now: NOW,
  });
  assert.equal(result.execution.state, "failed");
  assert.equal(result.execution.reason, "provider-resource-limit-exceeded");
  assert.deepEqual(result.candidates, []);
});

test("OpenAI inventory accepts only an exact organization/project scope and is canonical", () => {
  const adapter = createOpenAIProjectInventoryAdapter({ fetch: async () => Response.json(PROJECT) });
  assert.equal(adapter.id, OPENAI_PROJECT_INVENTORY_ADAPTER_ID);
  assert.equal(adapter.validateScope(SCOPE), true);
  assert.equal(adapter.validateScope({ kind: "workspace", id: "org_fictional_studio" }), false);
  assert.equal(adapter.validateScope({ ...SCOPE, parent: { kind: "workspace", id: "other" } }), false);
  const registry = createInventoryAdapterRegistry({ fetch: async () => Response.json(PROJECT) });
  assert.equal(registry.get(OPENAI_PROJECT_INVENTORY_ADAPTER_ID)?.provider, "openai");
});

test("missing Keychain inventory reference stays unknown before provider IO", async () => {
  let calls = 0;
  let resolved;
  const adapter = createOpenAIProjectInventoryAdapter({ fetch: async () => { calls += 1; return Response.json(PROJECT); } });
  const result = await runInventoryAdapter({
    adapter,
    binding: {
      adapterId: adapter.id,
      provider: "openai",
      scope: SCOPE,
      credentialRef: { kind: "keychain", locator: "generic-password:devhub:openai-admin" },
      freshForSeconds: 3600,
      maxResources: 1,
      maxPages: 1,
      deadlineMs: 1000,
      maxResponseBytes: 1024 * 1024,
    },
    resolveCredential(reference) { resolved = reference; return undefined; },
    now: NOW,
  });
  assert.deepEqual(resolved, { kind: "keychain", locator: "generic-password:devhub:openai-admin" });
  assert.equal(result.execution.reason, "credential-unavailable");
  assert.equal(calls, 0);
  assert.doesNotMatch(JSON.stringify(result), /generic-password|openai-admin/);
});
