import assert from "node:assert/strict";
import test from "node:test";

import { matchesServiceStatusFilter, serviceStatusFilterLabels } from "../lib/catalog-service-filters.mjs";

const alwaysOn = { mode: "always-on" };
const onDemand = { mode: "on-demand" };

test("live means a successful live probe, not a manual report", () => {
  assert.equal(matchesServiceStatusFilter(alwaysOn, { source: "probe", state: "up" }, "live"), true);
  assert.equal(matchesServiceStatusFilter(alwaysOn, { source: "probe", state: "up", freshness: "stale" }, "live"), false);
  assert.equal(matchesServiceStatusFilter(alwaysOn, { source: "reported", state: "up" }, "live"), false);
  assert.equal(matchesServiceStatusFilter(alwaysOn, { source: "probe", state: "protected" }, "live"), false);
  assert.equal(serviceStatusFilterLabels.live, "Live");
});

test("reported up remains distinct from live and registered-only reports", () => {
  assert.equal(matchesServiceStatusFilter(alwaysOn, { source: "reported", state: "up" }, "reported"), true);
  assert.equal(matchesServiceStatusFilter(alwaysOn, { source: "reported", state: "registered" }, "reported"), false);
  assert.equal(matchesServiceStatusFilter(alwaysOn, { source: "probe", state: "up" }, "reported"), false);
});

test("not checked includes catalog and reported entries without an observation", () => {
  assert.equal(matchesServiceStatusFilter(alwaysOn, { source: "catalog", state: "registered" }, "unchecked"), true);
  assert.equal(matchesServiceStatusFilter(alwaysOn, { source: "reported", state: "registered" }, "unchecked"), true);
  assert.equal(matchesServiceStatusFilter(alwaysOn, { source: "catalog", state: "unknown" }, "unchecked"), true);
  assert.equal(matchesServiceStatusFilter(alwaysOn, { source: "probe", state: "up" }, "unchecked"), false);
});

test("needs action follows the always-on attention policy", () => {
  assert.equal(matchesServiceStatusFilter(alwaysOn, { source: "probe", state: "down" }, "attention"), true);
  assert.equal(matchesServiceStatusFilter(alwaysOn, { source: "probe", state: "degraded" }, "attention"), true);
  assert.equal(matchesServiceStatusFilter(onDemand, { source: "probe", state: "down" }, "attention"), false);
  assert.equal(matchesServiceStatusFilter(onDemand, { source: "catalog", state: "stopped" }, "attention"), false);
});

test("all accepts every status and unsupported filters fail closed", () => {
  assert.equal(matchesServiceStatusFilter(onDemand, { source: "catalog", state: "stopped" }, "all"), true);
  assert.throws(
    () => matchesServiceStatusFilter(alwaysOn, { source: "probe", state: "up" }, "unexpected"),
    /unsupported service status filter/i,
  );
});
