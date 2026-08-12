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

test("init --catalog --dry-run prints planned files without modifying filesystem", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "devhub-init-dryrun-"));
  try {
    const targetCatalog = path.join(temporaryRoot, "catalog");
    const result = await runWithEnvironment(["init", "--catalog", targetCatalog, "--dry-run"]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /DevHub catalog initialization \(dry-run\)/);
    assert.match(result.stdout, /Would create:/);

    await assert.rejects(readFile(path.join(targetCatalog, "hosts.yaml"), "utf8"), /ENOENT/);
    await assert.rejects(readFile(path.join(targetCatalog, "projects/devhub.yaml"), "utf8"), /ENOENT/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("init --catalog --dry-run --json returns structured dry-run JSON", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "devhub-init-json-"));
  try {
    const targetCatalog = path.join(temporaryRoot, "catalog");
    const result = await runWithEnvironment(["init", "--catalog", targetCatalog, "--dry-run", "--json"]);
    assert.equal(result.exitCode, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.command, "init");
    assert.equal(output.mode, "catalog");
    assert.equal(output.readOnly, true);
    assert.equal(output.status, "dry-run");
    assert.equal(output.destination, targetCatalog);
    assert.equal(output.plannedFiles.length, 2);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("init --catalog creates starter catalog and generated JSON validates immediately", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "devhub-init-exec-"));
  try {
    await cp(path.join(root, "templates"), path.join(temporaryRoot, "templates"), { recursive: true });
    await cp(path.join(root, "scripts"), path.join(temporaryRoot, "scripts"), { recursive: true });
    await mkdir(path.join(temporaryRoot, "app/generated"), { recursive: true });
    await mkdir(path.join(temporaryRoot, "public"), { recursive: true });

    const targetCatalog = path.join(temporaryRoot, "catalog");
    const initResult = await runWithEnvironment(["init", "--catalog", targetCatalog], {
      DEVHUB_CATALOG_DIR: targetCatalog,
    });
    assert.equal(initResult.exitCode, 0);
    assert.match(initResult.stdout, /Initialized starter catalog/);

    const hostsContent = await readFile(path.join(targetCatalog, "hosts.yaml"), "utf8");
    const projectContent = await readFile(path.join(targetCatalog, "projects/devhub.yaml"), "utf8");
    assert.match(hostsContent, /id: local-server/);
    assert.match(projectContent, /id: devhub/);

    const checkResult = await runWithEnvironment(["validate", "--check"], {
      DEVHUB_CATALOG_DIR: targetCatalog,
    });
    assert.equal(checkResult.exitCode, 0);
    assert.match(checkResult.stdout, /\(current\)/);
  } finally {
    await run("validate");
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("init --catalog refuses non-empty destination when arbitrary file exists", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "devhub-init-file-"));
  try {
    const targetCatalog = path.join(temporaryRoot, "catalog");
    await mkdir(targetCatalog, { recursive: true });
    await writeFile(path.join(targetCatalog, "notes.txt"), "some content\n");

    const result = await runWithEnvironment(["init", "--catalog", targetCatalog, "--json"]);
    assert.equal(result.exitCode, 3);
    const output = JSON.parse(result.stdout);
    assert.equal(output.error.code, "catalog-destination-not-empty");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("init --catalog refuses non-empty destination when arbitrary directory exists", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "devhub-init-dir-"));
  try {
    const targetCatalog = path.join(temporaryRoot, "catalog");
    await mkdir(path.join(targetCatalog, "custom-folder"), { recursive: true });

    const result = await runWithEnvironment(["init", "--catalog", targetCatalog, "--json"]);
    assert.equal(result.exitCode, 3);
    const output = JSON.parse(result.stdout);
    assert.equal(output.error.code, "catalog-destination-not-empty");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("init --catalog refuses non-empty destination when hosts.yaml already exists", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "devhub-init-nonempty-hosts-"));
  try {
    const targetCatalog = path.join(temporaryRoot, "catalog");
    await mkdir(targetCatalog, { recursive: true });
    await writeFile(path.join(targetCatalog, "hosts.yaml"), "version: 1\nhosts: []\n");

    const result = await runWithEnvironment(["init", "--catalog", targetCatalog, "--json"]);
    assert.equal(result.exitCode, 3);
    const output = JSON.parse(result.stdout);
    assert.equal(output.error.code, "catalog-destination-not-empty");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("init --catalog refuses non-empty destination when projects directory exists", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "devhub-init-nonempty-projects-dir-"));
  try {
    const targetCatalog = path.join(temporaryRoot, "catalog");
    await mkdir(path.join(targetCatalog, "projects"), { recursive: true });

    const result = await runWithEnvironment(["init", "--catalog", targetCatalog, "--json"]);
    assert.equal(result.exitCode, 3);
    const output = JSON.parse(result.stdout);
    assert.equal(output.error.code, "catalog-destination-not-empty");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("init --catalog refuses non-empty destination when existing project file exists", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "devhub-init-nonempty-projects-file-"));
  try {
    const targetCatalog = path.join(temporaryRoot, "catalog");
    await mkdir(path.join(targetCatalog, "projects"), { recursive: true });
    await writeFile(path.join(targetCatalog, "projects/custom.yaml"), "version: 1\n");

    const result = await runWithEnvironment(["init", "--catalog", targetCatalog, "--json"]);
    assert.equal(result.exitCode, 3);
    const output = JSON.parse(result.stdout);
    assert.equal(output.error.code, "catalog-destination-not-empty");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("project-level init creates .devhub/project.yaml and refuses duplicate initialization", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "devhub-init-project-"));
  try {
    const targetProject = path.join(temporaryRoot, "my-project");
    await mkdir(targetProject, { recursive: true });

    const firstRun = await runWithEnvironment(["init", targetProject]);
    assert.equal(firstRun.exitCode, 0);
    assert.match(firstRun.stdout, /Created /);

    const projectYaml = await readFile(path.join(targetProject, ".devhub/project.yaml"), "utf8");
    assert.match(projectYaml, /id: change-me/);

    const secondRun = await runWithEnvironment(["init", targetProject]);
    assert.equal(secondRun.exitCode, 3);
    assert.match(secondRun.stderr, /already exists/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("init without --catalog flag treats positional target as project directory", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "devhub-init-positional-"));
  try {
    const targetCatalog = path.join(temporaryRoot, "catalog");
    await mkdir(targetCatalog, { recursive: true });

    const result = await runWithEnvironment(["init", targetCatalog]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Created /);

    const projectYaml = await readFile(path.join(targetCatalog, ".devhub/project.yaml"), "utf8");
    assert.match(projectYaml, /id: change-me/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("failed initialization cleans up created files and leaves no partial catalog", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "devhub-init-rollback-"));
  try {
    const targetCatalog = path.join(temporaryRoot, "catalog");
    const projectsDir = path.join(targetCatalog, "projects");
    await mkdir(projectsDir, { recursive: true });
    // Make devhub.yaml a directory so writing project file fails after hosts.yaml is written
    await mkdir(path.join(projectsDir, "devhub.yaml"), { recursive: true });

    const result = await runWithEnvironment(["init", "--catalog", targetCatalog]);

    assert.equal(result.exitCode, 3);
    await assert.rejects(readFile(path.join(targetCatalog, "hosts.yaml"), "utf8"), /ENOENT/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
