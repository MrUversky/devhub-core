import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { isCloudBackedPath } from "./devhub-install.mjs";

const execFileAsync = promisify(execFile);

async function closestExistingPath(filename) {
  let current = path.resolve(filename);
  while (current !== path.dirname(current)) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if (error?.code !== "ENOENT") return current;
      current = path.dirname(current);
    }
  }
  return current;
}

async function readMacPathMetadata(filename, run = execFileAsync) {
  if (process.platform !== "darwin") return "";
  const target = await closestExistingPath(filename);
  const commands = [
    ["/bin/ls", ["-ldO", target]],
  ];
  const values = [];
  for (const [file, args] of commands) {
    try {
      const { stdout, stderr } = await run(file, args, {
        encoding: "utf8",
        timeout: 1_000,
        maxBuffer: 64 * 1024,
      });
      values.push(stdout, stderr);
    } catch {
      // A metadata probe is advisory. Path-based classification still runs.
    }
  }
  return values.join("\n");
}

export async function collectInstallDoctor({ packageVersion, runtimePath, paths }, options = {}) {
  const inspected = [
    { subject: "runtime", value: path.resolve(runtimePath), deadlineSensitive: true },
    { subject: "catalog", value: paths.catalogDirectory, deadlineSensitive: true },
    { subject: "connection-profiles", value: paths.connectionProfilesPath, deadlineSensitive: false },
  ];
  const findings = [];
  if (!paths.installed) {
    findings.push({
      severity: "warning",
      code: "runtime-not-user-wide",
      subject: "runtime",
      message: "This command is running from a checkout, not a pinned user-wide runtime.",
    });
  }
  for (const item of inspected) {
    const metadata = await (options.readMetadata ?? readMacPathMetadata)(item.value);
    if (isCloudBackedPath(item.value, { ...options, metadata })) {
      findings.push({
        severity: "warning",
        code: "fileprovider-path",
        subject: item.subject,
        path: item.value,
        message: item.deadlineSensitive
          ? `Deadline-sensitive ${item.subject} is on a FileProvider or cloud-backed path.`
          : `${item.subject} is on a FileProvider or cloud-backed path.`,
      });
    }
  }
  return Object.freeze({
    version: 1,
    command: "doctor-install",
    readOnly: true,
    cliVersion: packageVersion,
    installedRuntime: paths.installed,
    runtimePath: path.resolve(runtimePath),
    catalogPath: paths.catalogDirectory,
    connectionProfilesPath: paths.connectionProfilesPath,
    instanceConfigPath: paths.instanceConfigPath,
    generatedPaths: paths.generatedOutputs,
    findings: Object.freeze(findings),
  });
}

export function formatInstallDoctor(result) {
  const lines = [
    `DevHub CLI: ${result.cliVersion}`,
    `Runtime: ${result.runtimePath}`,
    `Catalog: ${result.catalogPath}`,
    `Connection profiles: ${result.connectionProfilesPath}`,
    `Instance config: ${result.instanceConfigPath ?? "checkout defaults"}`,
    `Generated output: ${result.generatedPaths.join(", ")}`,
  ];
  if (!result.findings.length) lines.push("Install doctor found no path warnings.");
  else result.findings.forEach((finding) => lines.push(`${finding.severity.toUpperCase()} ${finding.code}: ${finding.message}`));
  return lines.join("\n");
}
