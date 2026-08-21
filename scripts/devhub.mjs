#!/usr/bin/env node
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import packageDocument from "../package.json" with { type: "json" };
import { createWorkflowContract } from "../lib/workflow-contract.mjs";
import { collectDoctorFindings, readSourceCatalog } from "./catalog-tools.mjs";
import { AgentSetupError, createAgentSetup, formatAgentSetup } from "./agent-setup.mjs";
import { ConnectedSetupError, createConnectedSetup, formatConnectedSetup } from "./connected-setup.mjs";
import {
  formatSetupSession,
  readConnectionProfileDocument,
  runConnectedSetupSession,
} from "./setup-session.mjs";
import { SetupSessionError } from "../lib/setup-session.mjs";
import { SetupStateError } from "../lib/setup-state.mjs";
import {
  compareSetupRefreshFiles,
  evaluateSetupStateFiles,
  formatConnectionDisconnect,
  formatSetupRefresh,
  formatSetupState,
  parseSetupStateCliArguments,
  proposeConnectionDisconnectFiles,
} from "./setup-state.mjs";
import { DiscoveryInboxError } from "../lib/discovery-inbox.mjs";
import { SetupRunError } from "../lib/setup-run.mjs";
import { formatDiscoveryInbox, runDiscoveryInbox } from "./discovery-inbox.mjs";
import { formatSetupRun, runSetupRun } from "./setup-run.mjs";
import {
  collectEvidenceBindings,
  EvidenceCollectionError,
  formatEvidenceCollection,
  readEvidenceBindingDocument,
} from "./evidence-collection.mjs";
import {
  CatalogInitError,
  formatCatalogInit,
  initializeCatalog,
  parseCatalogInitArguments,
} from "./catalog-init.mjs";
import {
  DevHubConfigError,
  isInstalledRuntimeRoot,
  loadDevHubPaths,
  parseGlobalPathArguments,
  resolveDevHubPaths,
  runtimeHostId,
} from "./devhub-config.mjs";
import { collectInstallDoctor, formatInstallDoctor } from "./install-doctor.mjs";
import { formatHostInspection, HostInspectionError } from "./host-inspection.mjs";
import { runIsolatedHostInspection, unavailableHostInspection } from "./host-inspection-process.mjs";
import { LocalDiscoveryError } from "../lib/local-discovery.mjs";
import { runLocalDiscoveryInbox } from "./local-discovery.mjs";
import { OnboardError } from "../lib/onboard.mjs";
import { formatOnboardPlan, runOnboard } from "./onboard.mjs";
import { formatOnboardApply, OnboardApplyError, runOnboardApply } from "./onboard-apply.mjs";
import {
  formatHostMonitoringSetup,
  HostMonitoringSetupError,
  runHostMonitoringSetup,
} from "./host-monitoring-setup.mjs";
import { formatPortfolioReview, reviewPortfolio } from "./portfolio-review.mjs";
import {
  formatProviderInventory,
  ProviderInventoryError,
  readProviderInventoryDocument,
  runProviderInventory,
} from "./provider-inventory.mjs";
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
const execFileAsync = promisify(execFile);
const [command, ...rawArguments] = process.argv.slice(2);
const json = rawArguments.includes("--json");
let args = rawArguments;
let flags = new Set();
let positionals = [];
let rawTarget = null;
let target = process.cwd();
let paths = null;

function usage() {
  console.log(`DevHub registry helper

Usage:
  npm run devhub -- init-catalog <destination> --host-id <id> --host-name <name> --host-kind <mac|windows|linux|cloud> --host-location <local|remote|cloud> [--apply] [--json]
  npm run devhub -- agent-setup <codex|claude-code|cursor> --url <https://host/mcp> [--auth network|bearer] [--token-env NAME] [--scope user|project|local] [--json]
  npm run devhub -- setup [--json]
  npm run devhub -- setup-run --sources github,local-host,vercel,railway,openai [--connection-review /absolute/reviewed-answers.json] [--deadline-ms 30000] [--json]
  npm run devhub -- onboard --sources github,local-host [--root /absolute/selected/root ...] [--host-id reviewed-host] [--task-observation /absolute/transient.json] [--review /absolute/discovery-review.json] [--deadline-ms 30000] [--json]
  npm run devhub -- onboard-apply /absolute/approved-onboard-plan.json [--apply] [--json]
  npm run devhub -- setup-session <profiles.json> [--json]
  npm run devhub -- setup-state <profiles.json> <session.json> [--availability-review <review.json>] [--discovery-review <review.json>] [--json]
  npm run devhub -- setup-refresh <profiles.json> <previous-session.json> <current-session.json> [--json]
  npm run devhub -- setup-disconnect <profiles.json> <profile-id> <request.json> [--json]
  npm run devhub -- discovery-inbox <profiles.json> <session.json> [review.json] [--json]
  npm run devhub -- init <project-directory>
  npm run devhub -- overlay <project-id>
  npm run devhub -- propose-overlay <project-directory> [stable-id] [--json]
  npm run devhub -- register <project-directory>
  npm run devhub -- validate [--check]
  npm run devhub -- doctor [--workflow --json | --install [--json]]
  npm run devhub -- collect-evidence <binding.json> [--json]
  npm run devhub -- inventory <binding.json> [--json]
  npm run devhub -- review-portfolio [--json] [--evidence-binding <binding.json> ...]
  npm run devhub -- discover-local <host-id> --root /absolute/path [--root /another/path ...] [--max-depth N] [--max-entries N] [--max-bytes N] [--deadline-ms N] [--review <review.json>] [--json]
  npm run devhub -- inspect-host [host-id] [--json]
  npm run devhub -- setup-host-monitoring [host-id] [--apply] [--json]
  npm run devhub -- diff <project-directory> [--json]
  npm run devhub -- reconcile <project-directory> [--json] [--apply]

init-catalog plans a deterministic starter catalog; --apply creates it only when the destination is absent or empty.
agent-setup prints a client-specific, non-mutating MCP and workflow setup plan. It never writes credentials or client configuration.
setup detects only local CLI/config markers and prints a connector plus Build-my-map plan. It never reads credentials, starts authorization, contacts providers or changes the catalog.
setup-run plans locally, rechecks reviewed exact profiles for selected setup-capable sources, runs one planning-inclusive bounded read-only session and returns one artifact-bound review. A strict --connection-review continuation may unlock only answered Vercel/Railway questions and returns stdout-only profile proposals without writes.
onboard composes the catalog initializer, setup-run, bounded local discovery, Discovery Inbox and validation into one versioned review plan. It is always a preview and never writes.
onboard-apply previews an exact plan/repository/revision transaction by default. --apply creates one verified local codex/... proposal branch in a temporary worktree; it never pushes, merges, deploys or edits a project repository.
setup-session runs one bounded, read-only GitHub, Vercel, Railway, OpenAI or local-host observation from reviewed profiles; environment, macOS Keychain and 1Password references are resolved ephemerally, then the process exits without saving a session.
setup-state verifies completion from reviewed profiles and a strict setup-session artifact; optional availability and discovery reviews remain read-only inputs, and the Discovery Inbox is rebuilt internally.
setup-refresh compares two strict setup-session artifacts using the same reviewed profiles and never infers deletion.
setup-disconnect prints a reviewed profile-change proposal and never changes profiles, catalog records or provider resources.
discovery-inbox strictly revalidates profiles plus a setup-session artifact, then prints deterministic matches, human questions and explicitly reviewed stdout-only YAML proposals; it never writes the catalog.
init creates <project>/.devhub/project.yaml from the template.
overlay creates a DevHub-only manifest without modifying the project.
propose-overlay prints an evidence-backed candidate without modifying the project or live catalog.
register copies that manifest into DevHub's reviewed central catalog.
validate rebuilds the catalog; --check verifies generated files without writing.
doctor reports actionable catalog debt without changing files. --workflow --json prints only the non-secret local workflow compatibility contract without reading the catalog or contacting providers.
doctor --install reports the CLI/runtime/catalog/profile/generated paths and warns about FileProvider or cloud-backed placement without reading credential values.
collect-evidence refreshes exact reviewed provider bindings without changing the catalog or provider.
inventory enumerates one bounded reviewed provider scope and prints reconciliation candidates without writing or applying them.
review-portfolio builds an evidence-backed readiness, recovery and provider-drift queue without scanning or changing anything.
--evidence-binding is repeatable and collects only through registered read-only adapters.
discover-local scans only explicit roots on one reviewed macOS or Linux host, emits redacted review-only candidates through Discovery Inbox, and writes nothing.
inspect-host performs one-shot read-only matching against reviewed local runtime evidence.
setup-host-monitoring previews reviewed path-scoped Tailscale Serve health routes for this host. --apply adds only missing exact paths; it never enables Funnel, resets Serve, stores credentials or installs a resident agent.
diff reports field-level semantic drift; exit 0 means clean, 2 drift and 3 invalid.
reconcile is a reviewed dry-run plan by default. --apply explicitly refreshes an eligible native record.`);
  console.log(`
Global path options (after the command):
  --catalog-dir /absolute/path
  --connection-profiles-file /absolute/path
  --generated-dir /absolute/path
  --instance-config /absolute/path

Precedence is command options, environment, strict instance configuration, then installed XDG or checkout defaults.`);
}

async function runCompiler({ check = false, quiet = false } = {}) {
  const environment = { ...process.env };
  environment.DEVHUB_CATALOG_DIR = paths.catalogDirectory;
  environment.DEVHUB_CONNECTION_PROFILES_FILE = paths.connectionProfilesPath;
  if (paths.generatedDirectory) environment.DEVHUB_GENERATED_DIR = paths.generatedDirectory;
  else delete environment.DEVHUB_GENERATED_DIR;
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

function parseDoctorArguments(argumentsList) {
  const supported = new Set(["--json", "--workflow", "--install"]);
  const seen = new Set();
  for (const argument of argumentsList) {
    if (!supported.has(argument) || seen.has(argument)) {
      const error = new Error("doctor accepts only one --json flag and optional one --workflow or --install flag");
      error.code = "doctor-arguments-invalid";
      throw error;
    }
    seen.add(argument);
  }
  if (seen.has("--workflow") && !seen.has("--json")) {
    const error = new Error("doctor --workflow requires --json");
    error.code = "doctor-arguments-invalid";
    throw error;
  }
  if (seen.has("--workflow") && seen.has("--install")) {
    const error = new Error("doctor accepts --workflow or --install, not both");
    error.code = "doctor-arguments-invalid";
    throw error;
  }
  return Object.freeze({ json: seen.has("--json"), workflow: seen.has("--workflow"), install: seen.has("--install") });
}

function optionValues(argumentsList, option) {
  const values = [];
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument.startsWith(`${option}=`)) {
      const value = argument.slice(option.length + 1);
      if (!value) throw new Error(`${option} needs a file path`);
      values.push(value);
    } else if (argument === option) {
      const value = argumentsList[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${option} needs a file path`);
      values.push(value);
      index += 1;
    }
  }
  return values;
}

try {
  const parsedPaths = parseGlobalPathArguments(rawArguments);
  args = [...parsedPaths.args];
  flags = new Set(args.filter((argument) => argument.startsWith("--")));
  positionals = args.filter((argument) => !argument.startsWith("--"));
  rawTarget = positionals[0] ?? null;
  target = path.resolve(rawTarget || process.cwd());
  const workflowDoctor = command === "doctor" && args.includes("--workflow");
  paths = workflowDoctor
    ? resolveDevHubPaths(root, process.env, { installed: isInstalledRuntimeRoot(root), pathOptions: parsedPaths.pathOptions })
    : await loadDevHubPaths(root, process.env, { pathOptions: parsedPaths.pathOptions });
if (!command || command === "help" || command === "--help") {
  usage();
} else if (command === "init-catalog") {
  const initOptions = parseCatalogInitArguments(args);
  const result = await initializeCatalog(initOptions);
  if (initOptions.json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatCatalogInit(result));
} else if (command === "agent-setup") {
  const setup = createAgentSetup(args);
  if (json) console.log(JSON.stringify(setup, null, 2));
  else console.log(formatAgentSetup(setup));
} else if (command === "setup") {
  if (args.some((argument) => argument !== "--json")) throw new ConnectedSetupError("setup-arguments-invalid", "setup accepts only --json");
  const setup = await createConnectedSetup();
  if (json) console.log(JSON.stringify(setup, null, 2));
  else console.log(formatConnectedSetup(setup));
} else if (command === "setup-run") {
  const { parsed, result } = await runSetupRun(root, args, { paths, environment: process.env });
  if (parsed.json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatSetupRun(result));
} else if (command === "onboard") {
  const { parsed, plan } = await runOnboard(root, args, {
    paths,
    environment: process.env,
    runtimeVersion: packageDocument.version,
  });
  if (parsed.json) console.log(JSON.stringify(plan, null, 2));
  else console.log(formatOnboardPlan(plan));
} else if (command === "onboard-apply") {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const { parsed, result } = await runOnboardApply(root, args, {
      paths,
      environment: process.env,
      runtimeVersion: packageDocument.version,
      signal: controller.signal,
    });
    if (parsed.json) console.log(JSON.stringify(result, null, 2));
    else console.log(formatOnboardApply(result));
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
} else if (command === "setup-session") {
  if (!rawTarget) throw new SetupSessionError("connection-profile-required", "setup-session needs a reviewed connection profile JSON file");
  if (positionals.length !== 1 || args.some((argument) => argument.startsWith("--") && argument !== "--json")) {
    throw new SetupSessionError("setup-session-arguments-invalid", "setup-session accepts one profile JSON file and optional --json");
  }
  const document = await readConnectionProfileDocument(target);
  const session = await runConnectedSetupSession(document, { root, paths });
  if (json) console.log(JSON.stringify(session, null, 2));
  else console.log(formatSetupSession(session));
} else if (command === "setup-state") {
  const setupStateArguments = parseSetupStateCliArguments(args);
  const state = await evaluateSetupStateFiles(path.resolve(setupStateArguments.profileFilename), path.resolve(setupStateArguments.sessionFilename), {
    availabilityReviewFilename: setupStateArguments.availabilityReviewFilename ? path.resolve(setupStateArguments.availabilityReviewFilename) : null,
    discoveryReviewFilename: setupStateArguments.discoveryReviewFilename ? path.resolve(setupStateArguments.discoveryReviewFilename) : null,
    root,
    paths,
  });
  if (json) console.log(JSON.stringify(state, null, 2));
  else console.log(formatSetupState(state));
} else if (command === "setup-refresh") {
  if (positionals.length !== 3 || args.some((argument) => argument.startsWith("--") && argument !== "--json")) {
    throw new SetupStateError("setup-refresh-arguments-invalid", "setup-refresh needs profiles, previous-session and current-session JSON files");
  }
  const refresh = await compareSetupRefreshFiles(...positionals.map((filename) => path.resolve(filename)));
  if (json) console.log(JSON.stringify(refresh, null, 2));
  else console.log(formatSetupRefresh(refresh));
} else if (command === "setup-disconnect") {
  if (positionals.length !== 3 || args.some((argument) => argument.startsWith("--") && argument !== "--json")) {
    throw new SetupStateError("setup-disconnect-arguments-invalid", "setup-disconnect needs profiles, profile-id and request JSON files");
  }
  const disconnect = await proposeConnectionDisconnectFiles(path.resolve(positionals[0]), positionals[1], path.resolve(positionals[2]));
  if (json) console.log(JSON.stringify(disconnect, null, 2));
  else console.log(formatConnectionDisconnect(disconnect));
} else if (command === "discovery-inbox") {
  if (positionals.length < 2 || positionals.length > 3 || args.some((argument) => argument.startsWith("--") && argument !== "--json")) {
    throw new DiscoveryInboxError("discovery-inbox-arguments-invalid", "discovery-inbox needs profiles.json, session.json, optional review.json and optional --json");
  }
  const result = await runDiscoveryInbox(root, path.resolve(positionals[0]), path.resolve(positionals[1]), positionals[2] ? path.resolve(positionals[2]) : null, { paths });
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatDiscoveryInbox(result));
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
  const doctorArguments = parseDoctorArguments(args);
  if (doctorArguments.workflow) {
    console.log(JSON.stringify(createWorkflowContract(packageDocument.version), null, 2));
  } else if (doctorArguments.install) {
    const result = await collectInstallDoctor({ packageVersion: packageDocument.version, runtimePath: root, paths });
    if (doctorArguments.json) console.log(JSON.stringify(result, null, 2));
    else console.log(formatInstallDoctor(result));
  } else {
    const sourceCatalog = await readSourceCatalog(root, { paths });
    const currentHostId = runtimeHostId();
    const findings = collectDoctorFindings(sourceCatalog, currentHostId);
    if (doctorArguments.json) console.log(JSON.stringify({ version: 1, command: "doctor", readOnly: true, runtimeHostId: currentHostId, findings }, null, 2));
    else printDoctor(findings);
    if (findings.some((finding) => finding.severity === "error")) process.exitCode = 1;
  }
} else if (command === "collect-evidence") {
  if (!rawTarget) throw new EvidenceCollectionError("binding-required", "collect-evidence needs a binding JSON file");
  const sourceCatalog = await readSourceCatalog(root, { paths });
  const bindings = await readEvidenceBindingDocument(target);
  const collection = await collectEvidenceBindings(sourceCatalog, bindings);
  if (json) console.log(JSON.stringify(collection, null, 2));
  else console.log(formatEvidenceCollection(collection));
} else if (command === "inventory") {
  if (!rawTarget) throw new ProviderInventoryError("binding-required", "inventory needs a binding JSON file");
  const sourceCatalog = await readSourceCatalog(root, { paths });
  const document = await readProviderInventoryDocument(target);
  const inventory = await runProviderInventory(sourceCatalog, document, {
    environment: process.env,
    projectDirectory: paths.projectDirectory,
  });
  if (json) console.log(JSON.stringify(inventory, null, 2));
  else console.log(formatProviderInventory(inventory));
} else if (command === "review-portfolio") {
  const sourceCatalog = await readSourceCatalog(root, { paths });
  if (optionValues(args, "--evidence-fixture").length) {
    throw new EvidenceCollectionError("unsupported-evidence-input", "--evidence-fixture is test-only and is not accepted by the production CLI");
  }
  const bindingPaths = optionValues(args, "--evidence-binding");
  const bindingGroups = await Promise.all(bindingPaths.map((filename) => readEvidenceBindingDocument(path.resolve(filename))));
  const providerEvidence = bindingGroups.length
    ? (await collectEvidenceBindings(sourceCatalog, bindingGroups.flat())).results
    : [];
  const review = reviewPortfolio(sourceCatalog, { providerEvidence });
  if (json) console.log(JSON.stringify(review, null, 2));
  else console.log(formatPortfolioReview(review));
} else if (command === "discover-local") {
  const discovery = await runLocalDiscoveryInbox(root, args, { paths, environment: process.env });
  if (discovery.parsed.json) console.log(JSON.stringify(discovery.result, null, 2));
  else console.log(formatDiscoveryInbox(discovery.result));
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
  const identitySource = rawTarget ? "explicit-argument" : "DEVHUB_HOST_ID";
  const isolated = await runIsolatedHostInspection(root, inspectedHostId, {
    paths,
    identitySource,
  });
  const inspection = isolated.state === "completed"
    ? isolated.inspection
    : unavailableHostInspection(inspectedHostId, identitySource, isolated.observedAt, isolated.state);
  if (json) console.log(JSON.stringify(inspection, null, 2));
  else console.log(formatHostInspection(inspection));
} else if (command === "setup-host-monitoring") {
  const setup = await runHostMonitoringSetup(root, args, { paths, environment: process.env });
  if (setup.parsed.json) console.log(JSON.stringify(setup.result, null, 2));
  else console.log(formatHostMonitoringSetup(setup.result));
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
  const expected = error instanceof ReconciliationApplyError || error instanceof CatalogInitError || error instanceof EvidenceCollectionError || error instanceof ProviderInventoryError || error instanceof AgentSetupError || error instanceof ConnectedSetupError || error instanceof SetupRunError || error instanceof SetupSessionError || error instanceof SetupStateError || error instanceof DiscoveryInboxError || error instanceof LocalDiscoveryError || error instanceof OnboardError || error instanceof OnboardApplyError || error instanceof HostMonitoringSetupError || error instanceof DevHubConfigError;
  const failure = {
    version: 2,
    command: command ?? "unknown",
    readOnly: new Set(["setup", "setup-run", "onboard", "setup-session", "setup-state", "setup-refresh", "setup-disconnect", "discovery-inbox", "discover-local"]).has(command) || (!flags.has("--apply") && !["init", "overlay", "register", "validate"].includes(command)),
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
