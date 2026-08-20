import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { isWorkflowContract, WORKFLOW_CAPABILITIES, WORKFLOW_CONTRACT_VERSION } from "../lib/workflow-contract.mjs";
import { createAgentSetup } from "../scripts/agent-setup.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "scripts/devhub.mjs");

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

test("agent setup generates client-native read-only plans without literal secrets", () => {
  const endpoint = "https://devhub.example.com/mcp";
  const codex = createAgentSetup(["codex", "--url", endpoint, "--auth", "bearer"]);
  const claude = createAgentSetup(["claude-code", "--url", endpoint, "--auth", "bearer", "--scope", "project"]);
  const cursor = createAgentSetup(["cursor", "--url", endpoint, "--auth", "bearer", "--scope", "project"]);

  assert.equal(codex.readOnly, true);
  assert.match(codex.commands[0], /--bearer-token-env-var DEVHUB_MCP_TOKEN/);
  assert.equal(JSON.parse(claude.files[0].content).mcpServers.devhub.type, "http");
  assert.equal(JSON.parse(claude.files[0].content).mcpServers.devhub.headers.Authorization, "Bearer ${DEVHUB_MCP_TOKEN}");
  assert.equal(cursor.files[0].path, ".cursor/mcp.json");
  assert.equal(JSON.parse(cursor.files[0].content).mcpServers.devhub.headers.Authorization, "Bearer ${env:DEVHUB_MCP_TOKEN}");
  assert.equal(cursor.instruction.path, ".cursor/rules/devhub.mdc");

  for (const plan of [codex, claude, cursor]) {
    const serialized = JSON.stringify(plan);
    assert.doesNotMatch(serialized, /sk-[A-Za-z0-9]|ghp_[A-Za-z0-9]|Bearer [A-Za-z0-9]{32}/);
    assert.match(serialized, /read-only/i);
    assert.match(serialized, /next safe action/i);
  }
});

test("agent setup fails closed for unsafe endpoints and invalid client settings", () => {
  assert.throws(() => createAgentSetup(["other", "--url", "https://devhub.example.com/mcp"]), /client must be/);
  assert.throws(() => createAgentSetup(["cursor", "--url", "http://devhub.example.com/mcp"]), /must use HTTPS/);
  assert.throws(() => createAgentSetup(["cursor", "--url", "https://user:pass@devhub.example.com/mcp"]), /cannot contain credentials/);
  assert.throws(() => createAgentSetup(["claude-code", "--url", "https://devhub.example.com/"]), /\/mcp endpoint/);
  assert.throws(() => createAgentSetup(["codex", "--url", "https://devhub.example.com/mcp", "--scope", "project"]), /not supported/);
  assert.throws(() => createAgentSetup(["cursor", "--url", "https://devhub.example.com/mcp", "--token-env", "bad-name"]), /uppercase environment/);
});

test("shipped Claude Code and Cursor templates are parseable and preserve the workflow boundary", async () => {
  const files = [
    "integrations/claude-code/mcp.network.json",
    "integrations/claude-code/mcp.bearer.json",
    "integrations/cursor/mcp.network.json",
    "integrations/cursor/mcp.bearer.json",
  ];
  for (const file of files) {
    const document = JSON.parse(await readFile(path.join(root, file), "utf8"));
    assert.deepEqual(Object.keys(document.mcpServers), ["devhub"]);
    assert.match(document.mcpServers.devhub.url, /devhub\.example\.com\/mcp/);
  }
  const claudePolicy = await readFile(path.join(root, "integrations/claude-code/CLAUDE.md"), "utf8");
  const cursorPolicy = await readFile(path.join(root, "integrations/cursor/devhub.mdc"), "utf8");
  for (const policy of [claudePolicy, cursorPolicy]) {
    assert.match(policy, /devhub setup --json/);
    assert.match(policy, /MCP.*read-only/);
    assert.match(policy, /Never put tokens/);
    assert.match(policy, /review before apply, commit, publish, restart, rollback/);
  }
});

test("shipped DevHub skill runs selected safe checks before conversational blockers", async () => {
  const skill = await readFile(path.join(root, "plugins/devhub/skills/devhub-registry/SKILL.md"), "utf8");
  assert.match(skill, /selection itself[\s\S]{0,30}as permission for supported safe read-only checks[\s\S]*Never call[\s\S]*unselected source/i);
  assert.match(skill, /Before showing any connection action, exhaust[\s\S]*reviewed exact profiles[\s\S]*current computer[\s\S]*already[\s\S]*signed-in provider tools/i);
  assert.match(skill, /do not ask the[\s\S]*user to run the CLI, assemble JSON or interpret machine output/i);
  assert.match(skill, /lead with human progress: \*\*N of M sources are ready\.\*\*/i);
  assert.match(skill, /\*\*Checked now:\*\*[\s\S]*\*\*Saved connection:\*\*/i);
  assert.match(skill, /\*\*Saved connection:\*\* \*\*Yes\*\* for a current reviewed reusable connection/i);
  assert.match(skill, /\*\*Yes · needs recheck\*\* for an existing reviewed profile[\s\S]{0,80}reconnect, stale or authorization-required/i);
  assert.match(skill, /\*\*No\*\* for task-only access or[\s\S]{0,30}no reviewed profile exists/i);
  assert.match(skill, /Never describe an existing stale profile as[\s\S]{0,30}\*\*No\*\*/i);
  assert.match(skill, /Never make another provider or tool call only to[\s\S]{0,20}obtain a human label[\s\S]*source display name[\s\S]*aggregate count/i);
  assert.match(skill, /One exact recognizable scope continues automatically/i);
  assert.match(skill, /task-scoped plugin[\s\S]*bounded read automatically[\s\S]*transient review-only candidates/i);
  assert.match(skill, /Only multiple scopes or new authorization may block/i);
  assert.match(skill, /Do not show \*\*Use current[\s\S]{0,20}sign-in\*\*[\s\S]*before[\s\S]*automatic checks/i);
  assert.match(skill, /passwords, MFA, consent, one-time[\s\S]*never ask the[\s\S]{0,20}user to paste them into chat/i);
  assert.match(skill, /Planned, unsupported and binding-only sources[\s\S]{0,40}never gain an invented[\s\S]{0,40}provider-tool path/i);
  assert.match(skill, /five-source forward-test case[\s\S]*Vercel task session automatic[\s\S]*Saved connection:[*\s]*No[\s\S]*Railway remains the one connection blocker[\s\S]*exactly one Railway[\s\S]*question/i);
  assert.match(skill, /Save <source> for future refresh[\s\S]*optional[\s\S]*non-blocking/i);
  assert.match(skill, /known matches by count[\s\S]*possible matches with reasons[\s\S]*group[\s\S]{0,20}new candidates by source\/count/i);
  assert.match(skill, /Never merge or deploy automatically/i);
});

test("shipped DevHub skill keeps task observations in one canonical internal run", async () => {
  const skill = await readFile(path.join(root, "plugins/devhub/skills/devhub-registry/SKILL.md"), "utf8");
  assert.match(skill, /workflow contract v2[\s\S]*taskObservation: 1/i);
  assert.match(skill, /connector-owned task-observation bridge registry/i);
  assert.match(skill, /bridge only defines a safe normalization boundary[\s\S]*does not[\s\S]*prove[\s\S]*(?:plugin|signed-in session)[\s\S]*callable/i);
  assert.match(skill, /full canonical selection[\s\S]*1\.\.N unique eligible observations[\s\S]*canonical order/i);
  assert.match(skill, /Never include raw provider IDs, URLs, metadata, credentials,[\s\S]*locators or secrets/i);
  assert.match(skill, /devhub setup-run --sources <canonical-comma-list> --task-observation[\s\S]*<absolute-transient-file> --json/i);
  assert.match(skill, /Do not run a baseline setup-run first/i);
  assert.match(skill, /Saved profiles collect once[\s\S]*task-observed sources perform zero provider and credential I\/O[\s\S]*one Discovery artifact/i);
  assert.match(skill, /checkedThisTask[\s\S]*per-source reviewed-profile existence[\s\S]*Aggregate saved\/task-only counts[\s\S]*not a substitute/i);
  assert.match(skill, /possible, new or unknown[\s\S]*never an exact match/i);
  assert.match(skill, /connection-review[\s\S]*Never[\s\S]*combine[\s\S]*task observations/i);
  assert.match(skill, /Offer task-[\s\S]*source persistence only after this triage[\s\S]*optional action/i);
});

test("active generic plugin release requires the verified workflow and instance marketplace", async () => {
  const publicSnapshot = await exists(path.join(root, "PUBLIC_EXPORT_MANIFEST.json"));
  const [pluginSource, packageSource, skill, installation, codexInstallation] = await Promise.all([
    "plugins/devhub/.codex-plugin/plugin.json",
    "package.json",
    "plugins/devhub/skills/devhub-registry/SKILL.md",
    "docs/INSTALLATION.md",
    "docs/INTEGRATIONS_CODEX.md",
  ].map((file) => readFile(path.join(root, file), "utf8")));
  const plugin = JSON.parse(pluginSource);
  const packageDocument = JSON.parse(packageSource);
  const marketplace = publicSnapshot ? "devhub-community" : "devhub-team";
  const otherMarketplace = publicSnapshot ? "devhub-team" : "devhub-community";

  assert.equal(plugin.name, "devhub");
  assert.equal(plugin.version, "0.7.0-alpha.5");
  assert.equal(packageDocument.version, "1.0.0-rc.2");
  assert.match(skill, /devhub doctor --workflow --json/);
  assert.match(skill, /contract version 2[\s\S]*setupRun: 1[\s\S]*connectionReview: 1[\s\S]*guidedConfirmation: 1[\s\S]*taskObservation: 1/);
  assert.match(skill, /(?:Never|Do not manually) fall back[\s\S]*setup-session[\s\S]*discovery-inbox/i);
  const upgradeIndex = installation.indexOf(`codex plugin marketplace upgrade ${marketplace}`);
  const reinstallIndex = installation.indexOf(`codex plugin add devhub@${marketplace}`);
  assert.notEqual(upgradeIndex, -1);
  assert.notEqual(reinstallIndex, -1);
  assert.ok(upgradeIndex < reinstallIndex);
  assert.doesNotMatch(installation, new RegExp(`(?:upgrade |devhub@)${otherMarketplace}`));
  assert.match(installation, /Restart Codex and start a new task[\s\S]*guidance only/i);
  assert.match(
    codexInstallation,
    new RegExp(`0\\.7\\.0-alpha\\.5[\\s\\S]*codex plugin marketplace upgrade ${marketplace}[\\s\\S]*codex plugin add devhub@${marketplace}`),
  );
  assert.match(codexInstallation, /Restart Codex and start a new task[\s\S]*guidance(?:-| )only[\s\S]*devhub doctor --workflow --json/i);

  const privateProfilePath = path.join(root, "plugins/devhub-private-profile/.codex-plugin/plugin.json");
  if (publicSnapshot) {
    assert.equal(await exists(privateProfilePath), false);
  } else {
    assert.equal(JSON.parse(await readFile(privateProfilePath, "utf8")).version, "0.7.0-alpha.1");
  }
});

test("agent-facing setup accepts only the exact local workflow contract", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    cli,
    "doctor",
    "--workflow",
    "--json",
  ], {
    cwd: root,
    env: { ...process.env, DEVHUB_CATALOG_DIR: path.join(root, ".workflow-contract-must-not-read") },
  });
  const contract = JSON.parse(stdout);
  assert.equal(stderr, "");
  assert.equal(isWorkflowContract(contract), true);
  assert.equal(contract.contractVersion, WORKFLOW_CONTRACT_VERSION);
  assert.deepEqual(contract.capabilities, WORKFLOW_CAPABILITIES);
  assert.equal(isWorkflowContract({ ...contract, capabilities: { ...contract.capabilities, setupRun: 0 } }), false);
  assert.equal(isWorkflowContract({
    ...contract,
    contractVersion: 1,
    capabilities: { setupRun: 1, connectionReview: 1, guidedConfirmation: 1 },
  }), false);
  assert.equal(isWorkflowContract({ ...contract, extra: true }), false);

  const source = await readFile(path.join(root, "lib/workflow-contract.mjs"), "utf8");
  assert.doesNotMatch(source, /catalog|provider|credential|setup-session|discovery-inbox/i);
});

test("shipped guidance verifies runtime origin before Connected Setup", async () => {
  const documents = await Promise.all([
    "plugins/devhub/skills/devhub-registry/SKILL.md",
    "docs/INTEGRATIONS_AGENTS.md",
    "docs/INSTALLATION.md",
    "docs/SETUP_RUN.md",
  ].map((file) => readFile(path.join(root, file), "utf8")));

  for (const document of documents) {
    assert.match(document, /prefer[\s\S]{0,120}user-wide\s+`devhub`[\s\S]*devhub doctor --workflow --json/i);
    assert.match(document, /explicitly supplied/i);
    assert.match(document, /npm run devhub -- doctor --workflow --json/i);
    assert.match(document, /(?:current working directory[\s\S]{0,60}not\s+supply|current directory[\s\S]{0,60}not enough|(?:Do not|Never) (?:select|choose)[\s\S]{0,100}current directory)/i);
    assert.match(document, /contract version 2[\s\S]*setupRun: 1[\s\S]*connectionReview: 1[\s\S]*guidedConfirmation: 1[\s\S]*taskObservation: 1/i);
    assert.match(document, /(?=[\s\S]*plugin[\s\S]*(?:guidance only|guidance-only))(?=[\s\S]*MCP[\s\S]*(?:read-only|local setup runtime))/i);
    assert.match(document, /any-project[\s\S]*(?:user-wide|capability-verified)|any project[\s\S]*user-wide/i);
    assert.match(document, /DevHub needs an\s+update[\s\S]*Help me update DevHub[\s\S]*Not now/i);
    assert.match(document, /(?:zero|no|performs no) provider I\/O/i);
    assert.match(document, /(?:Do not|never)[\s\S]*(?:fall back|substitute|compatibility fallback|manually compose)[\s\S]*setup-session[\s\S]*discovery-inbox/i);
  }
});

test("shipped guidance keeps task observations useful but separate from reusable access", async () => {
  const documents = await Promise.all([
    "plugins/devhub/skills/devhub-registry/SKILL.md",
    "docs/INTEGRATIONS_AGENTS.md",
    "docs/SETUP_RUN.md",
  ].map((file) => readFile(path.join(root, file), "utf8")));

  for (const document of documents) {
    assert.match(document, /task-(?:scoped|only)[\s\S]*(?:bounded read|observation)[\s\S]*review-only candidates/i);
    assert.match(document, /Saved connection:[*\s]*No/i);
    assert.match(document, /(?:Saved connection:[*\s]*Yes[\s\S]{0,100}current reviewed|current reviewed[\s\S]{0,100}Saved connection:[*\s]*Yes)/i);
    assert.match(document, /(?:Yes · needs recheck[\s\S]{0,120}(?:existing )?reviewed profile|(?:existing )?reviewed profile[\s\S]{0,120}Yes · needs recheck)/i);
    assert.match(document, /(?:stale reviewed profile|existing stale profile)[\s\S]{0,80}(?:never|not)[\s\S]{0,25}(?:described as |into )?(?:not saved|\*\*No\*\*)/i);
    assert.match(document, /(?:Never make another|do not call a|never make another)[\s\S]{0,30}(?:provider or tool|provider)[\s\S]{0,35}(?:obtain|get)[\s\S]{0,30}(?:human )?label/i);
    assert.match(document, /(?:never becomes a profile|are not profiles)[\s\S]{0,40}(?:or )?catalog truth/i);
    assert.match(document, /Save[\s\S]{0,10}<source>[\s\S]{0,30}future[\s\S]{0,30}refresh[\s\S]*optional[\s\S]*non-blocking/i);
    assert.match(document, /(?:Only if the user chooses it|Choosing it)[\s\S]*(?:confirmation|exact-scope review)/i);
    for (const term of [/JSON/i, /profile IDs?/i, /raw scope IDs?/i, /schemas?/i, /credential references?|locators?/i]) {
      assert.match(document, term);
    }
    assert.match(document, /(?:never permits|never implies|Never infer)[\s\S]*Save and continue[\s\S]*profile[\s\S]{0,20}proposal[\s\S]*hidden write/i);
  }
  assert.match(documents[0], /provider-specific[\s\S]*connector-owned (?:contract|capability)/i);
  assert.match(documents[1], /Provider-specific behavior[\s\S]*connector-owned capability/i);
});

test("shipped setup guidance asks only after automatic selected-source checks", async () => {
  const documents = await Promise.all([
    "plugins/devhub/skills/devhub-registry/SKILL.md",
    "docs/INTEGRATIONS_AGENTS.md",
    "docs/SETUP_RUN.md",
  ].map((file) => readFile(path.join(root, file), "utf8")));

  for (const document of documents) {
    assert.match(document, /(?:selection|selected source list)[\s\S]{0,80}(?:authorizes|permission for)[\s\S]{0,80}(?:supported )?safe[\s\S]{0,5}read-only checks/i);
    assert.match(document, /(?:Before showing|before showing)[\s\S]*(?:connection action|connection card)[\s\S]*(?:exhaust|automatic checks)/i);
    assert.match(document, /One (?:exact )?recognizable scope continues automatically/i);
    assert.match(document, /(?:If )?several[\s\S]{0,30}scopes[\s\S]{0,120}(?:exactly )?one[\s\S]{0,80}(?:plain-language|recognizable)[\s\S]{0,5}(?:scope )?choice/i);
    assert.match(document, /Only[\s\S]{0,20}(?:several|multiple)[\s\S]{0,10}scopes[\s\S]{0,20}new authorization[\s\S]{0,30}block/i);
    assert.match(document, /password[\s\S]*MFA[\s\S]*consent[\s\S]*(?:one-time|new-token)[\s\S]*(?:provider|operating-system UI|outside chat)/i);
    assert.match(document, /five-source forward-test case[\s\S]*Vercel[\s\S]{0,100}(?:automatic|automatically)[\s\S]*Railway[\s\S]{0,80}(?:one connection blocker|one Railway question)/i);
  }
});

test("CLI returns a machine-readable setup plan and never writes client files", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    cli,
    "agent-setup",
    "cursor",
    "--url",
    "https://devhub.example.com/mcp",
    "--scope",
    "project",
    "--json",
  ], { cwd: root });
  assert.equal(stderr, "");
  const result = JSON.parse(stdout);
  assert.equal(result.command, "agent-setup");
  assert.equal(result.readOnly, true);
  assert.equal(result.client, "cursor");
  assert.equal(result.files[0].path, ".cursor/mcp.json");
});
