import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "scripts/devhub.mjs");
const observedAt = "2026-08-13T09:00:00.000Z";

async function fixture() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-discovery-inbox-"));
  const catalogDirectory = path.join(temporary, "catalog");
  await mkdir(path.join(catalogDirectory, "projects"), { recursive: true });
  await writeFile(path.join(catalogDirectory, "hosts.yaml"), "version: 1\nhosts:\n  - id: railway\n    name: Railway\n    kind: cloud\n    location: cloud\n");
  await writeFile(path.join(catalogDirectory, "projects/example.yaml"), "version: 1\nid: example\ntitle: Example\nregistration: overlay\ndescription: Discovery Inbox CLI fixture.\nlifecycle: active\nkind: product\nservices: []\n");
  const profile = { version: 1, id: "github-example", connectorId: "github", authorization: { method: "cli-session" }, scope: { kind: "user", login: "acme" }, owner: "Example reviewer", state: "unknown", lastObservedAt: null, freshForSeconds: 3600 };
  const session = { version: 1, command: "setup-session", sessionId: "fixture-session", startedAt: observedAt, completedAt: observedAt, status: "complete", readOnly: true, persistent: false, safety: { catalogWrites: false, providerMutations: false, credentialValuesReturned: false, browserExecution: false, residentProcess: false }, results: [{ profileId: profile.id, connectorId: "github", state: "connected", observedAt, freshUntil: "2026-08-13T10:00:00.000Z", reviewedConnection: { scope: profile.scope, owner: profile.owner, authorization: profile.authorization, priorState: profile.state, priorObservedAt: profile.lastObservedAt }, evidence: { source: "on-demand-setup-connector", observations: [{ kind: "repository-candidate", provider: "github", providerId: "101", owner: "acme", name: "new-tool", fullName: "acme/new-tool", url: "https://github.com/acme/new-tool", visibility: "private", archived: false, disabled: false, access: "write", ownership: "unknown", identity: { provider: "github", owner: "acme", name: "new-tool" } }] }, message: "One repository." }] };
  const profileFile = path.join(temporary, "profiles.json");
  const sessionFile = path.join(temporary, "session.json");
  await writeFile(profileFile, JSON.stringify(profile));
  await writeFile(sessionFile, JSON.stringify(session));
  return { temporary, catalogDirectory, profileFile, sessionFile };
}

test("Discovery Inbox CLI revalidates profiles plus session and leaves the catalog unchanged", async () => {
  const target = await fixture();
  try {
    const projectFile = path.join(target.catalogDirectory, "projects/example.yaml");
    const before = await readFile(projectFile, "utf8");
    const files = await readdir(path.join(target.catalogDirectory, "projects"));
    const { stdout, stderr } = await execFileAsync(process.execPath, [cli, "discovery-inbox", target.profileFile, target.sessionFile, "--json"], { cwd: root, env: { ...process.env, DEVHUB_CATALOG_DIR: target.catalogDirectory } });
    const result = JSON.parse(stdout);
    assert.equal(stderr, "");
    assert.equal(result.command, "discovery-inbox");
    assert.equal(result.readOnly, true);
    assert.equal(result.items[0].state, "new");
    assert.equal(result.proposals.length, 0);
    assert.equal(await readFile(projectFile, "utf8"), before);
    assert.deepEqual(await readdir(path.join(target.catalogDirectory, "projects")), files);
  } finally {
    await rm(target.temporary, { recursive: true, force: true });
  }
});
