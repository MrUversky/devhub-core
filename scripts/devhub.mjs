#!/usr/bin/env node
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { collectDoctorFindings, readSourceCatalog } from "./catalog-tools.mjs";
import { resolveDevHubPaths, runtimeHostId } from "./devhub-config.mjs";
import { formatHostInspection, HostInspectionError, inspectHost } from "./host-inspection.mjs";
import {
  applyNativeReconciliation,
  createOverlayProposal,
  createReconciliationPlan,
  formatOverlayProposal,
  formatReconciliation,
  RECONCILIATION_EXIT,
  ReconciliationApplyError,
  registerNativeManifest,
  withCatalogMutationLock,
} from "./reconciliation.mjs";

const root = path.resolve(import.meta.dirname, "..");
const paths = resolveDevHubPaths(root, process.env);
const execFileAsync = promisify(execFile);
const [command, ...args] = process.argv.slice(2);
const flags = new Set(args.filter((argument) => argument.startsWith("--")));
const positionals = args.filter((argument) => !argument.startsWith("--"));
const rawTarget = positionals[0];
const target = path.resolve(rawTarget || process.cwd());
const json = flags.has("--json");

function usage() {
  console.log(`DevHub registry helper

Usage:
  npm run devhub -- init <project-directory>
  npm run devhub -- overlay <project-id>
  npm run devhub -- propose-overlay <project-directory> [stable-id] [--json]
  npm run devhub -- register <project-directory>
  npm run devhub -- validate [--check]
  npm run devhub -- doctor [--json]
  npm run devhub -- inspect-host [host-id] [--json]
  npm run devhub -- diff <project-directory> [--json]
  npm run devhub -- reconcile <project-directory> [--json] [--apply]

init creates <project>/.devhub/project.yaml from the template.
overlay creates a DevHub-only manifest without modifying the project.
propose-overlay prints an evidence-backed candidate without modifying the project or live catalog.
register copies that manifest into DevHub's reviewed central catalog.
validate rebuilds the catalog; --check verifies generated files without writing.
doctor reports actionable catalog debt without changing files.
inspect-host performs one-shot read-only matching against reviewed local runtime evidence.
diff reports field-level semantic drift; exit 0 means clean, 2 drift and 3 invalid.
reconcile is a reviewed dry-run plan by default. --apply explicitly refreshes an eligible native record.`);
}

async function runCompiler({ check = false, quiet = false } = {}) {
  const environment = { ...process.env };
  if (check) environment.DEVHUB_CATALOG_CHECK = "1";
  else delete environment.DEVHUB_CATALOG_CHECK;
  const { stdout } = await execFileAsync(process.execPath, [path.join(root, "scripts/compile-catalog.mjs")], {
    cwd: paths.root,
    env: environment,
  });
  if (!quiet && stdout.trim()) console.log(stdout.trim());
}

function printDoctor(findings) {
  if (!findings.length) {
    console.log("DevHub doctor found no catalog debt.");
    return;
  }
  for (const finding of findings) {
    console.log(`${finding.severity.toUpperCase()} ${finding.code} ${finding.subject ?? "catalog"}: ${finding.message}`);
  }
  const errors = findings.filter((finding) => finding.severity === "error").length;
  const warnings = findings.length - errors;
  console.log(`DevHub doctor: ${errors} errors, ${warnings} warnings.`);
}

try {
if (!command || command === "help" || command === "--help") {
  usage();
} else if (command === "init") {
  const destinationDirectory = path.join(target, ".devhub");
  const destination = path.join(destinationDirectory, "project.yaml");
  await mkdir(destinationDirectory, { recursive: true });
  try {
    await readFile(destination, "utf8");
    throw new Error(`${destination} already exists`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await copyFile(path.join(root, "templates/project.yaml"), destination);
  console.log(`Created ${destination}`);
  console.log("Edit id, title, host and services, then run: npm run devhub -- register <project-directory>");
} else if (command === "register") {
  const registration = await registerNativeManifest({
    root,
    target,
    paths,
    runCompiler: () => runCompiler({ quiet: true }),
  });
  if (json) console.log(JSON.stringify({ version: 2, command: "register", status: "registered", ...registration }, null, 2));
  else console.log(`Registered ${registration.id} in ${registration.destination}`);
} else if (command === "overlay") {
  if (!rawTarget || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(rawTarget)) {
    throw new Error("overlay needs a lowercase kebab-case project id");
  }
  const destination = path.join(paths.projectDirectory, `${rawTarget}.yaml`);
  try {
    await readFile(destination, "utf8");
    throw new Error(`${destination} already exists`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const template = await readFile(path.join(root, "templates/project.yaml"), "utf8");
  const title = rawTarget
    .split("-")
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join(" ");
  const overlay = template
    .replace("id: change-me", `id: ${rawTarget}`)
    .replace("title: Change me", `title: ${title}`)
    .replace("registration: native", "registration: overlay");
  await writeFile(destination, overlay);
  console.log(`Created DevHub-only overlay ${destination}`);
  console.log("Edit it, then run: npm run devhub -- validate");
} else if (command === "propose-overlay") {
  if (!rawTarget) throw new Error("propose-overlay needs a project directory");
  const proposedId = positionals[1] ?? null;
  const proposal = await createOverlayProposal(root, target, runtimeHostId(), { paths, proposedId });
  if (json) console.log(JSON.stringify(proposal, null, 2));
  else console.log(formatOverlayProposal(proposal));
  process.exitCode = proposal.exitCode;
} else if (command === "validate") {
  if (flags.has("--check")) await runCompiler({ check: true });
  else await withCatalogMutationLock(paths, () => runCompiler());
} else if (command === "doctor") {
  const sourceCatalog = await readSourceCatalog(root, { paths });
  const currentHostId = runtimeHostId();
  const findings = collectDoctorFindings(sourceCatalog, currentHostId);
  if (json) console.log(JSON.stringify({ version: 1, command: "doctor", readOnly: true, runtimeHostId: currentHostId, findings }, null, 2));
  else printDoctor(findings);
  if (findings.some((finding) => finding.severity === "error")) process.exitCode = 1;
} else if (command === "inspect-host") {
  const configuredHostId = runtimeHostId();
  if (rawTarget && configuredHostId && rawTarget !== configuredHostId) {
    throw new HostInspectionError(
      "host-identity-conflict",
      `Requested host ${rawTarget} conflicts with DEVHUB_HOST_ID=${configuredHostId}`,
    );
  }
  const inspectedHostId = rawTarget || configuredHostId;
  if (!inspectedHostId) {
    throw new HostInspectionError("host-required", "inspect-host needs a host id argument or DEVHUB_HOST_ID");
  }
  const inspection = await inspectHost(root, inspectedHostId, {
    paths,
    identitySource: rawTarget ? "explicit-argument" : "DEVHUB_HOST_ID",
  });
  if (json) console.log(JSON.stringify(inspection, null, 2));
  else console.log(formatHostInspection(inspection));
} else if (command === "diff" || command === "reconcile") {
  if (!rawTarget) throw new Error(`${command} needs a project directory`);
  const apply = flags.has("--apply");
  if (command === "diff" && apply) throw new Error("diff is read-only; use reconcile <project-directory> --apply after review");
  const currentHostId = runtimeHostId();
  const reconciliation = apply
    ? await applyNativeReconciliation({
      root,
      target,
      runtimeHostId: currentHostId,
      runCompiler: () => runCompiler({ quiet: true }),
      paths,
    })
    : await createReconciliationPlan(root, target, currentHostId, { paths });
  const result = command === "diff" ? { ...reconciliation, command: "diff" } : reconciliation;
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatReconciliation(result, { diffOnly: command === "diff" }));
  if (!apply) process.exitCode = result.exitCode;
} else {
  usage();
  process.exitCode = 1;
}
} catch (error) {
  const expected = error instanceof ReconciliationApplyError;
  const failure = {
    version: 2,
    command: command ?? "unknown",
    readOnly: !flags.has("--apply") && !["init", "overlay", "register", "validate"].includes(command),
    status: "invalid",
    exitCode: RECONCILIATION_EXIT.invalid,
    error: {
      code: expected ? error.code : error?.code ?? "command-failed",
      message: error instanceof Error ? error.message : String(error),
    },
  };
  if (json) console.log(JSON.stringify(failure, null, 2));
  else console.error(`DevHub ${failure.command} failed: ${failure.error.code} — ${failure.error.message}`);
  process.exitCode = failure.exitCode;
}
