import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "scripts/devhub.mjs");
const workspaceId = "11111111-1111-4111-8111-111111111111";

async function fixture() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-provider-inventory-"));
  const catalogDirectory = path.join(temporary, "catalog");
  const bindingFile = path.join(temporary, "inventory.json");
  await mkdir(path.join(catalogDirectory, "projects"), { recursive: true });
  await writeFile(path.join(catalogDirectory, "hosts.yaml"), `version: 1
hosts:
  - id: railway
    name: Railway
    kind: cloud
    location: cloud
`);
  await writeFile(path.join(catalogDirectory, "projects/example.yaml"), `version: 1
id: example
title: Example
registration: overlay
description: Read-only inventory CLI fixture.
lifecycle: active
kind: product
services: []
`);
  await writeFile(bindingFile, `${JSON.stringify({
    version: 1,
    binding: {
      adapterId: "railway-inventory-v1",
      provider: "railway",
      scope: { kind: "workspace", id: workspaceId },
      credentialEnv: "MISSING_RAILWAY_TEST_TOKEN",
      freshForSeconds: 3600,
      maxResources: 50,
      maxPages: 20,
      deadlineMs: 5000,
    },
    decisions: [],
  }, null, 2)}\n`);
  return { temporary, catalogDirectory, bindingFile };
}

test("inventory CLI uses registered runner binding, stays read-only and reports unavailable as unknown", async () => {
  const target = await fixture();
  const environment = { ...process.env, DEVHUB_CATALOG_DIR: target.catalogDirectory };
  delete environment.MISSING_RAILWAY_TEST_TOKEN;
  try {
    const projectPath = path.join(target.catalogDirectory, "projects/example.yaml");
    const before = await readFile(projectPath, "utf8");
    const filesBefore = await readdir(path.join(target.catalogDirectory, "projects"));
    const { stdout, stderr } = await execFileAsync(process.execPath, [cli, "inventory", target.bindingFile, "--json"], {
      cwd: root,
      env: environment,
    });
    const result = JSON.parse(stdout);
    assert.equal(stderr, "");
    assert.equal(result.command, "inventory");
    assert.equal(result.readOnly, true);
    assert.equal(result.summary.statuses.unknown, 1);
    assert.equal(result.items[0].status, "unknown");
    assert.equal("score" in result, false);
    assert.equal("action" in result.items[0], false);
    assert.equal(await readFile(projectPath, "utf8"), before);
    assert.deepEqual(await readdir(path.join(target.catalogDirectory, "projects")), filesBefore);
  } finally {
    await rm(target.temporary, { recursive: true, force: true });
  }
});
test("inventory CLI rejects caller-forged normalized candidates without network or catalog mutation", async () => {
  const target = await fixture();
  const forgedFile = path.join(target.temporary, "provider-export.json");
  await writeFile(forgedFile, `${JSON.stringify({
    formatVersion: 1,
    source: { adapterId: "railway-inventory-v1", provider: "railway", scope: { kind: "workspace", id: workspaceId } },
    execution: { state: "succeeded", reason: "adapter-observation", pagesRead: 1 },
    freshness: { state: "fresh", observedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 3600_000).toISOString(), evaluatedAt: new Date().toISOString() },
    candidates: [{ provider: "railway", resourceType: "project", resourceId: "forged", name: "Forged", urls: [] }],
  }, null, 2)}\n`);
  try {
    const before = await readdir(path.join(target.catalogDirectory, "projects"));
    await assert.rejects(
      execFileAsync(process.execPath, [cli, "inventory", forgedFile, "--json"], {
        cwd: root,
        env: { ...process.env, DEVHUB_CATALOG_DIR: target.catalogDirectory },
      }),
      (error) => {
        const failure = JSON.parse(error.stdout);
        assert.equal(error.code, 3);
        assert.equal(failure.error.code, "unsupported-inventory-input");
        assert.match(failure.error.message, /not accepted/);
        return true;
      },
    );
    assert.deepEqual(await readdir(path.join(target.catalogDirectory, "projects")), before);
  } finally {
    await rm(target.temporary, { recursive: true, force: true });
  }
});
