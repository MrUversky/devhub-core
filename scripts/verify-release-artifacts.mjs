#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { verifyReleaseArtifacts } from "./release-artifacts.mjs";

const target = path.resolve(process.argv[2] ?? ".");
const result = await verifyReleaseArtifacts(target);
console.log(`release evidence: verified (${result.files} files, v${result.version}, ${result.source.commit ?? "commit unavailable"})`);
