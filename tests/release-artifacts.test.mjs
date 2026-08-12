import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { buildReleaseArtifacts, verifyReleaseArtifacts } from "../scripts/release-artifacts.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const packageVersion = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version;

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
    if (!snapshotIsCurrentPublicRoot && manifest.source.state !== "clean") {
      await assert.rejects(
        buildReleaseArtifacts({ snapshot, output: first }),
        /requires a clean public snapshot/,
      );
    }
    await buildReleaseArtifacts({ snapshot, output: first, allowDirty: true });
    await buildReleaseArtifacts({ snapshot, output: second, allowDirty: true });

    const firstFiles = (await readdir(first)).sort();
    assert.deepEqual(firstFiles, (await readdir(second)).sort());
    assert.deepEqual(firstFiles, [
      "RELEASE-EVIDENCE.json",
      "SHA256SUMS",
      `devhub-self-hosted-v${packageVersion}-sbom.cdx.json`,
      `devhub-self-hosted-v${packageVersion}-source.tar.gz`,
    ]);
    for (const file of firstFiles) {
      assert.deepEqual(await readFile(path.join(first, file)), await readFile(path.join(second, file)));
    }
    const result = await verifyReleaseArtifacts(first);
    assert.equal(result.version, packageVersion);
    assert.equal(result.files, 4);

    const sbom = firstFiles.find((file) => file.endsWith("-sbom.cdx.json"));
    await writeFile(path.join(first, sbom), "{}\n");
    await assert.rejects(verifyReleaseArtifacts(first), /digest does not match/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
