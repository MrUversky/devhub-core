import path from "node:path";

import { runIsolatedJsonChild } from "./isolated-json-child.mjs";

const MAX_PLAN_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const probeIdPattern = /^[a-z0-9]+(?:[.:_-][a-z0-9]+)*$/;
const defaultChildPath = path.join(import.meta.dirname, "connected-setup-probe-child.mjs");

function normalizePlan(probes) {
  if (!Array.isArray(probes) || probes.length > 256) throw new TypeError("isolated marker probes must be a bounded array");
  const ids = new Set();
  const normalized = probes.map((probe) => {
    if (!probe || typeof probe !== "object" || Array.isArray(probe)
        || Object.keys(probe).sort().join(",") !== "candidates,id,kind"
        || typeof probe.id !== "string" || !probeIdPattern.test(probe.id) || ids.has(probe.id)
        || !["access", "lstat"].includes(probe.kind)
        || !Array.isArray(probe.candidates) || probe.candidates.length > 256
        || !probe.candidates.every((candidate) => typeof candidate === "string" && path.isAbsolute(candidate) && !candidate.includes("\0") && Buffer.byteLength(candidate, "utf8") <= 4096)) {
      throw new TypeError("isolated marker probe is invalid");
    }
    ids.add(probe.id);
    return { id: probe.id, kind: probe.kind, candidates: [...probe.candidates] };
  });
  const document = { version: 1, probes: normalized };
  const input = `${JSON.stringify(document)}\n`;
  if (Buffer.byteLength(input, "utf8") > MAX_PLAN_BYTES) throw new TypeError("isolated marker probe plan is too large");
  return { document, input };
}

function normalizeResult(stdout, plan) {
  let value;
  try { value = JSON.parse(stdout); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "results,version"
      || value.version !== 1 || !Array.isArray(value.results)
      || value.results.length !== plan.document.probes.length) return null;
  const expected = new Set(plan.document.probes.map((probe) => probe.id));
  const results = [];
  for (const item of value.results) {
    if (!item || typeof item !== "object" || Array.isArray(item)
        || Object.keys(item).sort().join(",") !== "id,state"
        || typeof item.id !== "string" || !expected.delete(item.id)
        || !["present", "absent"].includes(item.state)) return null;
    results.push({ id: item.id, state: item.state });
  }
  return expected.size === 0 ? results.sort((left, right) => left.id.localeCompare(right.id)) : null;
}

export async function runIsolatedMarkerProbePlan(probes, options = {}) {
  const plan = normalizePlan(probes);
  const childPath = options.childPath ?? defaultChildPath;
  const execution = await runIsolatedJsonChild({
    childPath,
    input: plan.input,
    signal: options.signal,
    maxInputBytes: MAX_PLAN_BYTES,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  });
  if (execution.state === "aborted") return Object.freeze({ state: "aborted", results: Object.freeze([]) });
  const results = execution.state === "completed" ? normalizeResult(execution.stdout, plan) : null;
  return Object.freeze({ state: results ? "completed" : "unavailable", results: Object.freeze(results ?? []) });
}
