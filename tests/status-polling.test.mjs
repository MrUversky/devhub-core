import assert from "node:assert/strict";
import test from "node:test";

import {
  createStatusPollingRuntime,
  parseStatusPollingConfig,
  statusCadenceForService,
} from "../lib/status-polling.mjs";

const baseConfig = {
  ordinaryIntervalMs: 300_000,
  onDemandIntervalMs: 900_000,
  maxConcurrency: 4,
  jitterPercent: 0,
};

function entry(key, cadence = "ordinary") {
  return { key, cadence, input: { key } };
}

function status(key, checkedAt, state = "up") {
  return { key, checkedAt, state, source: "probe" };
}

test("polling config defaults to conservative 5 and 15 minute intervals", () => {
  assert.deepEqual(parseStatusPollingConfig({}), {
    ordinaryIntervalMs: 300_000,
    onDemandIntervalMs: 900_000,
    maxConcurrency: 4,
    jitterPercent: 10,
  });
  assert.deepEqual(parseStatusPollingConfig({
    DEVHUB_STATUS_PROBE_INTERVAL_SECONDS: "600",
    DEVHUB_STATUS_ON_DEMAND_INTERVAL_SECONDS: "1800",
    DEVHUB_STATUS_MAX_CONCURRENCY: "2",
    DEVHUB_STATUS_JITTER_PERCENT: "0",
  }), {
    ordinaryIntervalMs: 600_000,
    onDemandIntervalMs: 1_800_000,
    maxConcurrency: 2,
    jitterPercent: 0,
  });
});

test("polling config rejects unsafe, malformed and inverted intervals", () => {
  assert.throws(() => parseStatusPollingConfig({ DEVHUB_STATUS_PROBE_INTERVAL_SECONDS: "59" }), /between 60 and 86400/);
  assert.throws(() => parseStatusPollingConfig({ DEVHUB_STATUS_PROBE_INTERVAL_SECONDS: "5m" }), /must be an integer/);
  assert.throws(() => parseStatusPollingConfig({
    DEVHUB_STATUS_PROBE_INTERVAL_SECONDS: "900",
    DEVHUB_STATUS_ON_DEMAND_INTERVAL_SECONDS: "300",
  }), /greater than or equal/);
  assert.throws(() => parseStatusPollingConfig({ DEVHUB_STATUS_MAX_CONCURRENCY: "17" }), /between 1 and 16/);
  assert.throws(() => parseStatusPollingConfig({ DEVHUB_STATUS_JITTER_PERCENT: "26" }), /between 0 and 25/);
  assert.throws(() => createStatusPollingRuntime({
    config: { ...baseConfig, maxConcurrency: 0 },
    load: () => status("project/service", new Date().toISOString()),
    onLoadError: () => status("project/service", new Date().toISOString()),
  }), /config is invalid/);
});

test("only on-demand services on reviewed workstations use the slower cadence", () => {
  assert.equal(statusCadenceForService({ mode: "on-demand" }, { kind: "mac" }), "on-demand");
  assert.equal(statusCadenceForService({ mode: "on-demand" }, { kind: "windows" }), "on-demand");
  assert.equal(statusCadenceForService({ mode: "on-demand" }, { kind: "linux" }), "on-demand");
  assert.equal(statusCadenceForService({ mode: "always-on" }, { kind: "mac" }), "ordinary");
  assert.equal(statusCadenceForService({ mode: "on-demand" }, { kind: "cloud" }), "ordinary");
});

test("fresh observations are cached until expiry and expose their real age", async () => {
  let now = Date.parse("2026-08-19T00:00:00.000Z");
  let calls = 0;
  const logs = [];
  const runtime = createStatusPollingRuntime({
    config: { ...baseConfig, ordinaryIntervalMs: 1_000 },
    clock: () => now,
    load: ({ key }) => {
      calls += 1;
      return status(key, new Date(now).toISOString());
    },
    onLoadError: () => assert.fail("load should not fail"),
    logger: (summary) => logs.push(summary),
  });

  const first = await runtime.getSnapshot([entry("project/service")]);
  assert.equal(first.freshness.mode, "refresh");
  assert.equal(first.statuses[0].ageMs, 0);
  assert.equal(first.statuses[0].freshness, "fresh");
  assert.equal(first.statuses[0].refreshAfter, "2026-08-19T00:00:01.000Z");

  now += 999;
  const cached = await runtime.getSnapshot([entry("project/service")]);
  assert.equal(cached.freshness.mode, "cache");
  assert.equal(cached.freshness.cacheHits, 1);
  assert.equal(cached.statuses[0].ageMs, 999);
  assert.equal(calls, 1);

  now += 1;
  const refreshed = await runtime.getSnapshot([entry("project/service")]);
  assert.equal(refreshed.freshness.mode, "refresh");
  assert.equal(calls, 2);
  assert.equal(logs.length, 2);
});

test("concurrent callers share one in-flight refresh", async () => {
  let release;
  let calls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const runtime = createStatusPollingRuntime({
    config: baseConfig,
    clock: () => Date.parse("2026-08-19T00:00:00.000Z"),
    load: async ({ key }) => {
      calls += 1;
      await gate;
      return status(key, "2026-08-19T00:00:00.000Z");
    },
    onLoadError: () => assert.fail("load should not fail"),
  });

  const firstPromise = runtime.getSnapshot([entry("project/service")]);
  const secondPromise = runtime.getSnapshot([entry("project/service")]);
  release();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  assert.equal(calls, 1);
  assert.equal(first.freshness.refreshed, 1);
  assert.equal(second.freshness.shared, 1);
  assert.equal(second.freshness.mode, "shared");
});

test("refresh work observes the configured global concurrency bound", async () => {
  let active = 0;
  let maximumActive = 0;
  const runtime = createStatusPollingRuntime({
    config: { ...baseConfig, maxConcurrency: 2 },
    clock: () => Date.parse("2026-08-19T00:00:00.000Z"),
    load: async ({ key }) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return status(key, "2026-08-19T00:00:00.000Z");
    },
    onLoadError: () => assert.fail("load should not fail"),
  });

  const snapshot = await runtime.getSnapshot(Array.from({ length: 7 }, (_, index) => entry(`project/service-${index}`)));
  assert.equal(snapshot.statuses.length, 7);
  assert.equal(maximumActive, 2);
});

test("one unexpected loader failure becomes a bounded per-service result", async () => {
  const runtime = createStatusPollingRuntime({
    config: baseConfig,
    clock: () => Date.parse("2026-08-19T00:00:00.000Z"),
    load: ({ key }) => {
      if (key.endsWith("broken")) throw new Error("secret provider detail");
      return status(key, "2026-08-19T00:00:00.000Z");
    },
    onLoadError: ({ key }, _error, checkedAt) => status(key, checkedAt, "down"),
  });

  const snapshot = await runtime.getSnapshot([entry("project/healthy"), entry("project/broken")]);
  assert.deepEqual(snapshot.statuses.map(({ key, state }) => ({ key, state })), [
    { key: "project/healthy", state: "up" },
    { key: "project/broken", state: "down" },
  ]);
  assert.equal(JSON.stringify(snapshot).includes("secret provider detail"), false);
});

test("positive deterministic jitter never probes sooner than the base interval", async () => {
  const now = Date.parse("2026-08-19T00:00:00.000Z");
  const runtime = createStatusPollingRuntime({
    config: { ...baseConfig, ordinaryIntervalMs: 1_000, jitterPercent: 25 },
    clock: () => now,
    load: ({ key }) => status(key, new Date(now).toISOString()),
    onLoadError: () => assert.fail("load should not fail"),
  });
  const snapshot = await runtime.getSnapshot([entry("project/one"), entry("project/two")]);
  for (const item of snapshot.statuses) {
    const interval = Date.parse(item.refreshAfter) - now;
    assert.ok(interval >= 1_000 && interval <= 1_250);
  }
});
