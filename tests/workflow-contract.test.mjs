import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createWorkflowContract,
  isWorkflowContract,
  WORKFLOW_CAPABILITIES,
  WORKFLOW_CONTRACT_VERSION,
} from "../lib/workflow-contract.mjs";

const packageDocument = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

test("workflow contract is exact, deterministic and immutable", () => {
  const first = createWorkflowContract(packageDocument.version);
  const second = createWorkflowContract(packageDocument.version);
  assert.deepEqual(first, second);
  assert.deepEqual(first, {
    contractVersion: 2,
    runtimeVersion: packageDocument.version,
    capabilities: { setupRun: 1, connectionReview: 1, guidedConfirmation: 1, taskObservation: 1 },
  });
  assert.equal(WORKFLOW_CONTRACT_VERSION, 2);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(WORKFLOW_CAPABILITIES), true);
  assert.equal(isWorkflowContract(first), true);
});

test("workflow compatibility rejects old doctor output, drift and extra fields", () => {
  const current = createWorkflowContract(packageDocument.version);
  assert.equal(isWorkflowContract({ version: 1, command: "doctor", readOnly: true, findings: [] }), false);
  assert.equal(isWorkflowContract({ ...current, contractVersion: 1 }), false);
  assert.equal(isWorkflowContract({ ...current, capabilities: { setupRun: 1, connectionReview: 1, guidedConfirmation: 1 } }), false);
  assert.equal(isWorkflowContract({ ...current, capabilities: { ...current.capabilities, setupRun: 2 } }), false);
  assert.equal(isWorkflowContract({ ...current, capabilities: { ...current.capabilities, extra: 1 } }), false);
  assert.equal(isWorkflowContract({ ...current, extra: true }), false);
  assert.throws(() => createWorkflowContract("not-a-version"), /semantic package version/i);
});

test("workflow contract module has no provider, credential or configuration dependency", async () => {
  const source = await readFile(new URL("../lib/workflow-contract.mjs", import.meta.url), "utf8");
  assert.deepEqual([...source.matchAll(/from\s+["']([^"']+)["']/g)], []);
  assert.doesNotMatch(source, /node:|provider|credential|catalog|setup-session|process\.env/i);
});
