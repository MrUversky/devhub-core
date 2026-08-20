#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { buildReleaseArtifacts } from "./release-artifacts.mjs";

const outputIndex = process.argv.indexOf("--output");
const snapshotIndex = process.argv.indexOf("--snapshot");
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
const snapshot = snapshotIndex >= 0 ? process.argv[snapshotIndex + 1] : ".";
const allowDirty = process.argv.includes("--allow-dirty");
const fingerprintIndex = process.argv.indexOf("--fingerprints");
const localFingerprints = path.resolve(import.meta.dirname, "../config/public-export-deny-patterns.txt");
if (fingerprintIndex >= 0 && (!process.argv[fingerprintIndex + 1] || process.argv[fingerprintIndex + 1].startsWith("--"))) {
  throw new Error("--fingerprints requires one file path");
}
const fingerprintFile = fingerprintIndex >= 0
  ? path.resolve(process.argv[fingerprintIndex + 1])
  : existsSync(localFingerprints) ? localFingerprints : null;
if (!output) {
  throw new Error("Usage: npm run release:evidence -- --output <new-or-empty-directory> [--snapshot <public-snapshot>] [--fingerprints <private-deny-patterns>] [--allow-dirty]");
}

const result = await buildReleaseArtifacts({
  snapshot: path.resolve(snapshot),
  output: path.resolve(output),
  allowDirty,
  fingerprintFile,
});
console.log(`release evidence: ${result.files} files for v${result.version} -> ${result.output}`);
