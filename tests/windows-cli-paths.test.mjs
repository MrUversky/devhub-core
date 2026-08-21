import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { resolveUserDevHubPaths } from "../scripts/devhub-config.mjs";
import { verifyPublicManifest } from "../scripts/verify-public-manifest.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "scripts/devhub.mjs");

test("public manifest excludes only root Git metadata and keeps line endings byte-bound", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "devhub-public-manifest-portable-"));
  const contents = "first line\nsecond line\n";
  const digest = createHash("sha256").update(contents).digest("hex");
  try {
    await writeFile(path.join(directory, "portable.txt"), contents);
    await writeFile(path.join(directory, "PUBLIC_EXPORT_MANIFEST.json"), `${JSON.stringify({
      manifestVersion: 2,
      exporterVersion: 1,
      source: { commit: "1".repeat(40), state: "clean" },
      files: [{ path: "portable.txt", sha256: digest }],
    }, null, 2)}\n`);

    await mkdir(path.join(directory, ".git", "objects"), { recursive: true });
    await writeFile(path.join(directory, ".git", "FETCH_HEAD"), "checkout metadata\n");
    assert.equal((await verifyPublicManifest(directory)).files, 1);

    await rm(path.join(directory, ".git"), { recursive: true, force: true });
    await writeFile(path.join(directory, ".git"), "gitdir: external-worktree-metadata\n");
    assert.equal((await verifyPublicManifest(directory)).files, 1);

    await mkdir(path.join(directory, ".svn"), { recursive: true });
    await writeFile(path.join(directory, ".svn", "metadata"), "not ignored\n");
    await assert.rejects(verifyPublicManifest(directory), /Unexpected: \.svn\/metadata/);
    await rm(path.join(directory, ".svn"), { recursive: true, force: true });

    await writeFile(path.join(directory, "portable.txt"), contents.replaceAll("\n", "\r\n"));
    await assert.rejects(verifyPublicManifest(directory), /Changed: portable\.txt/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows source-asset CLI resolves external paths and validates a Windows starter catalog", {
  skip: process.platform !== "win32" ? "runs only in Windows CLI/path CI" : false,
}, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-windows-cli-paths-"));
  const dataHome = path.join(temporary, "data home");
  const configHome = path.join(temporary, "config home");
  const catalogDirectory = path.join(temporary, "catalog repository", "catalog");
  const generatedDirectory = path.join(temporary, "generated output");
  const profiles = path.join(configHome, "devhub", "connection-profiles.json");
  const environment = {
    ...process.env,
    XDG_DATA_HOME: dataHome,
    XDG_CONFIG_HOME: configHome,
  };
  try {
    const paths = resolveUserDevHubPaths(environment, { homeDirectory: temporary });
    assert.equal(paths.dataRoot, path.join(dataHome, "devhub"));
    assert.equal(paths.catalogDirectory, path.join(dataHome, "devhub", "catalog"));
    assert.equal(paths.connectionProfilesPath, profiles);
    for (const value of Object.values(paths)) {
      assert.equal(path.isAbsolute(value), true);
      assert.equal(value.includes("\\"), true);
    }

    const workflow = JSON.parse((await execFileAsync(process.execPath, [
      cli, "doctor", "--workflow", "--json",
    ], { cwd: temporary, env: environment })).stdout);
    assert.equal(workflow.contractVersion, 2);
    assert.deepEqual(workflow.capabilities, {
      setupRun: 1,
      connectionReview: 1,
      guidedConfirmation: 1,
      taskObservation: 1,
    });

    const initialized = JSON.parse((await execFileAsync(process.execPath, [
      cli,
      "init-catalog", catalogDirectory,
      "--host-id", "windows-gate-host",
      "--host-name", "Windows gate host",
      "--host-kind", "windows",
      "--host-location", "local",
      "--apply", "--json",
    ], { cwd: temporary, env: environment })).stdout);
    assert.equal(initialized.status, "created");
    assert.match(await readFile(path.join(catalogDirectory, "hosts.yaml"), "utf8"), /kind: windows/);

    const globalPaths = [
      "--catalog-dir", catalogDirectory,
      "--connection-profiles-file", profiles,
      "--generated-dir", generatedDirectory,
    ];
    await execFileAsync(process.execPath, [cli, "validate", ...globalPaths], {
      cwd: temporary,
      env: environment,
    });
    await execFileAsync(process.execPath, [cli, "validate", "--check", ...globalPaths], {
      cwd: temporary,
      env: environment,
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("public documentation keeps Windows claims narrower than the CLI/path CI", async () => {
  const packagedInstallation = path.join(root, "packaging/public-root/docs/INSTALLATION.md");
  const installation = await readFile(
    existsSync(packagedInstallation) ? packagedInstallation : path.join(root, "docs/INSTALLATION.md"),
    "utf8",
  );
  const releaseGate = await readFile(path.join(root, "docs/RC_RELEASE_GATE.md"), "utf8");
  assert.match(installation, /Windows CLI support is not documented by\s+this release/);
  assert.match(releaseGate, /does not prove a Windows user-wide installer/i);
  assert.match(releaseGate, /no Windows service\s+installer/i);
  assert.match(releaseGate, /git archive HEAD[\s\S]*canonical Git\s+blob bytes/i);
  assert.match(releaseGate, /does not\s+normalize content or line endings/i);
});
