import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const catalog = JSON.parse(await readFile(new URL("../app/generated/catalog.json", import.meta.url), "utf8"));

async function render(pathname = "/", headers = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${pathname}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: pathname === "/" ? "text/html" : "application/json", ...headers },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the operational catalog", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>DevHub — The operational home for everything you build<\/title>/i);
  assert.match(html, /favicon\.svg/i);
  assert.match(html, /Git remembers the code/);
  assert.match(html, /where it runs, how it is monitored, what safety and cost evidence exists, and how to recover it/i);
  assert.match(html, /Portfolio guardian/i);
  assert.match(html, /no magic score/i);
  assert.match(html, /Everything you build stays findable/);
  for (const project of catalog.projects.slice(0, 3)) assert.match(html, new RegExp(project.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(html, /Viewing from/);
  assert.match(html, /Device unknown · runs on/);
  assert.match(html, /One request\. DevHub handles the rest/);
  assert.match(html, /Copy for Codex/);
  assert.doesNotMatch(html, /npm --prefix/);
  assert.doesNotMatch(html, /react-loading-skeleton|Your site is taking shape/);
});

test("detects a reviewed Tailscale device without exposing identity headers", async () => {
  const reviewedHost = catalog.hosts.find((host) => host.tailscaleIPv4);
  const response = await render("/api/context", {
    "x-forwarded-for": reviewedHost?.tailscaleIPv4 ?? "203.0.113.10",
    "tailscale-user-login": "viewer@example.test",
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);

  const context = await response.json();
  assert.deepEqual(context, {
    runtimeHostId: "unknown",
    detectedHostId: reviewedHost?.id ?? null,
    source: reviewedHost ? "tailscale" : "unknown",
  });
  assert.equal(JSON.stringify(context).includes("viewer@example.test"), false);
});

test("does not present an unreviewed runtime host as the current device", async () => {
  const response = await render("/api/context");
  assert.equal(response.status, 200);

  assert.deepEqual(await response.json(), {
    runtimeHostId: "unknown",
    detectedHostId: null,
    source: "local",
  });
});

test("keeps live, reported, and undated status evidence distinct", async () => {
  const response = await render("/api/status");
  assert.equal(response.status, 200);
  const result = await response.json();

  const reported = result.statuses.find((status) => status.source === "reported");
  assert.ok(reported);
  assert.equal(reported.source, "reported");
  assert.equal(reported.reason, "reported");
  assert.match(reported.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
  const dated = result.statuses.find((status) => status.source === "reported" && status.observedAt);
  if (dated) assert.match(dated.observedAt, /^\d{4}-\d{2}-\d{2}T/);
  const undated = result.statuses.find((status) => status.source === "reported" && !status.observedAt);
  if (undated) assert.equal(Object.hasOwn(undated, "observedAt"), false);

  const probes = result.statuses.filter((status) => status.source === "probe");
  if (probes.length) {
    assert.ok(probes.every((status) => status.observedAt === status.checkedAt));
    assert.ok(probes.every((status) => ["live-probe", "probe-timeout", "probe-failed"].includes(status.reason)));
  }
});
