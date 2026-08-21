import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { inspectRuntimeArchive } from "../scripts/devhub-install.mjs";
import {
  buildReleaseArtifacts,
  readApplicationReleaseVersion,
  verifyReleaseArtifacts,
} from "../scripts/release-artifacts.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const packageVersion = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version;

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function writeEvidenceContract(directory, evidence) {
  const contents = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
  await writeFile(path.join(directory, "RELEASE-EVIDENCE.json"), contents);
  const checksumsPath = path.join(directory, "SHA256SUMS");
  const checksums = await readFile(checksumsPath, "utf8");
  const updated = checksums.replace(
    /^[a-f0-9]{64}[ ]{2}RELEASE-EVIDENCE\.json$/m,
    `${sha256(contents)}  RELEASE-EVIDENCE.json`,
  );
  assert.notEqual(updated, checksums, "release evidence checksum entry must exist");
  await writeFile(checksumsPath, updated);
}

test("committed release intent owns the application candidate version", async () => {
  assert.equal(await readApplicationReleaseVersion(root), packageVersion);

  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-release-version-"));
  try {
    await mkdir(path.join(temporary, "config"));
    await writeFile(path.join(temporary, "package.json"), `${JSON.stringify({ version: "1.2.3" }, null, 2)}\n`);
    await writeFile(path.join(temporary, "package-lock.json"), `${JSON.stringify({
      version: "1.2.3",
      packages: { "": { version: "1.2.3" } },
    }, null, 2)}\n`);
    await writeFile(path.join(temporary, "config/release-intent.json"), `${JSON.stringify({
      applicationVersion: "1.2.4",
    }, null, 2)}\n`);
    await assert.rejects(
      readApplicationReleaseVersion(temporary),
      /application version 1\.2\.3 does not match release intent 1\.2\.4/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("release evidence is deterministic, allowlisted and tamper-evident", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-release-artifacts-"));
  let snapshot = root;
  let snapshotIsCurrentPublicRoot = false;
  const first = path.join(temporary, "first");
  const second = path.join(temporary, "second");
  try {
    try {
      await lstat(path.join(root, ".devhub-public-snapshot"));
      snapshotIsCurrentPublicRoot = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      snapshot = path.join(temporary, "snapshot");
      await execFileAsync(process.execPath, [
        path.join(root, "scripts/export-public.mjs"),
        "--output", snapshot,
        "--allow-dirty",
      ], { cwd: root, maxBuffer: 20 * 1024 * 1024 });
    }

    const manifest = JSON.parse(await readFile(path.join(snapshot, "PUBLIC_EXPORT_MANIFEST.json"), "utf8"));
    const releasePlugin = JSON.parse(await readFile(path.join(snapshot, "plugins/devhub/.codex-plugin/plugin.json"), "utf8"));
    const releaseSkill = await readFile(path.join(snapshot, "plugins/devhub/skills/devhub-registry/SKILL.md"), "utf8");
    const releaseTaskObservations = await readFile(path.join(snapshot, "lib/task-observations.mjs"), "utf8");
    const releaseInstallation = await readFile(path.join(snapshot, "docs/INSTALLATION.md"), "utf8");
    const releaseChangelog = await readFile(path.join(snapshot, "CHANGELOG.md"), "utf8");
    assert.equal(releasePlugin.name, "devhub");
    assert.equal(releasePlugin.version, "0.7.0-alpha.5");
    assert.equal(JSON.parse(await readFile(path.join(snapshot, "package.json"), "utf8")).version, packageVersion);
    assert.match(releaseSkill, /devhub doctor --workflow --json/);
    assert.match(releaseSkill, /contract version 2[\s\S]*setupRun: 1[\s\S]*connectionReview: 1[\s\S]*guidedConfirmation: 1[\s\S]*taskObservation: 1/);
    assert.match(releaseSkill, /setup-run --sources <canonical-comma-list> --task-observation[\s\S]*Do not run a baseline setup-run first/i);
    assert.match(releaseSkill, /Saved connection:[*\s]*Yes[\s\S]*Yes · needs recheck[\s\S]*task-only[\s\S]{0,80}\*\*No\*\*/i);
    assert.match(releaseSkill, /Never make another provider or tool call only to[\s\S]{0,20}obtain a human label/i);
    assert.match(releaseSkill, /Vercel task session automatic[\s\S]*Railway remains the one connection blocker/i);
    assert.match(releaseSkill, /(?:Never|Do not manually) fall back[\s\S]*setup-session[\s\S]*discovery-inbox/i);
    assert.match(releaseTaskObservations, /parseTaskObservationDocument/);
    assert.match(releaseInstallation, /codex plugin marketplace upgrade devhub-community[\s\S]*codex plugin add devhub@devhub-community/);
    assert.match(releaseChangelog, /0\.7\.0-alpha\.5[\s\S]*guidance-only[\s\S]*exact verified local workflow contract/i);
    if (!snapshotIsCurrentPublicRoot && manifest.source.state !== "clean") {
      await assert.rejects(
        buildReleaseArtifacts({ snapshot, output: first }),
        /requires a clean public snapshot/,
      );
    }
    await assert.rejects(
      buildReleaseArtifacts({
        snapshot,
        output: path.join(temporary, "wrong-generated-version"),
        allowDirty: true,
        intendedVersion: "0.7.0-alpha.999",
      }),
      /Generated public snapshot application version .* does not match intended application version 0\.7\.0-alpha\.999/,
    );
    await buildReleaseArtifacts({ snapshot, output: first, allowDirty: true });
    await buildReleaseArtifacts({ snapshot, output: second, allowDirty: true });

    const firstFiles = (await readdir(first)).sort();
    assert.deepEqual(firstFiles, (await readdir(second)).sort());
    assert.deepEqual(firstFiles, [
      "RELEASE-EVIDENCE.json",
      "SHA256SUMS",
      `devhub-cli-v${packageVersion}.tar.gz`,
      `devhub-install-v${packageVersion}.mjs`,
      `devhub-self-hosted-v${packageVersion}-sbom.cdx.json`,
      `devhub-self-hosted-v${packageVersion}-source.tar.gz`,
    ]);
    for (const file of firstFiles) {
      assert.deepEqual(await readFile(path.join(first, file)), await readFile(path.join(second, file)));
    }
    const result = await verifyReleaseArtifacts(first);
    assert.equal(result.version, packageVersion);
    assert.equal(result.files, 6);
    await assert.rejects(
      verifyReleaseArtifacts(first, { intendedVersion: "0.7.0-alpha.999" }),
      /Release evidence application version .* does not match intended application version 0\.7\.0-alpha\.999/,
    );

    const evidence = JSON.parse(await readFile(path.join(first, "RELEASE-EVIDENCE.json"), "utf8"));
    assert.equal(evidence.formatVersion, 3);
    assert.deepEqual(evidence.privacy, {
      status: "passed",
      scanner: "scripts/scan-public-export.mjs",
      scopes: ["public-source", "user-runtime"],
      fingerprintPolicySha256: null,
    });

    const legacyV2Evidence = structuredClone(evidence);
    legacyV2Evidence.formatVersion = 2;
    delete legacyV2Evidence.privacy;
    await writeEvidenceContract(first, legacyV2Evidence);
    assert.equal((await verifyReleaseArtifacts(first)).version, packageVersion);

    const v3WithoutPrivacy = structuredClone(evidence);
    delete v3WithoutPrivacy.privacy;
    await writeEvidenceContract(first, v3WithoutPrivacy);
    await assert.rejects(
      verifyReleaseArtifacts(first),
      /Release privacy-scan evidence is invalid/,
    );
    await writeEvidenceContract(first, evidence);
    await verifyReleaseArtifacts(first);

    const runtime = inspectRuntimeArchive(await readFile(path.join(first, evidence.runtime.file)), { allowDirty: true });
    assert.deepEqual(runtime.manifest.privacy, { catalogIncluded: false, profilesIncluded: false });
    assert.equal(runtime.manifest.source.commit, manifest.source.commit);
    assert.ok(runtime.manifest.files.some((entry) => entry.path === "scripts/devhub.mjs"));
    assert.ok(runtime.manifest.files.some((entry) => entry.path.startsWith("node_modules/")));
    assert.ok(runtime.manifest.files.every((entry) => !entry.path.startsWith("catalog/")
      && entry.path !== "config/connection-profiles.json"
      && entry.path !== "public/catalog.json"));
    assert.deepEqual(
      Object.keys(JSON.parse(runtime.files.get("package.json").contents).dependencies),
      ["yaml"],
    );
    const runtimeSbom = JSON.parse(await readFile(path.join(first, evidence.sbom.file), "utf8"));
    assert.equal(runtimeSbom.components.some((component) => new Set(["react", "react-dom"]).has(component.name)), false);
    assert.deepEqual(
      await readFile(path.join(first, evidence.installer.file)),
      await readFile(path.join(snapshot, "scripts/devhub-install.mjs")),
    );

    const sbom = firstFiles.find((file) => file.endsWith("-sbom.cdx.json"));
    await writeFile(path.join(first, sbom), "{}\n");
    await assert.rejects(verifyReleaseArtifacts(first), /digest does not match/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
