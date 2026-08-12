import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectHost } from "../scripts/host-inspection.mjs";

const hosts = `version: 1
hosts:
  - id: example-host
    name: Example host
    kind: linux
    location: local
`;

function manifest(workspace) {
  return `version: 1
id: example-project
title: Example project
registration: overlay
description: Generic host inspection fixture.
lifecycle: active
kind: product
workspaces:
  - host: example-host
    path: ${JSON.stringify(workspace)}
services:
  - id: gateway
    name: Gateway
    kind: gateway
    environment: local
    host: example-host
    runtime: systemd
    mode: always-on
    visibility: local
    commands:
      restart: sudo systemctl restart example-gateway.service
      logs: journalctl -u example-gateway.service --since "1 hour ago"
  - id: desktop-agent
    name: Desktop agent
    kind: worker
    environment: local
    host: example-host
    runtime: launchd
    mode: on-demand
    visibility: internal
    commands:
      restart: launchctl kickstart -k gui/$(id -u)/com.example.desktop-agent
  - id: api
    name: Compose API
    kind: api
    environment: local
    host: example-host
    runtime: docker-compose
    mode: on-demand
    visibility: local
  - id: dashboard
    name: Node dashboard
    kind: admin
    environment: local
    host: example-host
    runtime: node
    mode: on-demand
    visibility: local
    commands:
      start: npm run dev
  - id: managed
    name: Managed service
    kind: api
    environment: production
    host: example-host
    runtime: example-cloud
    mode: managed
    visibility: authenticated
`;
}

async function fixture() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-host-inspection-"));
  const root = path.join(temporary, "registry");
  const workspace = path.join(temporary, "workspace");
  await Promise.all([
    mkdir(path.join(root, "catalog/projects"), { recursive: true }),
    mkdir(workspace, { recursive: true }),
  ]);
  await writeFile(path.join(root, "catalog/hosts.yaml"), hosts);
  await writeFile(path.join(root, "catalog/projects/example-project.yaml"), manifest(workspace));
  await writeFile(path.join(workspace, "compose.yaml"), "services:\n  api:\n    image: example/api\n");
  await writeFile(path.join(workspace, "package.json"), `${JSON.stringify({ scripts: { dev: "node server.js" } }, null, 2)}\n`);
  return { temporary, root, workspace };
}

async function exists(filename) {
  try { await access(filename); return true; } catch { return false; }
}

test("inspect-host matches only reviewed identifiers through read-only adapters", async () => {
  const data = await fixture();
  const calls = [];
  try {
    const result = await inspectHost(data.root, "example-host", {
      now: new Date("2026-08-13T00:00:00.000Z"),
      uid: 501,
      homeDirectory: path.join(data.temporary, "home"),
      fileExists: async (filename) => filename.endsWith("com.example.desktop-agent.plist") || exists(filename),
      runner: async (command, args, options) => {
        calls.push({ command, args, cwd: options?.cwd ?? null });
        if (command === "systemctl") {
          return { ok: true, unavailable: false, stdout: "LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\n" };
        }
        if (command === "launchctl") return { ok: true, unavailable: false, stdout: "state = running\npid = 123\nsecret = should-not-escape\n" };
        if (command === "docker" && args.includes("config")) return { ok: true, unavailable: false, stdout: "api\nunreviewed-db\n" };
        if (command === "docker" && args.includes("ps")) {
          return { ok: true, unavailable: false, stdout: `${JSON.stringify([
            { Service: "api", State: "running", Labels: "private=should-not-escape" },
            { Service: "unreviewed-db", State: "running", Name: "private-db" },
          ])}\n` };
        }
        throw new Error(`Unexpected inspection command: ${command} ${args.join(" ")}`);
      },
    });

    assert.equal(result.readOnly, true);
    assert.equal(result.observedAt, "2026-08-13T00:00:00.000Z");
    assert.deepEqual(result.serviceMatches.map((item) => [item.serviceId, item.source, item.state]), [
      ["api", "docker-compose", "running"],
      ["dashboard", "package-json", "unknown"],
      ["desktop-agent", "launchd", "running"],
      ["gateway", "systemd", "running"],
    ]);
    assert.deepEqual(result.unknowns.map((item) => [item.serviceId, item.reason]), [["managed", "unsupported-runtime"]]);
    assert.deepEqual(result.sources.map((item) => item.type), ["docker-compose", "launchd", "package-json", "systemd"]);
    assert.deepEqual(calls.map(({ command, args }) => [command, args[0]]), [
      ["systemctl", "show"],
      ["launchctl", "print"],
      ["docker", "compose"],
      ["docker", "compose"],
    ]);
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /should-not-escape|unreviewed-db|private-db/);
  } finally {
    await rm(data.temporary, { recursive: true, force: true });
  }
});

test("inspect-host stays unknown when reviewed runtime identity is absent or source is unavailable", async () => {
  const data = await fixture();
  try {
    const manifestPath = path.join(data.root, "catalog/projects/example-project.yaml");
    const withoutUnits = manifest(data.workspace)
      .replace("    commands:\n      restart: sudo systemctl restart example-gateway.service\n      logs: journalctl -u example-gateway.service --since \"1 hour ago\"\n", "")
      .replace("    commands:\n      restart: launchctl kickstart -k gui/$(id -u)/com.example.desktop-agent\n", "");
    await writeFile(manifestPath, withoutUnits);
    const calls = [];
    const result = await inspectHost(data.root, "example-host", {
      runner: async (command) => {
        calls.push(command);
        return { ok: false, unavailable: true, stdout: "" };
      },
    });
    assert.ok(result.unknowns.some((item) => item.serviceId === "gateway" && item.reason === "no-reviewed-unit"));
    assert.ok(result.unknowns.some((item) => item.serviceId === "desktop-agent" && item.reason === "no-reviewed-label"));
    assert.ok(!calls.includes("systemctl"));
    assert.ok(!calls.includes("launchctl"));
    assert.ok(result.serviceMatches.some((item) => item.serviceId === "dashboard" && item.source === "package-json"));
  } finally {
    await rm(data.temporary, { recursive: true, force: true });
  }
});
