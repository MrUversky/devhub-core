import { readFile, stat } from "node:fs/promises";

import {
  createMemoryEvidenceCache,
  runEvidenceAdapter,
  validateEvidenceBinding,
} from "../lib/evidence-adapters.mjs";
import { evidenceAdapterRegistry } from "../lib/evidence-adapters/registry.mjs";

const MAX_BINDING_FILE_BYTES = 256 * 1024;
const BINDING_FIELDS = new Set([
  "projectId",
  "serviceId",
  "adapterId",
  "provider",
  "reviewedIdentity",
  "credentialEnv",
  "checks",
  "freshForSeconds",
]);

export class EvidenceCollectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EvidenceCollectionError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new EvidenceCollectionError(code, message);
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactFields(value, fields, label) {
  for (const key of Object.keys(value)) {
    if (!fields.has(key)) fail("invalid-evidence-binding", `${label}.${key} is not supported`);
  }
}

export function parseEvidenceBindingDocument(value) {
  if (!plainObject(value)) fail("invalid-evidence-binding", "binding document must be an object");
  let bindings;
  if (Object.hasOwn(value, "bindings")) {
    exactFields(value, new Set(["version", "bindings"]), "document");
    if (value.version !== 1) fail("invalid-evidence-binding", "binding document version must be 1");
    if (!Array.isArray(value.bindings) || value.bindings.length === 0) {
      fail("invalid-evidence-binding", "binding document bindings must be a non-empty array");
    }
    bindings = value.bindings;
  } else {
    bindings = [value];
  }
  if (bindings.length > 50) fail("invalid-evidence-binding", "binding document must contain at most 50 bindings");
  for (const [index, binding] of bindings.entries()) {
    if (!plainObject(binding)) fail("invalid-evidence-binding", `bindings[${index}] must be an object`);
    exactFields(binding, BINDING_FIELDS, `bindings[${index}]`);
  }
  return bindings.map((binding) => structuredClone(binding));
}

export async function readEvidenceBindingDocument(filename) {
  const details = await stat(filename);
  if (!details.isFile()) fail("invalid-evidence-binding", `${filename} must be a file`);
  if (details.size > MAX_BINDING_FILE_BYTES) {
    fail("invalid-evidence-binding", `${filename} exceeds the ${MAX_BINDING_FILE_BYTES}-byte binding limit`);
  }
  let value;
  try {
    value = JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) fail("invalid-evidence-binding", `${filename} must contain valid JSON`);
    throw error;
  }
  return parseEvidenceBindingDocument(value);
}

function normalizeGitHubRepository(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const raw = value.trim().replace(/\.git$/, "");
  if (/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(raw)) return raw.toLowerCase();
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.search || url.hash) return null;
    const parts = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "").split("/");
    return parts.length === 2 && parts.every(Boolean) ? parts.join("/").toLowerCase() : null;
  } catch {
    return null;
  }
}

function reviewedRepositories(project, service) {
  const serviceRepositories = (service.links ?? [])
    .filter((link) => link.type === "repository")
    .map((link) => link.url);
  const values = serviceRepositories.length ? serviceRepositories : [project.repository];
  return new Set(values.map(normalizeGitHubRepository).filter(Boolean));
}

function prepareBindings(sourceCatalog, bindings, registry) {
  const projects = new Map(sourceCatalog.projects.map(({ manifest }) => [manifest.id, manifest]));
  return bindings.map((binding, index) => {
    const adapter = registry.get(binding.adapterId);
    if (!adapter) {
      fail("unknown-evidence-adapter", `bindings[${index}] adapterId is not registered: ${binding.adapterId}`);
    }
    let reviewedBinding;
    try {
      reviewedBinding = validateEvidenceBinding(binding, adapter);
    } catch (error) {
      fail(error?.code ?? "invalid-evidence-binding", `bindings[${index}]: ${error instanceof Error ? error.message : String(error)}`);
    }
    const project = projects.get(reviewedBinding.projectId);
    const service = project?.services?.find((candidate) => candidate.id === reviewedBinding.serviceId);
    if (!project || !service) {
      fail("catalog-binding-mismatch", `bindings[${index}] does not match a reviewed catalog project/service`);
    }
    if (reviewedBinding.provider === "github") {
      const requested = normalizeGitHubRepository(`${reviewedBinding.reviewedIdentity.owner}/${reviewedBinding.reviewedIdentity.repository}`);
      const allowed = reviewedRepositories(project, service);
      if (!requested || !allowed.has(requested)) {
        fail("catalog-repository-mismatch", `bindings[${index}] GitHub repository is not reviewed on ${project.id}/${service.id}`);
      }
    }
    return { binding: reviewedBinding, adapter };
  });
}

export async function collectEvidenceBindings(sourceCatalog, bindingInput, options = {}) {
  const registry = options.registry ?? evidenceAdapterRegistry;
  const bindings = Array.isArray(bindingInput) ? bindingInput : parseEvidenceBindingDocument(bindingInput);
  const prepared = prepareBindings(sourceCatalog, bindings, registry);
  const cache = options.cache ?? createMemoryEvidenceCache();
  const environment = options.environment ?? process.env;
  const collectedAt = new Date(options.now ?? Date.now());
  if (!Number.isFinite(collectedAt.getTime())) fail("invalid-now", "evidence collection requires a valid now value");
  const results = [];
  for (const { binding, adapter } of prepared) {
    results.push(await runEvidenceAdapter({
      binding,
      adapter,
      environment,
      now: collectedAt,
      cache,
    }));
  }
  return {
    version: 1,
    command: "collect-evidence",
    readOnly: true,
    collectedAt: collectedAt.toISOString(),
    summary: {
      bindings: results.length,
      succeeded: results.filter((result) => result.execution.state === "succeeded").length,
      unknown: results.filter((result) => result.execution.state === "failed").length,
    },
    results,
  };
}

export function formatEvidenceCollection(collection) {
  const lines = [
    `DevHub evidence collection: ${collection.summary.succeeded} refreshed, ${collection.summary.unknown} unknown.`,
  ];
  for (const result of collection.results) {
    const subject = `${result.identity.projectId}/${result.identity.serviceId}`;
    lines.push(`${subject} ${result.identity.adapterId}: ${result.execution.state} · ${result.freshness.state}`);
    for (const evidence of result.evidence) lines.push(`  ${evidence.check}: ${evidence.state} — ${evidence.note}`);
  }
  return lines.join("\n");
}
