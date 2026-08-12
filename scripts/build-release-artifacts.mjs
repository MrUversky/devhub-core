#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { buildReleaseArtifacts } from "./release-artifacts.mjs";

const outputIndex = process.argv.indexOf("--output");
const snapshotIndex = process.argv.indexOf("--snapshot");
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
const snapshot = snapshotIndex >= 0 ? process.argv[snapshotIndex + 1] : ".";
const allowDirty = process.argv.includes("--allow-dirty");
if (!output) {
  throw new Error("Usage: npm run release:evidence -- --output <new-or-empty-directory> [--snapshot <public-snapshot>] [--allow-dirty]");
}

const result = await buildReleaseArtifacts({
  snapshot: path.resolve(snapshot),
  output: path.resolve(output),
  allowDirty,
});
console.log(`release evidence: ${result.files} files for v${result.version} -> ${result.output}`);
