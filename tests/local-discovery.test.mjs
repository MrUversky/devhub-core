import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  discoverLocalCandidates,
  localWorkspaceId,
  validateLocalDiscoveryDocument,
} from "../lib/local-discovery.mjs";

const observedAt = "2026-08-20T08:00:00.000Z";
const execFileAsync = promisify(execFile);

async function projectFixture() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-local-discovery-"));
  const root = path.join(temporary, "selected");
  const project = path.join(root, "apps/paper-crane");
  const outside = path.join(temporary, "unselected");
  await Promise.all([
    mkdir(path.join(project, ".git"), { recursive: true }),
    mkdir(path.join(project, ".devhub"), { recursive: true }),
    mkdir(outside, { recursive: true }),
  ]);
  await writeFile(path.join(project, "package.json"), `${JSON.stringify({
    name: "paper-crane",
    scripts: { start: "node server.js", leak: "node fixture.js PRIVATE_METADATA_DO_NOT_RETURN" },
    config: { note: "PRIVATE_METADATA_DO_NOT_RETURN" },
  })}\n`);
  await writeFile(path.join(project, ".git/config"), '[remote "origin"]\n  url = https://github.com/example/paper-crane.git\n');
  await writeFile(path.join(project, ".devhub/project.yaml"), `version: 1
id: paper-crane
title: Paper Crane
registration: native
description: Fictional local discovery fixture.
lifecycle: discovery
kind: product
repository: example/paper-crane
services:
  - id: api
    name: Paper Crane API
    kind: api
    environment: local
    host: example-host
    runtime: node
    mode: always-on
    visibility: public
    commands:
      start: node api.js PRIVATE_METADATA_DO_NOT_RETURN
`);
  await writeFile(path.join(project, "compose.yaml"), `services:
  web:
    image: example/web
    environment:
      FIXTURE_VALUE: PRIVATE_METADATA_DO_NOT_RETURN
  worker:
    command: node worker.js PRIVATE_METADATA_DO_NOT_RETURN
`);
  await writeFile(path.join(outside, "package.json"), `${JSON.stringify({ name: "must-not-be-read", scripts: { start: "node x" } })}\n`);
  await symlink(outside, path.join(root, "outside-link"));
  return { temporary, root, project, outside };
}

test("bounded local discovery emits deterministic redacted project and service candidates", async () => {
  const fixture = await projectFixture();
  try {
    const options = {
      host: { id: "example-host", kind: "linux" },
      roots: [fixture.root],
      observedAt,
      platform: "linux",
      homeDirectory: path.join(fixture.temporary, "home"),
    };
    const first = await discoverLocalCandidates(options);
    const second = await discoverLocalCandidates(options);
    assert.deepEqual(first, second);
    assert.equal(first.status, "complete");
    assert.equal(first.readOnly, true);
    assert.equal(first.catalogWrites, false);
    assert.equal(first.repositoryWrites, false);
    assert.equal(first.limits.symlinksSkipped, 1);
    assert.equal(first.candidates[0].resourceType, "project");
    assert.equal(first.candidates[0].resourceId, localWorkspaceId("example-host", fixture.project));
    assert.deepEqual(first.candidates[0].repository, { provider: "github", owner: "example", name: "paper-crane" });
    assert.deepEqual(first.candidates[0].evidence.packageScripts, ["leak", "start"]);
    assert.deepEqual(first.candidates[0].evidence.composeServices, ["web", "worker"]);
    assert.ok(first.candidates.some((candidate) => candidate.declaredServiceId === "api"));
    assert.ok(first.candidates.some((candidate) => candidate.runtime === "docker-compose" && candidate.name === "worker"));
    const serialized = JSON.stringify(first);
    assert.doesNotMatch(serialized, /PRIVATE_METADATA_DO_NOT_RETURN|must-not-be-read/);
    assert.doesNotMatch(serialized, new RegExp(fixture.temporary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(serialized, /"mode"|"visibility"|"accountableOwner"|"state"\s*:\s*"running"/);
    validateLocalDiscoveryDocument(first, { expectedHost: options.host, now: observedAt });
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("unknown, duplicate and overlapping roots fail during preflight", async () => {
  const fixture = await projectFixture();
  try {
    await assert.rejects(
      discoverLocalCandidates({ host: { id: "example-host", kind: "linux" }, roots: [fixture.root, path.join(fixture.temporary, "missing")], observedAt, platform: "linux" }),
      (error) => error.code === "unknown-local-root",
    );
    await assert.rejects(
      discoverLocalCandidates({ host: { id: "example-host", kind: "linux" }, roots: [fixture.root, fixture.root], observedAt, platform: "linux" }),
      (error) => error.code === "duplicate-local-root",
    );
    await assert.rejects(
      discoverLocalCandidates({ host: { id: "example-host", kind: "linux" }, roots: [fixture.root, path.join(fixture.root, "apps")], observedAt, platform: "linux" }),
      (error) => error.code === "duplicate-local-root",
    );
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("entry, byte, depth and platform boundaries fail closed", async () => {
  const fixture = await projectFixture();
  try {
    await assert.rejects(
      discoverLocalCandidates({ host: { id: "example-host", kind: "linux" }, roots: [fixture.root], observedAt, platform: "linux", limits: { maxEntries: 1 } }),
      (error) => error.code === "local-discovery-entry-limit",
    );
    await assert.rejects(
      discoverLocalCandidates({ host: { id: "example-host", kind: "linux" }, roots: [fixture.root], observedAt, platform: "linux", limits: { maxBytes: 16 } }),
      (error) => error.code === "local-discovery-byte-limit",
    );
    const shallow = await discoverLocalCandidates({
      host: { id: "example-host", kind: "linux" }, roots: [fixture.root], observedAt, platform: "linux", limits: { maxDepth: 0 },
    });
    assert.equal(shallow.limits.depthLimited, true);
    assert.deepEqual(shallow.candidates, []);
    await assert.rejects(
      discoverLocalCandidates({ host: { id: "example-host", kind: "linux" }, roots: [fixture.root], observedAt, platform: "win32" }),
      (error) => error.code === "unsupported-local-discovery-platform",
    );
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("special files and symlinked evidence are never opened", { skip: process.platform === "win32" }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-local-special-files-"));
  const selected = path.join(temporary, "selected");
  const outside = path.join(temporary, "outside-compose.yaml");
  try {
    await mkdir(selected);
    await execFileAsync("mkfifo", [path.join(selected, "package.json")]);
    await writeFile(outside, "services:\n  private-fixture:\n    image: example/private\n");
    await symlink(outside, path.join(selected, "compose.yaml"));
    const started = Date.now();
    const result = await discoverLocalCandidates({
      host: { id: "example-host", kind: "linux" },
      roots: [selected],
      observedAt,
      platform: "linux",
      limits: { deadlineMs: 500 },
    });
    assert.deepEqual(result.candidates, []);
    assert.equal(result.limits.symlinksSkipped, 1);
    assert.ok(Date.now() - started < 500, "special-file inspection must not block on the FIFO");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("path components never become candidate display metadata", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-local-path-redaction-"));
  const selected = path.join(temporary, "PRIVATE_PATH_COMPONENT");
  try {
    await mkdir(selected);
    await writeFile(path.join(selected, "compose.yaml"), "services:\n  web:\n    image: example/web\n");
    const result = await discoverLocalCandidates({
      host: { id: "example-host", kind: "linux" }, roots: [selected], observedAt, platform: "linux",
    });
    assert.equal(result.candidates.find((candidate) => candidate.resourceType === "project")?.name, "Local project");
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PATH_COMPONENT/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("only reviewed macOS and Linux service manifest locations and shapes produce candidates", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-local-os-services-"));
  try {
    const linuxHome = path.join(temporary, "linux-home");
    const systemd = path.join(linuxHome, ".config/systemd/user");
    await mkdir(systemd, { recursive: true });
    await writeFile(path.join(systemd, "paper.service"), "[Unit]\nDescription=Paper\n[Service]\nExecStart=/usr/bin/paper PRIVATE_METADATA_DO_NOT_RETURN\n");
    await writeFile(path.join(systemd, "invalid.service"), "[Unit]\nDescription=No service shape\n");
    const linux = await discoverLocalCandidates({
      host: { id: "linux-host", kind: "linux" }, roots: [systemd], observedAt, platform: "linux", homeDirectory: linuxHome,
    });
    assert.deepEqual(linux.candidates.map((candidate) => [candidate.name, candidate.runtime]), [["paper.service", "systemd"]]);

    const macHome = path.join(temporary, "mac-home");
    const launchd = path.join(macHome, "Library/LaunchAgents");
    await mkdir(launchd, { recursive: true });
    await writeFile(path.join(launchd, "com.example.paper.plist"), `<?xml version="1.0"?>
<plist version="1.0"><dict>
<key>Label</key><string>com.example.paper</string>
<key>ProgramArguments</key><array><string>/usr/bin/paper</string><string>PRIVATE_METADATA_DO_NOT_RETURN</string></array>
</dict></plist>`);
    const mac = await discoverLocalCandidates({
      host: { id: "mac-host", kind: "mac" }, roots: [launchd], observedAt, platform: "darwin", homeDirectory: macHome,
    });
    assert.deepEqual(mac.candidates.map((candidate) => [candidate.name, candidate.runtime]), [["com.example.paper", "launchd"]]);
    assert.doesNotMatch(JSON.stringify([linux, mac]), /PRIVATE_METADATA_DO_NOT_RETURN|ExecStart|ProgramArguments/);

    const arbitrary = path.join(temporary, "arbitrary");
    await mkdir(arbitrary);
    await writeFile(path.join(arbitrary, "paper.service"), "[Service]\nExecStart=/usr/bin/paper\n");
    const ignored = await discoverLocalCandidates({
      host: { id: "linux-host", kind: "linux" }, roots: [arbitrary], observedAt, platform: "linux", homeDirectory: linuxHome,
    });
    assert.deepEqual(ignored.candidates, []);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("the normalized document rejects path fields and secret-bearing metadata", async () => {
  const fixture = await projectFixture();
  try {
    const result = await discoverLocalCandidates({ host: { id: "example-host", kind: "linux" }, roots: [fixture.root], observedAt, platform: "linux" });
    const forgedPath = structuredClone(result);
    forgedPath.candidates[0].path = fixture.project;
    assert.throws(() => validateLocalDiscoveryDocument(forgedPath, { now: observedAt }), /unsupported fields/);
    const forgedSecret = structuredClone(result);
    forgedSecret.candidates[0].name = "token=abcdefghijk";
    assert.throws(() => validateLocalDiscoveryDocument(forgedSecret, { now: observedAt }), /safe non-empty string/);
    const forgedPathValue = structuredClone(result);
    forgedPathValue.candidates[0].name = "/private/selected/project";
    assert.throws(() => validateLocalDiscoveryDocument(forgedPathValue, { now: observedAt }), /safe non-empty string/);
    assert.equal(await readFile(path.join(fixture.outside, "package.json"), "utf8").then((value) => value.includes("must-not-be-read")), true);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});
