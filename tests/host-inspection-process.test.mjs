import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { runIsolatedHostInspection } from "../scripts/host-inspection-process.mjs";
import { createLocalHostSetupConnector, runConnectedSetupSession } from "../scripts/setup-session.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "scripts/devhub.mjs");

async function fixture() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-isolated-host-"));
  const catalogDirectory = path.join(temporary, "catalog");
  const workspace = path.join(temporary, "workspace");
  await Promise.all([
    mkdir(path.join(catalogDirectory, "projects"), { recursive: true }),
    mkdir(workspace, { recursive: true }),
  ]);
  await writeFile(path.join(catalogDirectory, "hosts.yaml"), `version: 1
hosts:
  - id: example-host
    name: Example host
    kind: mac
    location: local
`);
  await writeFile(path.join(catalogDirectory, "projects/example.yaml"), `version: 1
id: example
title: Example
registration: overlay
description: Fictional isolated host fixture.
lifecycle: active
kind: product
workspaces:
  - host: example-host
    path: ${JSON.stringify(workspace)}
services:
  - id: web
    name: Web
    kind: web
    environment: local
    host: example-host
    runtime: node
    mode: on-demand
    visibility: local
    commands:
      start: npm run dev
`);
  await writeFile(path.join(workspace, "package.json"), `${JSON.stringify({ scripts: { dev: "node server.js" } })}\n`);
  const paths = {
    root,
    catalogDirectory,
    hostsPath: path.join(catalogDirectory, "hosts.yaml"),
    projectDirectory: path.join(catalogDirectory, "projects"),
  };
  return { temporary, catalogDirectory, workspace, paths };
}

async function waitForFile(filename) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const value = Number((await readFile(filename, "utf8")).trim());
      if (Number.isInteger(value) && value > 0) return value;
    } catch {
      // The hostile child has not published its grandchild PID yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${filename}`);
}

async function waitForExit(pid) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { process.kill(pid, 0); } catch (error) { if (error?.code === "ESRCH") return; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`process ${pid} was not reaped`);
}

test("default isolated inspection reads a reviewed package and exits naturally", async () => {
  const data = await fixture();
  try {
    const result = await runIsolatedHostInspection(root, "example-host", {
      paths: data.paths,
      now: new Date("2026-08-14T00:00:00.000Z"),
      homeDirectory: path.join(data.temporary, "home"),
      uid: 501,
      identitySource: "explicit-argument",
      timeoutMs: 2_000,
    });
    assert.equal(result.state, "completed");
    assert.deepEqual(result.inspection.serviceMatches.map((item) => [item.serviceId, item.source]), [["web", "package-json"]]);
  } finally {
    await rm(data.temporary, { recursive: true, force: true });
  }
});

test("isolated host inspection kills and reaps a FIFO-blocked process group after abort, three times", async () => {
  if (process.platform === "win32") return;
  const data = await fixture();
  try {
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const fifo = path.join(data.temporary, `blocked-${iteration}.fifo`);
      const pidFile = path.join(data.temporary, `grandchild-${iteration}.pid`);
      const childPath = path.join(data.temporary, `hostile-${iteration}.mjs`);
      await execFileAsync("mkfifo", [fifo]);
      await writeFile(childPath, `
        import { spawn } from "node:child_process";
        import { readFile, writeFile } from "node:fs/promises";
        process.on("SIGTERM", () => {});
        const grandchild = spawn(process.execPath, ["--input-type=module", "--eval", "process.on('SIGTERM',()=>{});setInterval(()=>{},10000)"], { stdio: "ignore" });
        await writeFile(${JSON.stringify(pidFile)}, String(grandchild.pid));
        await readFile(${JSON.stringify(fifo)});
      `);
      const controller = new AbortController();
      const operation = runIsolatedHostInspection(root, "example-host", {
        paths: data.paths,
        childPath,
        signal: controller.signal,
        timeoutMs: 2_000,
      });
      const grandchildPid = await waitForFile(pidFile);
      controller.abort();
      const result = await operation;
      assert.equal(result.state, "aborted");
      await waitForExit(grandchildPid);
    }
  } finally {
    await rm(data.temporary, { recursive: true, force: true });
  }
});

test("isolated host inspection distinguishes timeout and waits for setup connector cleanup", async () => {
  const data = await fixture();
  const childPath = path.join(data.temporary, "hostile-timeout.mjs");
  await writeFile(childPath, "process.on('SIGTERM',()=>{});process.stdin.resume();setInterval(()=>{},10000);\n");
  try {
    const timeout = await runIsolatedHostInspection(root, "example-host", {
      paths: data.paths,
      childPath,
      timeoutMs: 50,
    });
    assert.equal(timeout.state, "timed-out");

    const connector = createLocalHostSetupConnector({ root, paths: data.paths, childPath, timeoutMs: 2_000 });
    const controller = new AbortController();
    const sessionOperation = runConnectedSetupSession({
      version: 1,
      id: "example-local",
      connectorId: "local-host",
      authorization: { method: "local-session" },
      scope: { hostId: "example-host" },
      owner: "Example owner",
      state: "connected",
      lastObservedAt: "2026-08-14T00:00:00.000Z",
      freshForSeconds: 3600,
    }, {
      now: "2026-08-14T00:00:01.000Z",
      connectors: [connector],
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const session = await sessionOperation;
    assert.equal(session.results[0].state, "unknown");
    assert.match(session.results[0].message, /overall setup-run deadline/i);
  } finally {
    await rm(data.temporary, { recursive: true, force: true });
  }
});

test("isolated host inspection fails closed on invalid and oversized child output", async () => {
  const data = await fixture();
  try {
    for (const [name, source] of [
      ["invalid", "process.stdin.resume();process.stdout.write('{}\\n');"],
      ["oversized", "process.stdin.resume();process.stdout.write('x'.repeat(2*1024*1024));"],
    ]) {
      const childPath = path.join(data.temporary, `${name}.mjs`);
      await writeFile(childPath, source);
      const result = await runIsolatedHostInspection(root, "example-host", { paths: data.paths, childPath, timeoutMs: 2_000 });
      assert.equal(result.state, "unavailable");
      assert.equal(result.inspection, null);
    }
  } finally {
    await rm(data.temporary, { recursive: true, force: true });
  }
});

test("direct inspect-host and setup-run each emit one honest JSON result through isolated package inspection", async () => {
  const data = await fixture();
  const profilesPath = path.join(data.temporary, "connections.json");
  await writeFile(profilesPath, JSON.stringify({ version: 1, profiles: [{
    version: 1,
    id: "example-local",
    connectorId: "local-host",
    authorization: { method: "local-session" },
    scope: { hostId: "example-host" },
    owner: "Example owner",
    state: "connected",
    lastObservedAt: new Date().toISOString(),
    freshForSeconds: 3600,
  }] }));
  const environment = {
    ...process.env,
    DEVHUB_CATALOG_DIR: data.catalogDirectory,
    DEVHUB_CONNECTION_PROFILES_FILE: profilesPath,
    DEVHUB_HOST_ID: "example-host",
  };
  try {
    const direct = await execFileAsync(process.execPath, [cli, "inspect-host", "--json"], { cwd: root, env: environment, timeout: 5_000 });
    assert.equal(direct.stderr, "");
    assert.equal(JSON.parse(direct.stdout).serviceMatches[0].source, "package-json");
    assert.equal((direct.stdout.match(/"command"/g) ?? []).length, 1);

    const setupRun = await execFileAsync(process.execPath, [cli, "setup-run", "--sources", "local-host", "--deadline-ms", "3000", "--json"], {
      cwd: root,
      env: environment,
      timeout: 5_000,
    });
    assert.equal(setupRun.stderr, "");
    const review = JSON.parse(setupRun.stdout);
    assert.equal(review.command, "setup-run");
    assert.equal(review.session.results[0].connectorId, "local-host");
    assert.equal(review.session.results[0].state, "connected");
    assert.equal((setupRun.stdout.match(/"command": "setup-run"/g) ?? []).length, 1);
  } finally {
    await rm(data.temporary, { recursive: true, force: true });
  }
});
