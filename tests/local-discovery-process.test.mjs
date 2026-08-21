import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { runIsolatedLocalDiscovery } from "../scripts/local-discovery-process.mjs";

const execFileAsync = promisify(execFile);
const supported = process.platform === "darwin" || process.platform === "linux";
const host = process.platform === "darwin" ? { id: "example-host", kind: "mac" } : { id: "example-host", kind: "linux" };

async function waitForFile(filename, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = Number((await readFile(filename, "utf8")).trim());
      if (Number.isInteger(value) && value > 0) return value;
    } catch {
      // The hostile child has not published its descendant yet.
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

test("isolated local discovery returns one bounded redacted document", { skip: !supported }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-isolated-local-"));
  const selected = path.join(temporary, "selected");
  try {
    await mkdir(selected);
    await writeFile(path.join(selected, "package.json"), `${JSON.stringify({ name: "isolated-paper", scripts: { start: "node index.js" } })}\n`);
    const result = await runIsolatedLocalDiscovery(host, [selected], { now: "2026-08-20T08:00:00.000Z", timeoutMs: 2_000 });
    assert.equal(result.state, "completed");
    assert.equal(result.document.status, "complete");
    assert.equal(result.document.candidates[0].name, "isolated-paper");
    assert.doesNotMatch(JSON.stringify(result), new RegExp(temporary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("unknown roots are rejected before an inspection result", { skip: !supported }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-isolated-local-invalid-"));
  try {
    await assert.rejects(
      runIsolatedLocalDiscovery(host, [path.join(temporary, "missing")], { now: "2026-08-20T08:00:00.000Z" }),
      (error) => error.code === "unknown-local-root",
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("deadline cleanup kills and reaps hostile local discovery descendants", { skip: !supported || process.platform === "win32" }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-isolated-local-deadline-"));
  const selected = path.join(temporary, "selected");
  await mkdir(selected);
  try {
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const fifo = path.join(temporary, `blocked-${iteration}.fifo`);
      const pidFile = path.join(temporary, `descendant-${iteration}.pid`);
      const childPath = path.join(temporary, `hostile-${iteration}.mjs`);
      await execFileAsync("mkfifo", [fifo]);
      await writeFile(childPath, `
        import { spawn } from "node:child_process";
        import { readFile, writeFile } from "node:fs/promises";
        process.on("SIGTERM", () => {});
        const child = spawn(process.execPath, ["--input-type=module", "--eval", "process.on('SIGTERM',()=>{});setInterval(()=>{},10000)"], { stdio: "ignore" });
        await writeFile(${JSON.stringify(pidFile)}, String(child.pid));
        await readFile(${JSON.stringify(fifo)});
      `);
      const deadlineMs = 5_000;
      const operation = runIsolatedLocalDiscovery(host, [selected], {
        childPath,
        now: "2026-08-20T08:00:00.000Z",
        limits: { deadlineMs },
      });
      const descendant = await waitForFile(pidFile, deadlineMs - 500);
      const result = await operation;
      assert.equal(result.state, "timed-out");
      assert.equal(result.document.status, "unknown");
      assert.equal(result.document.reason, "local-discovery-deadline");
      await waitForExit(descendant);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("invalid and oversized child output becomes unknown and exposes no child text", { skip: !supported }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-isolated-local-output-"));
  const selected = path.join(temporary, "selected");
  await mkdir(selected);
  try {
    for (const [name, source] of [
      ["invalid", "process.stdin.resume();process.stdout.write('{}\\n');"],
      ["oversized", "process.stdin.resume();process.stdout.write('PRIVATE'.repeat(400000));"],
    ]) {
      const childPath = path.join(temporary, `${name}.mjs`);
      await writeFile(childPath, source);
      const result = await runIsolatedLocalDiscovery(host, [selected], { childPath, now: "2026-08-20T08:00:00.000Z" });
      assert.equal(result.state, "unavailable");
      assert.equal(result.document.status, "unknown");
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
