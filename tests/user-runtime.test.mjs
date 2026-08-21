import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

import {
  inspectRuntimeArchive,
  installUserRuntime,
  rollbackUserRuntime,
  uninstallUserRuntime,
} from "../scripts/devhub-install.mjs";
import { loadDevHubPaths } from "../scripts/devhub-config.mjs";
import { collectInstallDoctor } from "../scripts/install-doctor.mjs";
import {
  buildReleaseArtifacts,
  createDeterministicTarGzip,
} from "../scripts/release-artifacts.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const privateFingerprintFile = path.join(root, "config/public-export-deny-patterns.txt");
const fingerprintFile = existsSync(privateFingerprintFile) ? privateFingerprintFile : null;
const lifecycleHelpersAvailable = ["git", "mkfifo", "ps"].every((command) =>
  (process.env.PATH ?? "").split(path.delimiter).some((directory) => existsSync(path.join(directory, command))));
let candidateRoot;
let snapshot;
let evidenceRoot;
let evidence;

function digest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

before(async () => {
  candidateRoot = await mkdtemp(path.join(os.tmpdir(), "devhub-user-runtime-candidate-"));
  evidenceRoot = path.join(candidateRoot, "evidence");
  if (existsSync(path.join(root, ".devhub-public-snapshot"))) snapshot = root;
  else {
    snapshot = path.join(candidateRoot, "snapshot");
    await execFileAsync(process.execPath, [
      path.join(root, "scripts/export-public.mjs"),
      "--output", snapshot,
      "--allow-dirty",
    ], { cwd: root, maxBuffer: 20 * 1024 * 1024 });
  }
  await buildReleaseArtifacts({ snapshot, output: evidenceRoot, allowDirty: true, fingerprintFile });
  evidence = JSON.parse(await readFile(path.join(evidenceRoot, "RELEASE-EVIDENCE.json"), "utf8"));
});

after(async () => {
  if (candidateRoot) await rm(candidateRoot, { recursive: true, force: true });
});

test("installed paths use CLI, environment, instance configuration and external defaults in order", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-installed-paths-"));
  try {
    const runtimeRoot = path.join(temporary, "runtime");
    const homeDirectory = path.join(temporary, "home");
    const configHome = path.join(homeDirectory, ".config");
    const instanceConfigPath = path.join(configHome, "devhub/instance.json");
    const instanceCatalog = path.join(temporary, "instance-catalog");
    const instanceProfiles = path.join(temporary, "instance-profiles.json");
    const instanceGenerated = path.join(temporary, "instance-generated");
    await mkdir(runtimeRoot, { recursive: true });
    await mkdir(path.dirname(instanceConfigPath), { recursive: true });
    await writeFile(path.join(runtimeRoot, "DEVHUB_RUNTIME_MANIFEST.json"), "{}\n");
    await writeFile(instanceConfigPath, `${JSON.stringify({
      version: 1,
      catalogDirectory: instanceCatalog,
      connectionProfilesFile: instanceProfiles,
      generatedDirectory: instanceGenerated,
    }, null, 2)}\n`);

    const cliCatalog = path.join(temporary, "cli-catalog");
    const environmentProfiles = path.join(temporary, "environment-profiles.json");
    const paths = await loadDevHubPaths(runtimeRoot, {
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: path.join(homeDirectory, ".local/share"),
      DEVHUB_CONNECTION_PROFILES_FILE: environmentProfiles,
    }, {
      homeDirectory,
      pathOptions: { catalogDirectory: cliCatalog },
    });
    assert.equal(paths.installed, true);
    assert.equal(paths.catalogDirectory, cliCatalog, "CLI option wins");
    assert.equal(paths.connectionProfilesPath, environmentProfiles, "environment wins over instance config");
    assert.equal(paths.generatedDirectory, instanceGenerated, "instance config wins over installed defaults");
    assert.equal(paths.instanceConfigPath, instanceConfigPath);

    const checkout = path.join(temporary, "checkout");
    const checkoutPaths = await loadDevHubPaths(checkout, {
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: path.join(homeDirectory, ".local/share"),
    }, { homeDirectory });
    assert.equal(checkoutPaths.installed, false);
    assert.equal(checkoutPaths.catalogDirectory, path.join(checkout, "catalog"));
    assert.equal(checkoutPaths.connectionProfilesPath, path.join(checkout, "config/connection-profiles.json"));
    assert.equal(checkoutPaths.instanceConfigPath, null);

    await writeFile(instanceConfigPath, `${JSON.stringify({ version: 1, token: "not-read" })}\n`);
    await assert.rejects(
      loadDevHubPaths(runtimeRoot, { XDG_CONFIG_HOME: configHome }, { homeDirectory }),
      (error) => error.code === "instance-config-invalid" && /unsupported fields: token/.test(error.message),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("install doctor reports version and paths while warning on FileProvider metadata without reading values", async () => {
  const runtimePath = path.join(os.tmpdir(), "devhub-runtime-local");
  const paths = {
    installed: true,
    catalogDirectory: path.join(os.tmpdir(), "devhub-catalog-local"),
    connectionProfilesPath: path.join(os.tmpdir(), "devhub-config-local/connection-profiles.json"),
    instanceConfigPath: path.join(os.tmpdir(), "devhub-config-local/instance.json"),
    generatedOutputs: [path.join(os.tmpdir(), "devhub-generated/catalog.json")],
  };
  const result = await collectInstallDoctor({ packageVersion: "1.2.3", runtimePath, paths }, {
    platform: "darwin",
    readMetadata: async (filename) => filename === runtimePath ? "compressed,dataless" : "",
  });
  assert.equal(result.cliVersion, "1.2.3");
  assert.equal(result.runtimePath, runtimePath);
  assert.deepEqual(result.findings.map((finding) => [finding.code, finding.subject]), [["fileprovider-path", "runtime"]]);
  assert.doesNotMatch(JSON.stringify(result), /credentialValue|tokenValue|secretValue/);
});

async function rewriteRuntimeVersion(archive, version, destination, { sourceState = null } = {}) {
  const parsed = inspectRuntimeArchive(archive, { allowDirty: true });
  await mkdir(destination, { recursive: true });
  for (const [relative, entry] of parsed.files) {
    if (relative === "DEVHUB_RUNTIME_MANIFEST.json") continue;
    const filename = path.join(destination, ...relative.split("/"));
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, entry.contents, { mode: entry.mode });
    await chmod(filename, entry.mode);
  }
  const packagePath = path.join(destination, "package.json");
  const packageDocument = JSON.parse(await readFile(packagePath, "utf8"));
  packageDocument.version = version;
  const packageContents = Buffer.from(`${JSON.stringify(packageDocument, null, 2)}\n`);
  await writeFile(packagePath, packageContents);

  const manifest = structuredClone(parsed.manifest);
  manifest.version = version;
  if (sourceState !== null) manifest.source.state = sourceState;
  const packageEntry = manifest.files.find((entry) => entry.path === "package.json");
  packageEntry.sha256 = digest(packageContents);
  await writeFile(path.join(destination, "DEVHUB_RUNTIME_MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return createDeterministicTarGzip(
    destination,
    `devhub-cli-v${version}`,
    ["DEVHUB_RUNTIME_MANIFEST.json", ...manifest.files.map((entry) => entry.path)].sort(),
  );
}

async function waitForPath(filename, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      return await lstat(filename);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${filename}`);
}

function collectChild(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function exactFileState(filename) {
  const details = await lstat(filename);
  return { contents: await readFile(filename), mode: details.mode & 0o777 };
}

async function runtimeProcesses(runtimePath) {
  if (process.platform === "win32") return [];
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="]);
  return stdout.split("\n").filter((line) => line.includes(runtimePath));
}

test("a hard-killed partial activation retries to one exact runtime without state loss", {
  skip: process.platform === "win32" ? "requires Unix process signals" : false,
}, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-user-runtime-interrupt-"));
  const homeDirectory = path.join(temporary, "home");
  const dataRoot = path.join(homeDirectory, ".local/share/devhub");
  const configHome = path.join(homeDirectory, ".config");
  const binDirectory = path.join(homeDirectory, ".local/bin");
  const catalogSentinel = path.join(dataRoot, "catalog/preserve-me.txt");
  const configSentinel = path.join(configHome, "devhub/preserve-me.json");
  const version = "9.9.9-interrupt-fixture";
  let child = null;
  let completion = null;
  try {
    await mkdir(path.dirname(catalogSentinel), { recursive: true });
    await mkdir(path.dirname(configSentinel), { recursive: true });
    await writeFile(catalogSentinel, "preserve catalog\n");
    await writeFile(configSentinel, "{\"preserve\":true}\n");

    const originalArchive = await readFile(path.join(evidenceRoot, evidence.runtime.file));
    const archive = await rewriteRuntimeVersion(
      originalArchive,
      version,
      path.join(temporary, "interrupt-runtime"),
      { sourceState: "clean" },
    );
    const archivePath = path.join(temporary, `devhub-cli-v${version}.tar.gz`);
    await writeFile(archivePath, archive);
    const installerPath = path.join(evidenceRoot, evidence.installer.file);
    const argumentsList = [
      installerPath,
      "install",
      "--archive", archivePath,
      "--sha256", digest(archive),
      "--data-root", dataRoot,
      "--bin-dir", binDirectory,
      "--json",
    ];
    const environment = {
      ...process.env,
      NODE_ENV: "test",
      DEVHUB_TEST_INSTALL_ACTIVATION: "pause-after-first",
      XDG_DATA_HOME: path.dirname(dataRoot),
      XDG_CONFIG_HOME: configHome,
    };
    child = spawn(process.execPath, argumentsList, { env: environment, stdio: ["ignore", "pipe", "pipe"] });
    completion = collectChild(child);
    await waitForPath(path.join(dataRoot, "runtime", version));
    await waitForPath(path.join(binDirectory, "devhub"));
    await assert.rejects(lstat(path.join(binDirectory, "devhub-install")), { code: "ENOENT" });
    await assert.rejects(lstat(path.join(dataRoot, "current")), { code: "ENOENT" });
    assert.equal((await readdir(path.join(dataRoot, "runtime"))).some((entry) => entry.startsWith(`.install-${version}-`)), true);

    assert.equal(child.kill("SIGKILL"), true);
    const killed = await completion;
    assert.equal(killed.code, null);
    assert.equal(killed.signal, "SIGKILL");

    const retryEnvironment = { ...environment };
    delete retryEnvironment.DEVHUB_TEST_INSTALL_ACTIVATION;
    const retried = JSON.parse((await execFileAsync(process.execPath, argumentsList, {
      env: retryEnvironment,
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    })).stdout);
    assert.equal(retried.status, "installed");
    assert.equal(retried.runtimeVersion, version);
    assert.deepEqual(await readdir(path.join(dataRoot, "runtime")), [version]);
    assert.equal(await readFile(path.join(dataRoot, "current"), "utf8"), `${version}\n`);
    for (const command of ["devhub", "devhub-install"]) {
      const details = await lstat(path.join(binDirectory, command));
      assert.equal(details.isFile() && !details.isSymbolicLink(), true);
      assert.equal(details.mode & 0o777, 0o755);
    }
    const workflow = JSON.parse((await execFileAsync(path.join(binDirectory, "devhub"), ["doctor", "--workflow", "--json"], {
      cwd: temporary,
      env: retryEnvironment,
      timeout: 10_000,
    })).stdout);
    assert.equal(workflow.runtimeVersion, version);
    assert.equal(await readFile(catalogSentinel, "utf8"), "preserve catalog\n");
    assert.equal(await readFile(configSentinel, "utf8"), "{\"preserve\":true}\n");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (completion) await completion.catch(() => {});
    await rm(temporary, { recursive: true, force: true });
  }
});

test("ordinary activation failure restores prior state and same-version recovery rejects a mismatch", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-user-runtime-rollback-"));
  const homeDirectory = path.join(temporary, "home");
  const dataRoot = path.join(homeDirectory, ".local/share/devhub");
  const configHome = path.join(homeDirectory, ".config");
  const binDirectory = path.join(homeDirectory, ".local/bin");
  const environment = { ...process.env, XDG_CONFIG_HOME: configHome };
  const archivePath = path.join(evidenceRoot, evidence.runtime.file);
  try {
    const catalogSentinel = path.join(dataRoot, "catalog/preserve-me.txt");
    const configSentinel = path.join(configHome, "devhub/preserve-me.json");
    await mkdir(path.dirname(catalogSentinel), { recursive: true });
    await mkdir(path.dirname(configSentinel), { recursive: true });
    await writeFile(catalogSentinel, "preserve catalog\n");
    await writeFile(configSentinel, "{\"preserve\":true}\n");
    const installed = await installUserRuntime({
      archivePath,
      expectedSha256: evidence.runtime.sha256,
      environment,
      homeDirectory,
      dataRoot,
      binDirectory,
      allowDirty: true,
    });

    const devhubPath = path.join(binDirectory, "devhub");
    const installerPath = path.join(binDirectory, "devhub-install");
    const currentPath = path.join(dataRoot, "current");
    await writeFile(devhubPath, Buffer.concat([await readFile(devhubPath), Buffer.from("# preserve wrapper bytes\n")]));
    await chmod(devhubPath, 0o750);
    await chmod(installerPath, 0o751);
    await chmod(currentPath, 0o600);
    const priorStates = new Map(await Promise.all([devhubPath, installerPath, currentPath].map(async (filename) =>
      [filename, await exactFileState(filename)])));

    const nextVersion = "9.9.9-activation-fixture";
    const nextArchive = await rewriteRuntimeVersion(
      await readFile(archivePath),
      nextVersion,
      path.join(temporary, "next-runtime"),
    );
    const nextArchivePath = path.join(temporary, `devhub-cli-v${nextVersion}.tar.gz`);
    await writeFile(nextArchivePath, nextArchive);
    await assert.rejects(
      installUserRuntime({
        archivePath: nextArchivePath,
        expectedSha256: digest(nextArchive),
        environment: {
          ...environment,
          NODE_ENV: "test",
          DEVHUB_TEST_INSTALL_ACTIVATION: "fail-after-wrappers",
        },
        homeDirectory,
        dataRoot,
        binDirectory,
        allowDirty: true,
      }),
      (error) => error.code === "test-install-activation-failure",
    );
    for (const [filename, prior] of priorStates) {
      const restored = await exactFileState(filename);
      assert.equal(restored.mode, prior.mode);
      assert.equal(restored.contents.equals(prior.contents), true);
    }
    assert.deepEqual(await readdir(path.join(dataRoot, "runtime")), [evidence.version]);
    await assert.rejects(lstat(path.join(dataRoot, "runtime", nextVersion)), { code: "ENOENT" });

    const installedEntrypoint = path.join(installed.runtimePath, "scripts/devhub.mjs");
    await writeFile(installedEntrypoint, Buffer.concat([await readFile(installedEntrypoint), Buffer.from("\n// mismatch fixture\n")]));
    await assert.rejects(
      installUserRuntime({
        archivePath,
        expectedSha256: evidence.runtime.sha256,
        environment,
        homeDirectory,
        dataRoot,
        binDirectory,
        allowDirty: true,
      }),
      (error) => error.code === "runtime-version-conflict",
    );
    assert.match(await readFile(installedEntrypoint, "utf8"), /mismatch fixture/);
    for (const [filename, prior] of priorStates) {
      const preserved = await exactFileState(filename);
      assert.equal(preserved.mode, prior.mode);
      assert.equal(preserved.contents.equals(prior.contents), true);
    }
    assert.equal(await readFile(catalogSentinel, "utf8"), "preserve catalog\n");
    assert.equal(await readFile(configSentinel, "utf8"), "{\"preserve\":true}\n");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("pinned runtime installs, upgrades, rolls back, runs npm-free from hostile cwd and uninstalls without state loss", {
  skip: process.platform === "win32" || !lifecycleHelpersAvailable
    ? "requires a Unix host with git, mkfifo and ps"
    : false,
}, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-user-runtime-lifecycle-"));
  const homeDirectory = path.join(temporary, "home");
  const dataHome = path.join(homeDirectory, ".local/share");
  const configHome = path.join(homeDirectory, ".config");
  const dataRoot = path.join(dataHome, "devhub");
  const binDirectory = path.join(homeDirectory, ".local/bin");
  const environment = { ...process.env, XDG_DATA_HOME: dataHome, XDG_CONFIG_HOME: configHome };
  const archivePath = path.join(evidenceRoot, evidence.runtime.file);
  const archive = await readFile(archivePath);
  try {
    if (evidence.source.state !== "clean") {
      await assert.rejects(
        installUserRuntime({ archivePath, expectedSha256: evidence.runtime.sha256, environment, homeDirectory }),
        (error) => error.code === "runtime-not-release-safe",
      );
      assert.deepEqual(await readdir(homeDirectory).catch(() => []), []);
    }

    const installed = evidence.source.state === "clean"
      ? JSON.parse((await execFileAsync(process.execPath, [
        path.join(evidenceRoot, evidence.installer.file),
        "install",
        "--archive", archivePath,
        "--sha256", evidence.runtime.sha256,
        "--data-root", dataRoot,
        "--bin-dir", binDirectory,
        "--json",
      ], { env: environment, timeout: 15_000 })).stdout)
      : await installUserRuntime({
        archivePath,
        expectedSha256: evidence.runtime.sha256,
        environment,
        homeDirectory,
        allowDirty: true,
      });
    assert.equal(installed.runtimeVersion, evidence.version);
    assert.equal(await readFile(path.join(dataRoot, "current"), "utf8"), `${evidence.version}\n`);
    assert.equal((await readFile(path.join(binDirectory, "devhub"), "utf8")).includes("DevHub user runtime wrapper"), true);

    const catalogDirectory = path.join(dataRoot, "catalog");
    const profilePath = path.join(configHome, "devhub/connection-profiles.json");
    await mkdir(path.dirname(profilePath), { recursive: true });
    await writeFile(profilePath, `${JSON.stringify({ version: 1, profiles: [{
      version: 1,
      id: "fixture-mac",
      connectorId: "local-host",
      authorization: { method: "local-session" },
      scope: { hostId: "fixture-mac" },
      owner: "Fixture operator",
      state: "authorization-required",
      lastObservedAt: null,
      freshForSeconds: 3600,
    }] }, null, 2)}\n`);
    await execFileAsync(path.join(binDirectory, "devhub"), [
      "init-catalog", catalogDirectory,
      "--host-id", "fixture-mac",
      "--host-name", "Fixture Mac",
      "--host-kind", "mac",
      "--host-location", "local",
      "--apply", "--json",
    ], { cwd: temporary, env: environment });
    const catalogSentinel = path.join(catalogDirectory, "preserve-me.txt");
    await writeFile(catalogSentinel, "preserve catalog\n");

    await execFileAsync(path.join(binDirectory, "devhub"), ["validate"], { cwd: temporary, env: environment });
    await execFileAsync(path.join(binDirectory, "devhub"), ["validate", "--check"], { cwd: temporary, env: environment });
    assert.deepEqual((await readdir(path.join(dataRoot, "generated"))).sort(), ["app-catalog.json", "public-catalog.json"]);
    await assert.rejects(readFile(path.join(installed.runtimePath, "app/generated/catalog.json")), { code: "ENOENT" });

    const emptyWorkingDirectory = path.join(temporary, "empty-project");
    await mkdir(emptyWorkingDirectory);
    const emptySetup = JSON.parse((await execFileAsync(path.join(binDirectory, "devhub"), ["setup", "--json"], {
      cwd: emptyWorkingDirectory,
      env: environment,
      timeout: 3_000,
    })).stdout);
    assert.equal(emptySetup.command, "setup");
    assert.equal(emptySetup.readOnly, true);
    assert.deepEqual(await readdir(emptyWorkingDirectory), [], "setup must not change an empty caller directory");

    const hostile = path.join(homeDirectory, "Library/CloudStorage/FixtureProvider/evicted-checkout");
    await mkdir(hostile, { recursive: true });
    await execFileAsync("git", ["init", "--quiet", hostile]);
    await writeFile(path.join(hostile, "dirty-untracked.txt"), "do not change\n");
    await writeFile(path.join(hostile, ".dataless-placeholder"), "evicted fixture\n");
    if (process.platform === "darwin") {
      await execFileAsync("xattr", ["-w", "com.apple.fileprovider.fixture", "dataless", hostile]);
    }
    await execFileAsync("mkfifo", [path.join(hostile, "package.json")]);
    const beforeEntries = (await readdir(hostile)).sort();
    const beforeStatus = (await execFileAsync("git", ["-C", hostile, "status", "--porcelain=v1", "--untracked-files=all"])).stdout;
    const setup = JSON.parse((await execFileAsync(path.join(binDirectory, "devhub"), ["setup", "--json"], {
      cwd: hostile,
      env: environment,
      timeout: 3_000,
    })).stdout);
    assert.equal(setup.command, "setup");
    assert.equal(setup.readOnly, true);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const started = Date.now();
      const { stdout, stderr } = await execFileAsync(path.join(binDirectory, "devhub"), [
        "setup-run", "--sources", "github", "--deadline-ms", "300", "--json",
      ], { cwd: hostile, env: environment, timeout: 3_000, maxBuffer: 4 * 1024 * 1024 });
      assert.equal(stderr, "");
      const result = JSON.parse(stdout);
      assert.equal(result.command, "setup-run");
      assert.equal((stdout.match(/"command": "setup-run"/g) ?? []).length, 1);
      assert.ok(Date.now() - started < 1_500, "setup-run must finish inside deadline plus cleanup grace");
      assert.deepEqual(await runtimeProcesses(installed.runtimePath), [], "setup-run must leave no installed-runtime descendants");
    }
    const onboardOutput = (await execFileAsync(path.join(binDirectory, "devhub"), [
      "onboard", "--sources", "github", "--deadline-ms", "300", "--json",
    ], { cwd: hostile, env: environment, timeout: 3_000, maxBuffer: 4 * 1024 * 1024 })).stdout;
    const onboard = JSON.parse(onboardOutput);
    assert.equal(onboard.command, "onboard");
    assert.equal(onboard.planVersion, 1);
    assert.equal(onboard.provenance.catalog.state, "reviewed-existing");
    assert.ok(onboard.application);
    assert.deepEqual(onboard.diff, { changed: false, state: "none", reason: "preview-only" });
    assert.doesNotMatch(onboardOutput, new RegExp(hostile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.deepEqual(await runtimeProcesses(installed.runtimePath), [], "onboard must leave no installed-runtime descendants");
    assert.match(await readFile(path.join(installed.runtimePath, "scripts/onboard-apply.mjs"), "utf8"), /isolated Git cleanup failed/);
    assert.deepEqual((await readdir(hostile)).sort(), beforeEntries);
    assert.equal(await readFile(path.join(hostile, "dirty-untracked.txt"), "utf8"), "do not change\n");
    assert.equal((await execFileAsync("git", ["-C", hostile, "status", "--porcelain=v1", "--untracked-files=all"])).stdout, beforeStatus);

    const installDoctor = JSON.parse((await execFileAsync(path.join(binDirectory, "devhub"), ["doctor", "--install", "--json"], {
      cwd: hostile,
      env: environment,
    })).stdout);
    assert.equal(installDoctor.installedRuntime, true);
    assert.equal(installDoctor.runtimePath, installed.runtimePath);
    assert.equal(installDoctor.catalogPath, catalogDirectory);
    assert.equal(installDoctor.connectionProfilesPath, profilePath);

    await assert.rejects(
      installUserRuntime({ archivePath, expectedSha256: "0".repeat(64), environment, homeDirectory, allowDirty: true }),
      (error) => error.code === "runtime-checksum-mismatch",
    );
    assert.equal(await readFile(path.join(dataRoot, "current"), "utf8"), `${evidence.version}\n`);

    const nextVersion = "0.7.0-alpha.4";
    const nextStage = path.join(temporary, "next-runtime");
    const nextArchive = await rewriteRuntimeVersion(archive, nextVersion, nextStage);
    const nextArchivePath = path.join(temporary, `devhub-cli-v${nextVersion}.tar.gz`);
    await writeFile(nextArchivePath, nextArchive);
    if (evidence.source.state === "clean") {
      await execFileAsync(path.join(binDirectory, "devhub-install"), [
        "install", "--archive", nextArchivePath, "--sha256", digest(nextArchive), "--json",
      ], { env: environment, timeout: 15_000 });
    } else {
      await installUserRuntime({
        archivePath: nextArchivePath,
        expectedSha256: digest(nextArchive),
        environment,
        homeDirectory,
        allowDirty: true,
      });
    }
    assert.equal(JSON.parse((await execFileAsync(path.join(binDirectory, "devhub"), ["doctor", "--workflow", "--json"], {
      cwd: hostile,
      env: environment,
    })).stdout).runtimeVersion, nextVersion);

    if (evidence.source.state === "clean") {
      await execFileAsync(path.join(binDirectory, "devhub-install"), ["rollback", "--version", evidence.version, "--json"], {
        env: environment,
        timeout: 15_000,
      });
    } else await rollbackUserRuntime({ version: evidence.version, environment, homeDirectory, allowDirty: true });
    assert.equal(JSON.parse((await execFileAsync(path.join(binDirectory, "devhub"), ["doctor", "--workflow", "--json"], {
      cwd: hostile,
      env: environment,
    })).stdout).runtimeVersion, evidence.version);

    const uninstall = evidence.source.state === "clean"
      ? JSON.parse((await execFileAsync(path.join(binDirectory, "devhub-install"), ["uninstall", "--json"], {
        env: environment,
        timeout: 15_000,
      })).stdout)
      : await uninstallUserRuntime({ environment, homeDirectory });
    assert.equal(uninstall.status, "uninstalled");
    assert.equal(await readFile(catalogSentinel, "utf8"), "preserve catalog\n");
    assert.match(await readFile(profilePath, "utf8"), /"id": "fixture-mac"/);
    await assert.rejects(readFile(path.join(binDirectory, "devhub")), { code: "ENOENT" });
    await assert.rejects(readdir(path.join(dataRoot, "runtime")), { code: "ENOENT" });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("installer rejects a cloud-backed runtime root before activation", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-user-runtime-cloud-"));
  const homeDirectory = path.join(temporary, "home");
  const dataRoot = path.join(homeDirectory, "Library/CloudStorage/FixtureProvider/devhub");
  const binDirectory = path.join(homeDirectory, ".local/bin");
  try {
    await assert.rejects(
      installUserRuntime({
        archivePath: path.join(evidenceRoot, evidence.runtime.file),
        expectedSha256: evidence.runtime.sha256,
        environment: process.env,
        homeDirectory,
        dataRoot,
        binDirectory,
        allowDirty: true,
      }),
      (error) => error.code === "install-path-cloud-backed",
    );
    assert.deepEqual(await readdir(binDirectory).catch(() => []), []);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("release packaging fails closed on the private operational checkout", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-private-package-reject-"));
  try {
    const privateLike = path.join(temporary, "private-checkout");
    await mkdir(privateLike);
    await writeFile(path.join(privateLike, "package.json"), "{\"name\":\"private-instance\"}\n");
    await assert.rejects(
      buildReleaseArtifacts({ snapshot: privateLike, output: path.join(temporary, "evidence"), allowDirty: true, fingerprintFile }),
      /PUBLIC_EXPORT_MANIFEST|public manifest/i,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
