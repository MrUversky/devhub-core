import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { calculateOnboardPlanId } from "../lib/onboard.mjs";
import { resolveDevHubPaths } from "../scripts/devhub-config.mjs";
import { runOnboardApply } from "../scripts/onboard-apply.mjs";
import { runOnboard } from "../scripts/onboard.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "scripts/devhub.mjs");
const supportedLocal = process.platform === "darwin" || process.platform === "linux";
const hostKind = process.platform === "darwin" ? "mac" : "linux";
const NOW = "2026-08-20T08:00:00.000Z";

async function detectGit() {
  if (!supportedLocal) return false;
  try {
    await execFileAsync("git", ["--version"], { timeout: 2_000 });
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

const gitAvailable = await detectGit();
const gitTestOptions = Object.freeze({
  skip: !supportedLocal ? "requires a supported local platform" : !gitAvailable ? "requires Git" : false,
});

async function git(repository, ...args) {
  const { stdout } = await execFileAsync("git", ["-C", repository, ...args], { encoding: "utf8" });
  return stdout.trim();
}

function quietPlanning(temporary) {
  return {
    cwd: temporary,
    homeDirectory: temporary,
    pathValue: "",
    platform: process.platform,
    async access() { throw Object.assign(new Error("absent"), { code: "ENOENT" }); },
    async lstat() { throw Object.assign(new Error("absent"), { code: "ENOENT" }); },
  };
}

async function prepareApprovedPlan({ now = NOW, emptyCatalog = false } = {}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-onboard-apply-test-"));
  const repository = path.join(temporary, "catalog-repository");
  const catalogDirectory = path.join(repository, "catalog");
  const workspace = path.join(temporary, "new-tool-workspace");
  const generatedDirectory = path.join(temporary, "configured-generated-must-stay-absent");
  const profiles = path.join(temporary, "profiles.json");
  const planPath = path.join(temporary, "approved-plan.json");
  await mkdir(workspace, { recursive: true });
  if (!emptyCatalog) {
    await mkdir(path.join(catalogDirectory, "projects"), { recursive: true });
    await writeFile(path.join(catalogDirectory, "hosts.yaml"), `version: 1
hosts:
  - id: reviewed-host
    name: Reviewed host
    kind: ${hostKind}
    location: local
`);
  }
  await writeFile(path.join(workspace, "package.json"), `${JSON.stringify({ name: "new-tool", scripts: {} })}\n`);
  await mkdir(repository, { recursive: true });
  await writeFile(path.join(repository, "README.md"), "fixture catalog repository\n");
  await git(repository, "init", "-b", "main");
  await git(repository, "config", "user.name", "DevHub test");
  await git(repository, "config", "user.email", "devhub-test@example.invalid");
  await git(repository, "add", "--", "README.md", ...(!emptyCatalog ? ["catalog/hosts.yaml"] : []));
  await git(repository, "commit", "-m", "fixture: catalog base");
  const baseRevision = await git(repository, "rev-parse", "HEAD");
  const paths = resolveDevHubPaths(root, {}, {
    pathOptions: { catalogDirectory, connectionProfilesFile: profiles, generatedDirectory },
  });
  const profileDocument = { version: 1, profiles: [{
    version: 1,
    id: "reviewed-github-profile",
    connectorId: "github",
    authorization: { method: "cli-session" },
    scope: { kind: "user", login: "fictional-builder" },
    owner: "Fictional builder",
    state: "connected",
    lastObservedAt: new Date(Date.parse(now) - 30 * 60 * 1000).toISOString(),
    freshForSeconds: 3600,
  }] };
  const connectors = [{
    connectorId: "github",
    collect() {
      return { state: "connected", observedAt: now, observations: [] };
    },
  }];
  const args = ["--sources", "github", "--root", workspace, "--host-id", "reviewed-host", "--json"];
  const options = {
    paths,
    environment: {},
    platform: process.platform,
    hostname: "reviewed-host.example",
    now,
    runtimeVersion: "1.0.0-rc.6",
    profileDocument,
    connectors,
    planning: quietPlanning(temporary),
  };
  const preview = (await runOnboard(root, args, options)).plan;
  const candidate = preview.candidateDecisions.find((decision) => decision.source === "local-host" && decision.kind === "project");
  assert.ok(candidate, "fixture must produce one bounded local project candidate");
  const review = {
    version: 1,
    artifactId: preview.provenance.setupArtifactId,
    decisions: [{
      candidateId: candidate.id,
      reviewedAt: now,
      reviewedBy: "Example reviewer",
      disposition: "new",
      answers: { productIdentity: "New Tool", operatingIntent: "discovery" },
    }],
  };
  const approved = (await runOnboard(root, args, { ...options, discoveryReviewDocument: review })).plan;
  assert.equal(approved.application.eligible, true, JSON.stringify(approved.application.blockers));
  assert.deepEqual(approved.application.blockers, []);
  assert.ok(approved.application.operations.some((operation) => operation.kind === "create-overlay-project"));
  assert.equal(approved.application.operations.some((operation) => operation.kind === "create-starter-catalog"), emptyCatalog);
  assert.equal(approved.provenance.catalog.binding.baseRevision, baseRevision);
  await writeFile(planPath, `${JSON.stringify(approved, null, 2)}\n`);
  return { temporary, repository, catalogDirectory, generatedDirectory, profiles, planPath, paths, plan: approved, baseRevision, now };
}

test("approved onboarding plan previews by default and commits only in an isolated worktree", gitTestOptions, async () => {
  const fixture = await prepareApprovedPlan();
  try {
    const beforeHosts = await readFile(path.join(fixture.catalogDirectory, "hosts.yaml"), "utf8");
    const preview = (await runOnboardApply(root, [fixture.planPath], { paths: fixture.paths, environment: {}, now: fixture.now })).result;
    assert.equal(preview.status, "ready");
    assert.equal(preview.readOnly, true);
    assert.equal(await git(fixture.repository, "branch", "--list", preview.proposal.branch), "");
    await assert.rejects(readdir(fixture.generatedDirectory), { code: "ENOENT" });

    const applied = (await runOnboardApply(root, [fixture.planPath, "--apply"], { paths: fixture.paths, environment: {}, now: fixture.now })).result;
    assert.equal(applied.status, "committed");
    assert.equal(applied.proposal.parent, fixture.baseRevision);
    assert.match(applied.proposal.branch, /^codex\/onboard-[a-f0-9]{16}$/);
    assert.equal(await git(fixture.repository, "rev-parse", "HEAD"), fixture.baseRevision);
    assert.equal(await git(fixture.repository, "status", "--porcelain"), "");
    assert.equal(await readFile(path.join(fixture.catalogDirectory, "hosts.yaml"), "utf8"), beforeHosts);
    await assert.rejects(readFile(path.join(fixture.catalogDirectory, "projects/new-tool.yaml")), { code: "ENOENT" });
    assert.match(await git(fixture.repository, "show", `${applied.proposal.commit}:catalog/projects/new-tool.yaml`), /registration: overlay/);
    assert.equal((await git(fixture.repository, "worktree", "list", "--porcelain")).match(/^worktree /gm)?.length, 1);
    await assert.rejects(readdir(fixture.generatedDirectory), { code: "ENOENT" });

    const repeated = (await runOnboardApply(root, [fixture.planPath, "--apply"], { paths: fixture.paths, environment: {}, now: fixture.now })).result;
    assert.equal(repeated.status, "already-committed");
    assert.equal(repeated.proposal.commit, applied.proposal.commit);
    assert.equal(repeated.verification.find((entry) => entry.id === "generated-catalog-freshness")?.state, "passed");
    assert.equal(repeated.verification.find((entry) => entry.id === "doctor")?.state, "passed");
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("absent catalog apply creates the starter and overlay only on the proposal branch", gitTestOptions, async () => {
  const fixture = await prepareApprovedPlan({ emptyCatalog: true });
  try {
    await assert.rejects(readdir(fixture.catalogDirectory), { code: "ENOENT" });
    const applied = (await runOnboardApply(root, [fixture.planPath, "--apply"], { paths: fixture.paths, environment: {}, now: fixture.now })).result;
    assert.equal(applied.status, "committed");
    assert.equal(await git(fixture.repository, "status", "--porcelain"), "");
    assert.equal(await git(fixture.repository, "rev-parse", "HEAD"), fixture.baseRevision);
    await assert.rejects(readdir(fixture.catalogDirectory), { code: "ENOENT" });
    assert.match(await git(fixture.repository, "show", `${applied.proposal.commit}:catalog/hosts.yaml`), /id: reviewed-host/);
    assert.match(await git(fixture.repository, "show", `${applied.proposal.commit}:catalog/projects/new-tool.yaml`), /registration: overlay/);
    assert.equal((await git(fixture.repository, "worktree", "list", "--porcelain")).match(/^worktree /gm)?.length, 1);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("catalog revision drift fails before any transaction or branch", gitTestOptions, async () => {
  const fixture = await prepareApprovedPlan();
  try {
    await writeFile(path.join(fixture.catalogDirectory, "hosts.yaml"), (await readFile(path.join(fixture.catalogDirectory, "hosts.yaml"), "utf8")).replace("Reviewed host", "Changed host"));
    await git(fixture.repository, "add", "--", "catalog/hosts.yaml");
    await git(fixture.repository, "commit", "-m", "fixture: catalog drift");
    await assert.rejects(
      runOnboardApply(root, [fixture.planPath, "--apply"], { paths: fixture.paths, environment: {}, now: fixture.now }),
      (error) => error.code === "onboard-catalog-drift",
    );
    const branch = `codex/onboard-${fixture.plan.planId.slice(7, 23)}`;
    assert.equal(await git(fixture.repository, "branch", "--list", branch), "");
    assert.equal((await git(fixture.repository, "worktree", "list", "--porcelain")).match(/^worktree /gm)?.length, 1);
    assert.equal(await git(fixture.repository, "status", "--porcelain"), "");
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("active catalog lock blocks a concurrent apply without removing the other transaction lock", gitTestOptions, async () => {
  const fixture = await prepareApprovedPlan();
  const lockPath = path.join(fixture.catalogDirectory, ".devhub-mutation.lock");
  try {
    await writeFile(lockPath, "other transaction\n");
    await assert.rejects(
      runOnboardApply(root, [fixture.planPath, "--apply"], { paths: fixture.paths, environment: {}, now: fixture.now }),
      (error) => error.code === "catalog-locked",
    );
    assert.equal(await readFile(lockPath, "utf8"), "other transaction\n");
    assert.equal((await git(fixture.repository, "worktree", "list", "--porcelain")).match(/^worktree /gm)?.length, 1);
  } finally {
    await rm(lockPath, { force: true });
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("stale approved evidence fails closed before creating a worktree", gitTestOptions, async () => {
  const fixture = await prepareApprovedPlan();
  try {
    const operation = fixture.plan.application.operations.find((entry) => entry.kind === "create-overlay-project");
    const staleNow = new Date(Date.parse(operation.evidence.validUntil) + 1).toISOString();
    await assert.rejects(
      runOnboardApply(root, [fixture.planPath, "--apply"], { paths: fixture.paths, environment: {}, now: staleNow }),
      (error) => error.code === "onboard-apply-blocked" && /approved-evidence-stale/.test(error.message),
    );
    const branch = `codex/onboard-${fixture.plan.planId.slice(7, 23)}`;
    assert.equal(await git(fixture.repository, "branch", "--list", branch), "");
    assert.equal((await git(fixture.repository, "worktree", "list", "--porcelain")).match(/^worktree /gm)?.length, 1);
    assert.equal(await git(fixture.repository, "status", "--porcelain"), "");
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("runtime drift and repository-escaping generated paths fail closed", gitTestOptions, async () => {
  const fixture = await prepareApprovedPlan();
  try {
    const preview = (await runOnboardApply(root, [fixture.planPath], {
      paths: fixture.paths,
      environment: {},
      now: fixture.now,
      runtimeVersion: "9.9.9",
    })).result;
    assert.equal(preview.status, "blocked");
    assert.ok(preview.blockers.includes("runtime-version-drift"));
    await assert.rejects(
      runOnboardApply(root, [fixture.planPath, "--apply"], {
        paths: fixture.paths,
        environment: {},
        now: fixture.now,
        runtimeVersion: "9.9.9",
      }),
      (error) => error.code === "onboard-runtime-drift",
    );

    const hostile = structuredClone(fixture.plan);
    hostile.provenance.catalog.binding.generated = {
      mode: "repository",
      paths: ["../outside/app-catalog.json", "../outside/public-catalog.json"],
      configuredDirectory: "../outside",
    };
    hostile.application.operations.find((operation) => operation.kind === "refresh-generated-catalog").generated = structuredClone(hostile.provenance.catalog.binding.generated);
    hostile.planId = calculateOnboardPlanId(hostile);
    const hostilePath = path.join(fixture.temporary, "hostile-plan.json");
    await writeFile(hostilePath, `${JSON.stringify(hostile, null, 2)}\n`);
    await assert.rejects(
      runOnboardApply(root, [hostilePath], { paths: fixture.paths, environment: {}, now: fixture.now }),
      (error) => error.code === "onboard-plan-invalid" && /stay inside/.test(error.message),
    );
    assert.equal((await git(fixture.repository, "worktree", "list", "--porcelain")).match(/^worktree /gm)?.length, 1);
    assert.equal(await git(fixture.repository, "status", "--porcelain"), "");
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("failure and interruption remove the temporary worktree and proposal branch", gitTestOptions, async () => {
  for (const mode of ["failure", "interrupt"]) {
    const fixture = await prepareApprovedPlan();
    const controller = new AbortController();
    const branch = `codex/onboard-${fixture.plan.planId.slice(7, 23)}`;
    try {
      await assert.rejects(
        runOnboardApply(root, [fixture.planPath, "--apply"], {
          paths: fixture.paths,
          environment: {},
          now: fixture.now,
          signal: controller.signal,
          lifecycle(stage) {
            if (stage !== "after-catalog-writes") return;
            if (mode === "interrupt") controller.abort();
            else throw new Error("fixture validation failure");
          },
        }),
        (error) => mode === "interrupt"
          ? error.code === "onboard-apply-interrupted"
          : error.code === "onboard-transaction-failed" && /rollback verified/.test(error.message),
      );
      assert.equal(await git(fixture.repository, "branch", "--list", branch), "");
      assert.equal(await git(fixture.repository, "status", "--porcelain"), "");
      assert.equal(await git(fixture.repository, "rev-parse", "HEAD"), fixture.baseRevision);
      assert.equal((await git(fixture.repository, "worktree", "list", "--porcelain")).match(/^worktree /gm)?.length, 1);
    } finally {
      await rm(fixture.temporary, { recursive: true, force: true });
    }
  }
});

test("a concurrent clean source commit rolls back the isolated proposal without overwriting source drift", gitTestOptions, async () => {
  const fixture = await prepareApprovedPlan();
  const branch = `codex/onboard-${fixture.plan.planId.slice(7, 23)}`;
  try {
    await assert.rejects(
      runOnboardApply(root, [fixture.planPath, "--apply"], {
        paths: fixture.paths,
        environment: {},
        now: fixture.now,
        async lifecycle(stage) {
          if (stage !== "before-commit") return;
          await writeFile(path.join(fixture.repository, "README.md"), "fixture catalog repository\nconcurrent reviewed change\n");
          await git(fixture.repository, "add", "--", "README.md");
          await git(fixture.repository, "commit", "-m", "fixture: concurrent source commit");
        },
      }),
      (error) => error.code === "onboard-catalog-drift" && /proposal branch rollback passed/.test(error.message),
    );
    assert.notEqual(await git(fixture.repository, "rev-parse", "HEAD"), fixture.baseRevision);
    assert.equal(await git(fixture.repository, "status", "--porcelain"), "");
    assert.equal(await git(fixture.repository, "branch", "--list", branch), "");
    assert.equal((await git(fixture.repository, "worktree", "list", "--porcelain")).match(/^worktree /gm)?.length, 1);
    assert.match(await readFile(path.join(fixture.repository, "README.md"), "utf8"), /concurrent reviewed change/);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("CLI preview ignores an unrelated dirty working directory", gitTestOptions, async () => {
  const fixture = await prepareApprovedPlan({ now: new Date().toISOString() });
  const caller = path.join(fixture.temporary, "dirty-caller");
  try {
    await mkdir(caller);
    await git(caller, "init", "-b", "main");
    await writeFile(path.join(caller, "unrelated.txt"), "dirty and unrelated\n");
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      cli,
      "onboard-apply", fixture.planPath,
      "--catalog-dir", fixture.catalogDirectory,
      "--connection-profiles-file", fixture.profiles,
      "--generated-dir", fixture.generatedDirectory,
      "--json",
    ], { cwd: caller, env: process.env, timeout: 10_000 });
    assert.equal(stderr, "");
    const result = JSON.parse(stdout);
    assert.equal(result.status, "ready", JSON.stringify(result));
    assert.equal(result.readOnly, true);
    assert.deepEqual(await readdir(caller), [".git", "unrelated.txt"]);
    assert.equal(await git(fixture.repository, "branch", "--list", result.proposal.branch), "");
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});
