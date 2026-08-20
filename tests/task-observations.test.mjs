import assert from "node:assert/strict";
import test from "node:test";

import { vercelSetupConnector, vercelTaskObservationBridge } from "../lib/setup-connectors/vercel.mjs";
import { railwaySetupConnector, railwayTaskObservationBridge } from "../lib/setup-connectors/railway.mjs";
import {
  createTaskObservationBridgeRegistry,
  parseTaskObservationDocument,
  TaskObservationError,
} from "../lib/task-observations.mjs";

const NOW = "2026-08-13T09:02:00.000Z";
const OBSERVED_AT = "2026-08-13T09:00:00.000Z";

function document(overrides = {}) {
  return {
    version: 1,
    selectedConnectorIds: ["vercel"],
    observations: [{
      connectorId: "vercel",
      bridgeId: vercelTaskObservationBridge.id,
      observedAt: OBSERVED_AT,
      scope: { kind: "team", label: "Fictional Studio" },
      resources: [{ kind: "project", label: "Portfolio" }],
    }],
    ...overrides,
  };
}

test("selected current plugin observations normalize to bounded review-only evidence", () => {
  const bridges = createTaskObservationBridgeRegistry([vercelSetupConnector]);
  const parsed = parseTaskObservationDocument(document(), {
    selectedConnectorIds: ["vercel"],
    bridges,
    now: NOW,
  });

  assert.deepEqual(parsed.selectedConnectorIds, ["vercel"]);
  assert.equal(parsed.observations[0].trust, "untrusted-transient-review-only");
  assert.equal(parsed.observations[0].scope.label, "Fictional Studio");
  assert.equal(parsed.observations[0].resourceCount, 1);
  assert.match(parsed.observations[0].normalizedInventory.source.scope.id, /^task-scope-[a-f0-9]{24}$/);
  assert.match(parsed.observations[0].normalizedInventory.candidates[0].resourceId, /^task-resource-[a-f0-9]{24}$/);
  assert.equal(Object.isFrozen(parsed), true);
  assert.doesNotMatch(JSON.stringify(parsed), /team_[A-Za-z0-9]+|prj_[A-Za-z0-9]+|credential|locator|authorization/i);
});

test("task observations reject unselected, stale, duplicate, raw-id and secret-bearing input", () => {
  const options = { selectedConnectorIds: ["vercel"], connectors: [vercelSetupConnector], now: NOW };
  const rejection = (value, code) => assert.throws(
    () => parseTaskObservationDocument(value, options),
    (error) => error instanceof TaskObservationError && error.code === code,
  );

  rejection(document({ selectedConnectorIds: ["railway"] }), "task-observation-selection-mismatch");
  rejection(document({ observations: [{ ...document().observations[0], connectorId: "railway" }] }), "task-observation-selection-mismatch");
  rejection(document({ observations: [document().observations[0], document().observations[0]] }), "task-observation-invalid");
  rejection(document({ observations: [{ ...document().observations[0], observedAt: "2026-08-13T08:00:00.000Z" }] }), "task-observation-stale");
  rejection(document({ observations: [{ ...document().observations[0], observedAt: "2026-08-13T09:02:00.001Z" }] }), "task-observation-stale");
  rejection(document({ observations: [{ ...document().observations[0], scope: { kind: "team", label: "Fictional Studio", id: "team_raw" } }] }), "task-observation-invalid");
  rejection(document({ observations: [{ ...document().observations[0], resources: [{ kind: "project", label: ["to", "ken=unsafe-fixture-value"].join("") }] }] }), "task-observation-unsafe");
});

test("task observations are canonical by selected order and bridge identity", () => {
  const connectors = [vercelSetupConnector, railwaySetupConnector];
  const observations = [
    document().observations[0],
    { connectorId: "railway", bridgeId: railwayTaskObservationBridge.id, observedAt: OBSERVED_AT, scope: { kind: "workspace", label: "Railway Studio" }, resources: [] },
  ];
  const parsed = parseTaskObservationDocument({ version: 1, selectedConnectorIds: ["vercel", "railway"], observations }, {
    selectedConnectorIds: ["vercel", "railway"], connectors, now: NOW,
  });
  assert.deepEqual(parsed.observations.map((observation) => observation.connectorId), ["vercel", "railway"]);
  assert.throws(() => parseTaskObservationDocument({ version: 1, selectedConnectorIds: ["vercel", "railway"], observations: observations.toReversed() }, {
    selectedConnectorIds: ["vercel", "railway"], connectors, now: NOW,
  }), (error) => error.code === "task-observation-selection-mismatch");
});
