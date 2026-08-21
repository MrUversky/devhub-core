import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const catalog = JSON.parse(await readFile(new URL("../app/generated/catalog.json", import.meta.url), "utf8"));

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "scripts/devhub.mjs");
const packageDocument = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

async function run(...args) {
  return execFileAsync(process.execPath, [cli, ...args], { cwd: root });
}

async function runWithEnvironment(args, environment) {
  try {
    const result = await execFileAsync(process.execPath, [cli, ...args], {
      cwd: root,
      env: { ...process.env, ...environment },
    });
    return { ...result, exitCode: 0 };
  } catch (error) {
    return { stdout: error.stdout, stderr: error.stderr, exitCode: error.code };
  }
}

async function createDiffFixture({ catalogTitle = "Example app", nativeTitle = "Example app", registered = true } = {}) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "devhub-cli-diff-"));
  const catalogDirectory = path.join(temporaryRoot, "catalog");
  const target = path.join(temporaryRoot, "project");
  await mkdir(path.join(catalogDirectory, "projects"), { recursive: true });
  await mkdir(path.join(target, ".devhub"), { recursive: true });
  await writeFile(path.join(catalogDirectory, "hosts.yaml"), `version: 1
hosts:
  - id: example-laptop
    name: Example laptop
    kind: mac
    location: local
`);
  const manifest = (title) => `version: 1
id: example-app
title: ${title}
registration: native
description: Generic public-safe CLI fixture.
lifecycle: active
kind: product
services:
  - id: web
    name: Web
    kind: web
    environment: local
    host: example-laptop
    runtime: node
    mode: on-demand
    visibility: local
`;
  if (registered) await writeFile(path.join(catalogDirectory, "projects/example-app.yaml"), manifest(catalogTitle));
  await writeFile(path.join(target, ".devhub/project.yaml"), manifest(nativeTitle));
  return { temporaryRoot, catalogDirectory, target };
}

test("validate --check proves generated catalog is current without writing", async () => {
  const { stdout } = await run("validate", "--check");
  const serviceCount = catalog.projects.reduce((sum, project) => sum + project.services.length, 0);
  assert.match(stdout, new RegExp(`catalog: ${catalog.projects.length} projects, ${serviceCount} services \\(current\\)`));
});

test("catalog freshness check rejects stale generated output", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "devhub-catalog-check-"));
  try {
    await cp(path.join(root, "catalog"), path.join(temporaryRoot, "catalog"), { recursive: true });
    await mkdir(path.join(temporaryRoot, "app/generated"), { recursive: true });
    await mkdir(path.join(temporaryRoot, "public"), { recursive: true });
    await writeFile(path.join(temporaryRoot, "app/generated/catalog.json"), "{}\n");
    await writeFile(path.join(temporaryRoot, "public/catalog.json"), "{}\n");

    await assert.rejects(
      execFileAsync(process.execPath, [path.join(root, "scripts/compile-catalog.mjs")], {
        cwd: temporaryRoot,
        env: { ...process.env, DEVHUB_CATALOG_CHECK: "1" },
      }),
      /is stale/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("doctor returns machine-readable, non-mutating catalog findings", async () => {
  const { stdout } = await run("doctor", "--json");
  const result = JSON.parse(stdout);
  assert.equal(result.command, "doctor");
  assert.equal(result.readOnly, true);
  assert.ok(Array.isArray(result.findings));
  assert.ok(result.findings.every((finding) => finding.code && finding.severity && finding.message));
});

test("doctor workflow returns the exact deterministic compatibility contract without catalog access", async () => {
  const missingCatalog = path.join(os.tmpdir(), `devhub-missing-catalog-${process.pid}`);
  const first = await runWithEnvironment(["doctor", "--workflow", "--json"], { DEVHUB_CATALOG_DIR: missingCatalog });
  const second = await runWithEnvironment(["doctor", "--workflow", "--json"], { DEVHUB_CATALOG_DIR: missingCatalog });
  assert.equal(first.exitCode, 0);
  assert.equal(first.stderr, "");
  assert.equal(second.exitCode, 0);
  assert.deepEqual(JSON.parse(first.stdout), {
    contractVersion: 2,
    runtimeVersion: packageDocument.version,
    capabilities: { setupRun: 1, connectionReview: 1, guidedConfirmation: 1, taskObservation: 1 },
  });
  assert.equal(second.stdout, first.stdout);

  const ordinaryDoctor = await runWithEnvironment(["doctor", "--json"], { DEVHUB_CATALOG_DIR: missingCatalog });
  assert.notEqual(ordinaryDoctor.exitCode, 0, "ordinary doctor should still read the configured catalog");
});

test("doctor workflow rejects missing JSON, duplicate, unknown and positional arguments", async () => {
  for (const argumentsList of [
    ["doctor", "--workflow"],
    ["doctor", "--workflow", "--json", "--json"],
    ["doctor", "--workflow", "--json", "--extra"],
    ["doctor", "--workflow", "--json", "unexpected"],
  ]) {
    const result = await runWithEnvironment(argumentsList, {});
    assert.equal(result.exitCode, 3);
    const output = argumentsList.includes("--json") ? JSON.parse(result.stdout) : null;
    if (output) assert.equal(output.error.code, "doctor-arguments-invalid");
    else assert.match(result.stderr, /doctor-arguments-invalid/);
  }
});

test("doctor install exposes path precedence without reading catalog or credential values", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "devhub-doctor-install-"));
  try {
    const instanceConfig = path.join(temporaryRoot, "instance.json");
    const instanceGenerated = path.join(temporaryRoot, "instance-generated");
    const environmentProfiles = path.join(temporaryRoot, "environment-profiles.json");
    const cliCatalog = path.join(temporaryRoot, "cli-catalog");
    await writeFile(instanceConfig, `${JSON.stringify({
      version: 1,
      catalogDirectory: path.join(temporaryRoot, "instance-catalog"),
      connectionProfilesFile: path.join(temporaryRoot, "instance-profiles.json"),
      generatedDirectory: instanceGenerated,
    }, null, 2)}\n`);
    const result = await runWithEnvironment([
      "doctor", "--install", "--json",
      "--instance-config", instanceConfig,
      "--catalog-dir", cliCatalog,
    ], {
      DEVHUB_CONNECTION_PROFILES_FILE: environmentProfiles,
    });
    assert.equal(result.exitCode, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.command, "doctor-install");
    assert.equal(output.cliVersion, packageDocument.version);
    assert.equal(output.catalogPath, cliCatalog);
    assert.equal(output.connectionProfilesPath, environmentProfiles);
    assert.deepEqual(output.generatedPaths, [
      path.join(instanceGenerated, "app-catalog.json"),
      path.join(instanceGenerated, "public-catalog.json"),
    ]);
    assert.doesNotMatch(result.stdout, /credentialValue|tokenValue|secretValue/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("reconcile returns an existing native record and semantic state", async () => {
  const fixture = await createDiffFixture();
  try {
    const result = await runWithEnvironment(["reconcile", fixture.target, "--json"], {
      DEVHUB_CATALOG_DIR: fixture.catalogDirectory,
      DEVHUB_HOST_ID: "example-laptop",
    });
    assert.equal(result.exitCode, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.command, "reconcile");
    assert.equal(output.readOnly, true);
    assert.equal(output.match.project.id, "example-app");
    assert.equal(output.registration.recommendation, "native");
    assert.equal(output.drift, "in-sync");
  } finally {
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  }
});

test("propose-overlay prints a review candidate and leaves live catalog untouched", async () => {
  const fixture = await createDiffFixture({ registered: false });
  try {
    await rm(path.join(fixture.target, ".devhub"), { recursive: true, force: true });
    await writeFile(path.join(fixture.target, "package.json"), JSON.stringify({
      name: "cli-overlay-fixture",
      scripts: { dev: "vite" },
    }));
    const before = await readdir(path.join(fixture.catalogDirectory, "projects"));
    const result = await runWithEnvironment([
      "propose-overlay", fixture.target, "cli-overlay", "--json",
    ], {
      DEVHUB_CATALOG_DIR: fixture.catalogDirectory,
      DEVHUB_HOST_ID: "example-laptop",
    });

    assert.equal(result.exitCode, 2);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.equal(output.command, "propose-overlay");
    assert.equal(output.readOnly, true);
    assert.equal(output.candidate.id, "cli-overlay");
    assert.equal(output.candidate.manifest.registration, "overlay");
    assert.match(output.candidate.yaml, /id: cli-overlay/);
    assert.ok(output.unknowns.some((unknown) => unknown.field === "services"));
    assert.deepEqual(await readdir(path.join(fixture.catalogDirectory, "projects")), before);
    await assert.rejects(readFile(output.candidate.reviewDestination, "utf8"), /ENOENT/);
    await assert.rejects(readFile(path.join(fixture.target, ".devhub/project.yaml"), "utf8"), /ENOENT/);
  } finally {
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  }
});

test("diff uses distinct clean, drift and review-required exit codes", async () => {
  for (const scenario of [
    { options: {}, status: "clean", exitCode: 0 },
    { options: { catalogTitle: "Old title", nativeTitle: "Reviewed title" }, status: "drift", exitCode: 2 },
    { options: { registered: false }, status: "review-required", exitCode: 2 },
  ]) {
    const fixture = await createDiffFixture(scenario.options);
    try {
      const result = await runWithEnvironment(["diff", fixture.target, "--json"], {
        DEVHUB_CATALOG_DIR: fixture.catalogDirectory,
        DEVHUB_HOST_ID: "example-laptop",
      });
      assert.equal(result.exitCode, scenario.exitCode);
      const output = JSON.parse(result.stdout);
      assert.equal(output.command, "diff");
      assert.equal(output.status, scenario.status);
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  }
});

test("malformed catalog YAML returns structured JSON and exit 3 for dry-run and apply", async () => {
  const fixture = await createDiffFixture();
  try {
    await writeFile(path.join(fixture.catalogDirectory, "hosts.yaml"), "version: 1\nhosts: [unterminated\n");
    for (const args of [
      ["diff", fixture.target, "--json"],
      ["reconcile", fixture.target, "--json", "--apply"],
    ]) {
      const result = await runWithEnvironment(args, {
        DEVHUB_CATALOG_DIR: fixture.catalogDirectory,
        DEVHUB_HOST_ID: "example-laptop",
      });
      assert.equal(result.exitCode, 3);
      assert.equal(result.stderr, "");
      const output = JSON.parse(result.stdout);
      assert.equal(output.status, "invalid");
      assert.equal(output.exitCode, 3);
      assert.equal(output.error.code, "invalid-hosts-yaml");
    }
  } finally {
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  }
});

test("the exported native demo and reviewed catalog start in sync", async () => {
  const demoRoot = path.join(root, "examples/demo");
  const result = await runWithEnvironment(["diff", demoRoot, "--json"], {
    DEVHUB_CATALOG_DIR: path.join(demoRoot, "catalog"),
    DEVHUB_HOST_ID: "developer-laptop",
  });
  assert.equal(result.exitCode, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "clean");
  assert.deepEqual(output.diff, []);
});

test("inspect-host emits a conservative read-only report for a reviewed managed host", async () => {
  const demoRoot = path.join(root, "examples/demo");
  const result = await runWithEnvironment(["inspect-host", "--json"], {
    DEVHUB_CATALOG_DIR: path.join(demoRoot, "catalog"),
    DEVHUB_HOST_ID: "managed-cloud",
  });
  assert.equal(result.exitCode, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.command, "inspect-host");
  assert.equal(output.readOnly, true);
  assert.equal(output.host.id, "managed-cloud");
  assert.deepEqual(output.serviceMatches, []);
  assert.ok(output.unknowns.some((item) => item.serviceId === "production-api" && item.reason === "managed-host-not-local"));
});

test("inspect-host rejects a host argument that conflicts with configured local identity", async () => {
  const demoRoot = path.join(root, "examples/demo");
  const result = await runWithEnvironment(["inspect-host", "developer-laptop", "--json"], {
    DEVHUB_CATALOG_DIR: path.join(demoRoot, "catalog"),
    DEVHUB_HOST_ID: "devhub-server",
  });
  assert.equal(result.exitCode, 3);
  const output = JSON.parse(result.stdout);
  assert.equal(output.error.code, "host-identity-conflict");
});

test("reconcile is a reviewed dry-run plan unless apply is explicit", async () => {
  const fixture = await createDiffFixture({ catalogTitle: "Old title", nativeTitle: "Reviewed title" });
  try {
    const before = await readFile(path.join(fixture.catalogDirectory, "projects/example-app.yaml"), "utf8");
    const result = await runWithEnvironment(["reconcile", fixture.target, "--json"], {
      DEVHUB_CATALOG_DIR: fixture.catalogDirectory,
      DEVHUB_HOST_ID: "example-laptop",
    });
    const plan = JSON.parse(result.stdout);
    assert.equal(result.exitCode, 2);
    assert.equal(plan.readOnly, true);
    assert.equal(plan.reviewRequired, true);
    assert.equal(plan.plan.action, "update-catalog-from-native");
    assert.equal(await readFile(path.join(fixture.catalogDirectory, "projects/example-app.yaml"), "utf8"), before);
  } finally {
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  }
});
