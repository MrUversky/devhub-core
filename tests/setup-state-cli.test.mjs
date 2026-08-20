import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { parseSetupStateCliArguments } from "../scripts/setup-state.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "scripts/devhub.mjs");

function reviewedProfile() {
  return {
    version: 1,
    id: "github-example",
    connectorId: "github",
    authorization: { method: "cli-session" },
    scope: { kind: "user", login: "example" },
    owner: "Example operator",
    state: "authorization-required",
    lastObservedAt: null,
    freshForSeconds: 3600,
  };
}

function setupSession(profile, sessionId, { access = "read", observedAt = new Date(Date.now() - 60_000).toISOString() } = {}) {
  return {
    version: 1,
    command: "setup-session",
    sessionId,
    startedAt: observedAt,
    completedAt: observedAt,
    status: "complete",
    readOnly: true,
    persistent: false,
    safety: { catalogWrites: false, providerMutations: false, credentialValuesReturned: false, browserExecution: false, residentProcess: false },
    results: [{
      profileId: profile.id,
      connectorId: profile.connectorId,
      state: "connected",
      observedAt,
      freshUntil: new Date(Date.parse(observedAt) + (profile.freshForSeconds * 1_000)).toISOString(),
      reviewedConnection: { scope: profile.scope, owner: profile.owner, authorization: profile.authorization, priorState: profile.state, priorObservedAt: profile.lastObservedAt },
      evidence: { source: "on-demand-setup-connector", observations: [{
        kind: "repository-candidate",
        provider: "github",
        providerId: "101",
        owner: "example",
        name: "app",
        fullName: "example/app",
        url: "https://github.com/example/app",
        visibility: "private",
        archived: false,
        disabled: false,
        access,
        ownership: "unknown",
        identity: { provider: "github", owner: "example", name: "app" },
      }] },
      message: "One reviewed repository.",
    }],
  };
}

async function writeJson(directory, filename, value) {
  const destination = path.join(directory, filename);
  await writeFile(destination, `${JSON.stringify(value, null, 2)}\n`);
  return destination;
}

async function runJson(args) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args, "--json"], { cwd: root });
  assert.equal(stderr, "");
  return JSON.parse(stdout);
}

test("setup-state named optional inputs are unambiguous and order-independent", () => {
  assert.deepEqual(parseSetupStateCliArguments([
    "profiles.json", "session.json", "--discovery-review=discovery.json", "--availability-review", "availability.json", "--json",
  ]), {
    profileFilename: "profiles.json",
    sessionFilename: "session.json",
    availabilityReviewFilename: "availability.json",
    discoveryReviewFilename: "discovery.json",
  });
  assert.throws(() => parseSetupStateCliArguments(["profiles.json", "session.json", "ambiguous.json"]), /exactly profiles.json and session.json/);
  assert.throws(() => parseSetupStateCliArguments(["profiles.json", "session.json", "--discovery-review"]), /needs a JSON file/);
  assert.throws(() => parseSetupStateCliArguments(["profiles.json", "session.json", "--discovery-review=a.json", "--discovery-review=b.json"]), /only once/);
  assert.throws(() => parseSetupStateCliArguments(["profiles.json", "session.json", "--discovery-inbox=forged.json"]), /does not support/);
});

test("CLI setup-state rebuilds Discovery Inbox and gates unresolved versus reviewed decisions", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "devhub-setup-state-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const profile = reviewedProfile();
  const profiles = await writeJson(directory, "profiles.json", profile);
  const session = await writeJson(directory, "session.json", setupSession(profile, "state-session"));
  const initialInbox = await runJson(["discovery-inbox", profiles, session]);
  assert.equal(initialInbox.summary.unansweredRequiredQuestions > 0, true);
  const unresolvedReview = await writeJson(directory, "unresolved-review.json", {
    version: 1,
    artifactId: initialInbox.artifactId,
    decisions: [],
  });
  const unresolved = await runJson(["setup-state", profiles, session, "--discovery-review", unresolvedReview]);
  assert.equal(unresolved.command, "setup-state");
  assert.equal(unresolved.setupComplete, false);
  assert.equal(unresolved.discovery.state, "review-required");

  const reviewed = await writeJson(directory, "reviewed.json", {
    version: 1,
    artifactId: initialInbox.artifactId,
    decisions: initialInbox.items.map((item) => ({
      candidateId: item.candidateId,
      reviewedAt: new Date().toISOString(),
      reviewedBy: "Example operator",
      disposition: "ignore",
      reason: "This fixture resource is outside the reviewed setup.",
    })),
  });
  const complete = await runJson(["setup-state", profiles, session, "--discovery-review", reviewed]);
  assert.equal(complete.setupComplete, true);
  assert.equal(complete.discovery.state, "reviewed");
  assert.equal(complete.safety.catalogWrites, false);
});

test("CLI setup-refresh reports change without inferring deletion", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "devhub-setup-refresh-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const profile = reviewedProfile();
  const profiles = await writeJson(directory, "profiles.json", profile);
  const previous = await writeJson(directory, "previous.json", setupSession(profile, "previous-session"));
  const current = await writeJson(directory, "current.json", setupSession(profile, "current-session", { access: "admin" }));
  const result = await runJson(["setup-refresh", profiles, previous, current]);
  assert.equal(result.command, "refresh-my-devhub");
  assert.equal(result.summary.changed, 1);
  assert.equal(result.safety.deletionsInferred, false);
  assert.equal(result.safety.catalogWrites, false);
});

test("CLI setup-disconnect emits an exact review-only profile proposal", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "devhub-setup-disconnect-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const profile = reviewedProfile();
  const profiles = await writeJson(directory, "profiles.json", { version: 1, profiles: [profile] });
  const request = await writeJson(directory, "request.json", {
    reviewedBy: "Example operator",
    requestedAt: new Date().toISOString(),
    reason: "This account is no longer in the reviewed setup.",
    action: "disable",
  });
  const result = await runJson(["setup-disconnect", profiles, profile.id, request]);
  assert.equal(result.command, "disconnect-connection-proposal");
  assert.equal(result.apply, false);
  assert.equal(result.profileChange.action, "disable");
  assert.deepEqual(result.preserved, { catalogRecords: true, providerResources: true, evidenceHistory: true });
});

test("CLI setup commands reject extra fields, wrong profile IDs and oversized input before mutation", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "devhub-setup-state-invalid-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const profile = reviewedProfile();
  const profiles = await writeJson(directory, "profiles.json", profile);
  const session = await writeJson(directory, "session.json", setupSession(profile, "invalid-options-session"));
  const forgedInbox = await writeJson(directory, "forged-inbox.json", {
    version: 1,
    command: "discovery-inbox",
    summary: { unansweredRequiredQuestions: 0, proposals: 0 },
    items: [],
  });
  const request = await writeJson(directory, "request.json", {
    reviewedBy: "Example operator",
    requestedAt: new Date().toISOString(),
    reason: "Review-only request.",
    action: "remove",
    apply: true,
  });
  await assert.rejects(execFileAsync(process.execPath, [cli, "setup-disconnect", profiles, "missing-profile", request, "--json"], { cwd: root }), (error) => {
    const output = JSON.parse(error.stdout);
    return error.code === 3 && output.readOnly === true && output.error.code === "invalid-disconnect-request";
  });
  await assert.rejects(execFileAsync(process.execPath, [cli, "setup-disconnect", profiles, profile.id, request, "--json"], { cwd: root }), (error) => {
    const output = JSON.parse(error.stdout);
    return error.code === 3 && output.readOnly === true && output.error.code === "invalid-disconnect-request" && /apply/.test(output.error.message);
  });
  await assert.rejects(execFileAsync(process.execPath, [cli, "setup-state", profiles, session, "--discovery-inbox", forgedInbox, "--json"], { cwd: root }), (error) => {
    const output = JSON.parse(error.stdout);
    return error.code === 3 && output.readOnly === true && output.error.code === "setup-state-arguments-invalid";
  });
  const oversized = path.join(directory, "oversized.json");
  await writeFile(oversized, JSON.stringify({ reason: "x".repeat((256 * 1024) + 1) }));
  await assert.rejects(execFileAsync(process.execPath, [cli, "setup-disconnect", profiles, profile.id, oversized, "--json"], { cwd: root }), (error) => {
    const output = JSON.parse(error.stdout);
    return error.code === 3 && output.readOnly === true && output.error.code === "invalid-setup-state-file" && /byte limit/.test(output.error.message);
  });
});
