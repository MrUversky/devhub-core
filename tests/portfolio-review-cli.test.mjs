import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "scripts/devhub.mjs");

test("review-portfolio returns a machine-readable non-mutating queue", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-portfolio-review-"));
  const catalogDirectory = path.join(temporary, "catalog");
  await mkdir(path.join(catalogDirectory, "projects"), { recursive: true });
  await writeFile(path.join(catalogDirectory, "hosts.yaml"), `version: 1
hosts:
  - id: example-host
    name: Example host
    kind: linux
    location: local
`);
  await writeFile(path.join(catalogDirectory, "projects/example-project.yaml"), `version: 1
id: example-project
title: Example project
registration: overlay
description: Generic portfolio review fixture.
lifecycle: active
kind: product
services:
  - id: worker
    name: Worker
    kind: worker
    environment: production
    host: example-host
    runtime: systemd
    mode: always-on
    visibility: internal
`);

  try {
    const before = await readdir(path.join(catalogDirectory, "projects"));
    const { stdout, stderr } = await execFileAsync(process.execPath, [cli, "review-portfolio", "--json"], {
      cwd: root,
      env: { ...process.env, DEVHUB_CATALOG_DIR: catalogDirectory },
    });
    const result = JSON.parse(stdout);
    assert.equal(stderr, "");
    assert.equal(result.command, "review-portfolio");
    assert.equal(result.readOnly, true);
    assert.equal(result.summary.projects, 1);
    assert.ok(result.findings.some((item) => item.check === "readiness-profile"));
    assert.deepEqual(await readdir(path.join(catalogDirectory, "projects")), before);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
