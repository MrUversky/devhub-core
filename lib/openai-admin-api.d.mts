import type { InventoryScope } from "./inventory-adapters.mjs";

export type OpenAIProjectScope = InventoryScope & {
  kind: "project";
  id: string;
  parent: { kind: "workspace"; id: string };
};

export type OpenAIAdminFetch = typeof globalThis.fetch;
export type OpenAIAdminRequestState = Readonly<{
  get(path: string, query?: Record<string, unknown>): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }>;
  pagesRead(): number;
  didTimeout(): boolean;
  dispose(): void;
}>;

export function validateOpenAIOrganizationId(value: unknown): value is string;
export function validateOpenAIProjectId(value: unknown): value is string;
export function validateOpenAIKeyId(value: unknown): value is string;
export function validateOpenAIProjectScope(scope: unknown): scope is OpenAIProjectScope;
export function createOpenAIAdminRequestState(options: {
  fetch: OpenAIAdminFetch;
  credential: string;
  scope: OpenAIProjectScope;
  keyId?: string | null;
  deadlineMs: number;
  maxPages: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
}): OpenAIAdminRequestState;
export function verifyOpenAIProject(
  state: OpenAIAdminRequestState,
  scope: OpenAIProjectScope,
  expectedName?: string | null,
): Promise<{ ok: true; value: { id: string; name: string; status: string; createdAt: string; archivedAt: string | null } } | { ok: false; reason: string }>;
export function listOpenAIProjectKeys(
  state: OpenAIAdminRequestState,
  scope: OpenAIProjectScope,
  options?: { maxKeys?: number },
): Promise<{
  ok: true;
  value: Array<{
    id: string;
    name: string | null;
    createdAt: string;
    lastUsedAt: string | null;
    ownerType: "user" | "service_account";
    ownerId: string;
  }>;
} | { ok: false; reason: string }>;
