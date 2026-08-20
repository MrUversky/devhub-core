import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "scripts/devhub.mjs");
const supported = process.platform === "darwin" || process.platform === "linux";
const hostKind = process.platform === "darwin" ? "mac" : "linux";

async function fixture() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-local-discovery-cli-"));
  const catalogDirectory = path.join(temporary, "catalog");
  const selected = path.join(temporary, "selected");
  const known = path.join(selected, "known");
  const unknown = path.join(selected, "new-tool");
  await Promise.all([
    mkdir(path.join(catalogDirectory, "projects"), { recursive: true }),
    mkdir(known, { recursive: true }),
    mkdir(unknown, { recursive: true }),
  ]);
  await writeFile(path.join(catalogDirectory, "hosts.yaml"), `version: 1
hosts:
  - id: example-host
    name: Example host
    kind: ${hostKind}
    location: local
`);
  await writeFile(path.join(catalogDirectory, "projects/known.yaml"), `version: 1
id: known
title: Known
registration: overlay
description: Local discovery CLI fixture.
lifecycle: active
kind: product
workspaces:
  - host: example-host
    path: ${JSON.stringify(known)}
services: []
`);
  await writeFile(path.join(known, "package.json"), `${JSON.stringify({ name: "known", scripts: {} })}\n`);
  await writeFile(path.join(unknown, "package.json"), `${JSON.stringify({ name: "new-tool", scripts: { start: "node index.js PRIVATE_METADATA_DO_NOT_RETURN" } })}\n`);
  return { temporary, catalogDirectory, selected, known, unknown };
}

test("discover-local emits the existing Discovery Inbox contract and leaves all inputs unchanged", { skip: !supported }, async () => {
  const target = await fixture();
  try {
    const knownBefore = await readFile(path.join(target.catalogDirectory, "projects/known.yaml"), "utf8");
    const selectedBefore = await readdir(target.selected);
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      cli, "discover-local", "example-host", "--root", target.selected, "--json",
    ], {
      cwd: root,
      env: { ...process.env, DEVHUB_CATALOG_DIR: target.catalogDirectory, DEVHUB_HOST_ID: "example-host" },
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(stderr, "");
    const result = JSON.parse(stdout);
    assert.equal(result.command, "discovery-inbox");
    assert.equal(result.generatedFrom, "validated-local-discovery");
    assert.equal(result.readOnly, true);
    assert.equal(result.catalogWrites, false);
    assert.equal(result.items.find((item) => item.candidate?.name === "known").state, "exact-match");
    assert.equal(result.items.find((item) => item.candidate?.name === "new-tool" && item.identity.resourceType === "project").state, "new");
    assert.equal(result.summary.proposals, 0);
    assert.doesNotMatch(stdout, /PRIVATE_METADATA_DO_NOT_RETURN/);
    assert.doesNotMatch(stdout, new RegExp(target.temporary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(await readFile(path.join(target.catalogDirectory, "projects/known.yaml"), "utf8"), knownBefore);
    assert.deepEqual(await readdir(target.selected), selectedBefore);

    const candidate = result.items.find((item) => item.candidate?.name === "new-tool" && item.identity.resourceType === "project");
    const reviewFile = path.join(target.temporary, "review.json");
    await writeFile(reviewFile, `${JSON.stringify({
      version: 1,
      artifactId: result.artifactId,
      decisions: [{
        candidateId: candidate.candidateId,
        reviewedAt: candidate.provenance.observedAt,
        reviewedBy: "Example reviewer",
        disposition: "new",
        answers: { productIdentity: "New Tool", operatingIntent: "discovery" },
      }],
    })}\n`);
    const reviewed = JSON.parse((await execFileAsync(process.execPath, [
      cli, "discover-local", "example-host", "--root", target.selected, "--review", reviewFile, "--json",
    ], {
      cwd: root,
      env: { ...process.env, DEVHUB_CATALOG_DIR: target.catalogDirectory, DEVHUB_HOST_ID: "example-host" },
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    })).stdout);
    assert.equal(reviewed.artifactId, result.artifactId, "unchanged roots retain the artifact-bound review identity");
    assert.equal(reviewed.summary.proposals, 1);
    assert.equal(reviewed.proposals[0].writes, false);
    assert.equal(await readFile(path.join(target.catalogDirectory, "projects/known.yaml"), "utf8"), knownBefore);
    assert.deepEqual(await readdir(target.selected), selectedBefore);
  } finally {
    await rm(target.temporary, { recursive: true, force: true });
  }
});

test("discover-local rejects unknown, duplicate and conflicting authority before returning candidates", { skip: !supported }, async () => {
  const target = await fixture();
  try {
    for (const [argumentsList, environment, code] of [
      [["discover-local", "missing-host", "--root", target.selected, "--json"], {}, "unknown-local-host"],
      [["discover-local", "example-host", "--root", target.selected, "--root", target.selected, "--json"], {}, "duplicate-local-root"],
      [["discover-local", "example-host", "--root", target.selected, "--json"], { DEVHUB_HOST_ID: "other-host" }, "local-host-identity-conflict"],
    ]) {
      await assert.rejects(
        execFileAsync(process.execPath, [cli, ...argumentsList], {
          cwd: root,
          env: { ...process.env, DEVHUB_CATALOG_DIR: target.catalogDirectory, ...environment },
        }),
        (error) => JSON.parse(error.stdout).error.code === code,
      );
    }
  } finally {
    await rm(target.temporary, { recursive: true, force: true });
  }
});
