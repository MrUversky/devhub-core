import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { parse } from "yaml";
import { validateHostsDocument } from "../scripts/catalog-validation.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "scripts/devhub.mjs");

async function run(args) {
  try {
    const result = await execFileAsync(process.execPath, [cli, ...args], { cwd: root });
    return { ...result, exitCode: 0 };
  } catch (error) {
    return { stdout: error.stdout, stderr: error.stderr, exitCode: error.code };
  }
}

const hostArguments = [
  "--host-id", "developer-laptop",
  "--host-name", "Developer laptop",
  "--host-kind", "mac",
  "--host-location", "local",
];

test("init-catalog dry-run reports exact output without creating the destination", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "devhub-init-plan-"));
  const destination = path.join(temporaryRoot, "catalog");
  try {
    const result = await run(["init-catalog", destination, ...hostArguments, "--json"]);
    assert.equal(result.exitCode, 0);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.readOnly, true);
    assert.equal(plan.status, "planned");
    assert.equal(plan.destinationState, "absent");
    assert.equal(plan.applyEligible, true);
    assert.deepEqual(plan.files, [
      { type: "file", path: path.join(destination, "hosts.yaml") },
      { type: "directory", path: path.join(destination, "projects") },
    ]);
    await assert.rejects(readFile(path.join(destination, "hosts.yaml"), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("init-catalog --apply creates and immediately validates a deterministic starter catalog", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "devhub-init-apply-"));
  const destination = path.join(temporaryRoot, "catalog");
  try {
    const result = await run(["init-catalog", destination, ...hostArguments, "--apply", "--json"]);
    assert.equal(result.exitCode, 0);
    const applied = JSON.parse(result.stdout);
    assert.deepEqual(applied.validation, { status: "passed", hosts: 1, projects: 0 });
    const hostsText = await readFile(path.join(destination, "hosts.yaml"), "utf8");
    assert.equal(hostsText, `version: 1\nhosts:\n  - id: developer-laptop\n    name: Developer laptop\n    kind: mac\n    location: local\n`);
    validateHostsDocument(parse(hostsText), path.join(destination, "hosts.yaml"));
    assert.deepEqual(await readdir(path.join(destination, "projects")), []);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("init-catalog --apply accepts an existing empty directory", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "devhub-init-empty-"));
  const destination = path.join(temporaryRoot, "catalog");
  try {
    await mkdir(destination);
    const result = await run(["init-catalog", destination, ...hostArguments, "--apply", "--json"]);
    assert.equal(result.exitCode, 0);
    assert.equal(JSON.parse(result.stdout).destinationState, "empty");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("init-catalog accepts Windows workstations as first-class hosts", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "devhub-init-windows-"));
  const destination = path.join(temporaryRoot, "catalog");
  try {
    const result = await run([
      "init-catalog", destination,
      "--host-id", "windows-workstation",
      "--host-name", "Windows workstation",
      "--host-kind", "windows",
      "--host-location", "local",
      "--apply", "--json",
    ]);
    assert.equal(result.exitCode, 0);
    assert.match(await readFile(path.join(destination, "hosts.yaml"), "utf8"), /kind: windows/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("init-catalog never overwrites a non-empty destination", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "devhub-init-preserve-"));
  const destination = path.join(temporaryRoot, "catalog");
  const sentinel = path.join(destination, "keep.txt");
  try {
    await mkdir(destination);
    await writeFile(sentinel, "keep me\n");
    for (const apply of [false, true]) {
      const result = await run(["init-catalog", destination, ...hostArguments, ...(apply ? ["--apply"] : []), "--json"]);
      assert.equal(result.exitCode, 3);
      const failure = JSON.parse(result.stdout);
      assert.equal(failure.error.code, "destination-not-empty");
    }
    assert.equal(await readFile(sentinel, "utf8"), "keep me\n");
    assert.deepEqual(await readdir(destination), ["keep.txt"]);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("init-catalog rejects incomplete, invalid and unknown arguments without writing", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "devhub-init-invalid-"));
  const destination = path.join(temporaryRoot, "catalog");
  try {
    const incomplete = await run(["init-catalog", destination, "--host-id", "developer-laptop", "--json"]);
    assert.equal(incomplete.exitCode, 3);
    assert.equal(JSON.parse(incomplete.stdout).error.code, "required-options-missing");

    const invalid = await run([
      "init-catalog", destination,
      "--host-id", "Developer Laptop",
      "--host-name", "Developer laptop",
      "--host-kind", "mac",
      "--host-location", "local",
      "--json",
    ]);
    assert.equal(invalid.exitCode, 3);
    assert.equal(JSON.parse(invalid.stdout).error.code, "invalid-host");
    assert.match(JSON.parse(invalid.stdout).error.message, /lowercase kebab-case/);

    const unknown = await run(["init-catalog", destination, ...hostArguments, "--surprise", "--json"]);
    assert.equal(unknown.exitCode, 3);
    assert.equal(JSON.parse(unknown.stdout).error.code, "unknown-option");
    await assert.rejects(readdir(destination), { code: "ENOENT" });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
