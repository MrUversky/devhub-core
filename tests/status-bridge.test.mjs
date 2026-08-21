import assert from "node:assert/strict";
import test from "node:test";
import {
  SAME_ORIGIN_STATUS_API_ENDPOINT,
  isFreshLiveStatus,
  isAllowedStatusCorsOrigin,
  parseStatusCorsOrigins,
  resolveStatusApiEndpoint,
  selectReviewedStatusSnapshot,
  statusBridgePresentation,
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
      { key: "known/web", state: "up", source: "probe", reason: "live-probe", checkedAt: "2026-08-20T00:00:00.000Z", observedAt: "2026-08-20T00:00:00.000Z", ageMs: 0, freshness: "fresh", refreshAfter: "2026-08-20T00:01:00.000Z" },
      { key: "unknown/web", state: "up", source: "probe", reason: "live-probe", checkedAt: "2026-08-20T00:00:00.000Z", observedAt: "2026-08-20T00:00:00.000Z", ageMs: 0, freshness: "fresh", refreshAfter: "2026-08-20T00:01:00.000Z" },
    ],
    freshness: { mode: "cache", newestCheckedAt: "2026-08-20T00:00:00.000Z", maxAgeMs: 0 },
  };
  assert.deepEqual(selectReviewedStatusSnapshot(snapshot, new Set(["known/web"])), {
    observedAt: snapshot.observedAt,
    statuses: [snapshot.statuses[0]],
    freshness: snapshot.freshness,
  });
  assert.equal(selectReviewedStatusSnapshot({ ...snapshot, statuses: [{ key: "known/web", state: "invented" }] }, ["known/web"]), null);
  assert.equal(selectReviewedStatusSnapshot({ ...snapshot, observedAt: "not-a-date" }, ["known/web"]), null);
  assert.equal(selectReviewedStatusSnapshot({ ...snapshot, statuses: [{ ...snapshot.statuses[0], checkedAt: "not-a-date" }] }, ["known/web"]), null);
  assert.equal(selectReviewedStatusSnapshot({ ...snapshot, statuses: [{ ...snapshot.statuses[0], freshness: undefined }] }, ["known/web"]), null);
  assert.equal(selectReviewedStatusSnapshot({ ...snapshot, freshness: { ...snapshot.freshness, newestCheckedAt: "not-a-date" } }, ["known/web"]), null);
  assert.equal(selectReviewedStatusSnapshot({ ...snapshot, freshness: { ...snapshot.freshness, maxAgeMs: -1 } }, ["known/web"]), null);
  assert.equal(selectReviewedStatusSnapshot({ ...snapshot, freshness: { mode: "invented" } }, ["known/web"]), null);
  assert.equal(selectReviewedStatusSnapshot({ ...snapshot, statuses: [snapshot.statuses[0], snapshot.statuses[0]] }, ["known/web"]), null);
});

test("status bridge rejects extra data, inconsistent evidence and dishonest freshness", () => {
  const status = {
    key: "known/web",
    state: "up",
    source: "probe",
    reason: "live-probe",
    checkedAt: "2026-08-20T00:00:00.000Z",
    observedAt: "2026-08-20T00:00:00.000Z",
    ageMs: 0,
    freshness: "fresh",
    refreshAfter: "2026-08-20T00:01:00.000Z",
  };
  const snapshot = {
    observedAt: "2026-08-20T00:00:00.000Z",
    statuses: [status],
    freshness: { mode: "cache", newestCheckedAt: status.checkedAt, maxAgeMs: 0 },
  };
  assert.equal(selectReviewedStatusSnapshot({ ...snapshot, statuses: [{ ...status, credential: "must-not-pass" }] }, [status.key]), null);
  assert.equal(selectReviewedStatusSnapshot({ ...snapshot, statuses: [{ ...status, source: "catalog", reason: "catalog-only" }] }, [status.key]), null);
  assert.equal(selectReviewedStatusSnapshot({ ...snapshot, statuses: [{ ...status, state: "protected", source: "reported", reason: "reported" }] }, [status.key]), null);

  const future = { ...status, checkedAt: "2026-08-20T00:00:01.000Z", observedAt: "2026-08-20T00:00:01.000Z", refreshAfter: "2026-08-20T00:01:01.000Z" };
  assert.equal(selectReviewedStatusSnapshot({
    ...snapshot,
    statuses: [future],
    freshness: { ...snapshot.freshness, newestCheckedAt: future.checkedAt },
  }, [status.key]), null);

  const expired = { ...status, ageMs: 10_000, refreshAfter: "2026-08-20T00:00:05.000Z" };
  assert.equal(selectReviewedStatusSnapshot({
    ...snapshot,
    observedAt: "2026-08-20T00:00:10.000Z",
    statuses: [expired],
    freshness: { ...snapshot.freshness, maxAgeMs: 10_000 },
  }, [status.key]), null);
});

test("unknown and stale evidence never presents as LIVE", () => {
  const fresh = { source: "probe", reason: "live-probe", state: "up", freshness: "fresh" };
  const stale = { source: "probe", reason: "live-probe", state: "up", freshness: "stale" };
  const missingFreshness = { source: "probe", reason: "live-probe", state: "up" };
  const unknown = { source: "catalog", state: "unknown" };
  const inconsistent = { source: "catalog", reason: "catalog-only", state: "up", freshness: "fresh" };
  assert.equal(isFreshLiveStatus(fresh), true);
  assert.equal(isFreshLiveStatus(stale), false);
  assert.equal(isFreshLiveStatus(missingFreshness), false);
  assert.equal(isFreshLiveStatus(unknown), false);
  assert.equal(isFreshLiveStatus(inconsistent), false);
  assert.deepEqual(statusBridgePresentation(stale), { state: "stale", label: "STALE" });
  assert.deepEqual(statusBridgePresentation(missingFreshness), { state: "unknown", label: "NOT CHECKED" });
  assert.deepEqual(statusBridgePresentation(unknown), { state: "unknown", label: "NOT CHECKED" });
  assert.deepEqual(statusBridgePresentation(inconsistent), { state: "unknown", label: "NOT CHECKED" });
  assert.notEqual(statusBridgePresentation(stale).label, "LIVE");
  assert.notEqual(statusBridgePresentation(unknown).label, "LIVE");
});
