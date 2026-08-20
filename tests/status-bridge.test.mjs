import assert from "node:assert/strict";
import test from "node:test";
import {
  SAME_ORIGIN_STATUS_API_ENDPOINT,
  isAllowedStatusCorsOrigin,
  parseStatusCorsOrigins,
  resolveStatusApiEndpoint,
  selectReviewedStatusSnapshot,
} from "../lib/status-bridge.mjs";

test("status bridge defaults to same-origin and normalizes one server-supplied HTTPS base", () => {
  assert.equal(resolveStatusApiEndpoint(), SAME_ORIGIN_STATUS_API_ENDPOINT);
  assert.equal(resolveStatusApiEndpoint("   "), SAME_ORIGIN_STATUS_API_ENDPOINT);
  assert.equal(resolveStatusApiEndpoint("https://central.example.test/"), "https://central.example.test/api/status");
  assert.throws(() => resolveStatusApiEndpoint("http://central.example.test"), /HTTPS/);
  assert.throws(() => resolveStatusApiEndpoint("https://central.example.test/private"), /origin-only/);
  assert.throws(() => resolveStatusApiEndpoint("https://user:secret@central.example.test"), /origin-only/);
});

test("status CORS accepts only normalized exact HTTPS origins", () => {
  const origins = parseStatusCorsOrigins(" https://owner.example.test,https://second.example.test/,https://owner.example.test ");
  assert.deepEqual(origins, ["https://owner.example.test", "https://second.example.test"]);
  assert.equal(isAllowedStatusCorsOrigin("https://owner.example.test", origins), true);
  assert.equal(isAllowedStatusCorsOrigin("https://attacker.example.test", origins), false);
  assert.deepEqual(parseStatusCorsOrigins(), []);
  assert.throws(() => parseStatusCorsOrigins("*"), /wildcard/);
  assert.throws(() => parseStatusCorsOrigins("https://owner.example.test,"), /empty/);
  assert.throws(() => parseStatusCorsOrigins("https://owner.example.test/path"), /origin-only/);
});

test("status bridge validates the snapshot and keeps only reviewed service keys", () => {
  const snapshot = {
    observedAt: "2026-08-20T00:00:00.000Z",
    statuses: [
      { key: "known/web", state: "up", source: "probe", reason: "live-probe", checkedAt: "2026-08-20T00:00:00.000Z", freshness: "fresh" },
      { key: "unknown/web", state: "up", source: "probe", reason: "live-probe", checkedAt: "2026-08-20T00:00:00.000Z", freshness: "fresh" },
    ],
    freshness: { mode: "cache", newestCheckedAt: "2026-08-20T00:00:00.000Z", maxAgeMs: 1000 },
  };
  assert.deepEqual(selectReviewedStatusSnapshot(snapshot, new Set(["known/web"])), {
    observedAt: snapshot.observedAt,
    statuses: [snapshot.statuses[0]],
    freshness: snapshot.freshness,
  });
  assert.equal(selectReviewedStatusSnapshot({ ...snapshot, statuses: [{ key: "known/web", state: "invented" }] }, ["known/web"]), null);
  assert.equal(selectReviewedStatusSnapshot({ ...snapshot, observedAt: "not-a-date" }, ["known/web"]), null);
  assert.equal(selectReviewedStatusSnapshot({ ...snapshot, statuses: [{ ...snapshot.statuses[0], checkedAt: "not-a-date" }] }, ["known/web"]), null);
  assert.equal(selectReviewedStatusSnapshot({ ...snapshot, freshness: { ...snapshot.freshness, newestCheckedAt: "not-a-date" } }, ["known/web"]), null);
  assert.equal(selectReviewedStatusSnapshot({ ...snapshot, freshness: { mode: "invented" } }, ["known/web"]), null);
});
