import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { parse } from "yaml";
import {
  createSitesCompanionPlan,
  sanitizeSitesCompanionCatalog,
} from "../lib/sites-companion.mjs";
import { resolveDevHubPaths } from "../scripts/devhub-config.mjs";
import { runSitesCompanion } from "../scripts/sites-companion.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const REVISION = "1".repeat(40);
const DIGEST = "2".repeat(64);

async function detectGit() {
  try {
    await execFileAsync("git", ["--version"], { timeout: 2_000 });
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

const gitAvailable = await detectGit();
const gitTestOptions = Object.freeze({ skip: gitAvailable ? false : "requires Git" });

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function git(repository, ...args) {
  const { stdout } = await execFileAsync("git", ["-C", repository, ...args], { encoding: "utf8" });
  return stdout.trim();
}

function sensitiveCatalog() {
  return {
    hosts: [{
      id: "owner-laptop",
      name: "Owner laptop",
      kind: "mac",
      location: "local",
      tailscaleName: "owner-tailnet",
      tailscaleIPv4: "private-tailnet-address",
    }],
    projects: [{
      version: 1,
      id: "secret-project",
      title: "Secret Project",
      registration: "overlay",
      description: "Private app at https://user:token@example.test/private?key=secret",
      lifecycle: "production",
      kind: "product",
      repository: "private/secret-project",
      aliases: ["customer-name"],
      tags: ["private"],
      workspaces: [{ host: "owner-laptop", path: "private-workspace-path" }],
      stewards: [{ id: "owner", name: "Owner", kind: "person", source: "operator" }],
      access: [{ id: "repo", kind: "repository", subject: "private/secret-project", access: "yes", source: "operator", note: "private" }],
      credentials: [{
        id: "api",
        provider: "Secret provider",
        purpose: "API",
        secretRef: { kind: "environment", locator: "SECRET_TOKEN" },
        consumers: ["web"],
        owner: "owner",
        source: "operator",
      }],
      services: [{
        id: "web",
        name: "Web",
        kind: "web",
        environment: "production",
        host: "owner-laptop",
        runtime: "node",
        mode: "always-on",
        visibility: "tailnet",
        url: "https://user:token@example.test/private?key=secret",
        endpoint: { fallback: "https://private.example.test" },
        links: [{ id: "logs", type: "logs", label: "Logs", url: "https://logs.example.test/?token=secret" }],
        probe: { type: "http", url: "http://127.0.0.1:3000/health", successStatuses: [200] },
        commands: { logs: "print-secret" },
        reported: { state: "up", note: "secret" },
        readiness: { evidence: [{ id: "private", check: "privacy", state: "unknown", source: "catalog", note: "secret" }] },
      }],
    }],
  };
}

test("companion catalog keeps the finite map and removes owner/private operating data", () => {
  const sanitized = sanitizeSitesCompanionCatalog(sensitiveCatalog());
  assert.deepEqual(sanitized.connections, { version: 1, source: "not-configured", profiles: [] });
  assert.deepEqual(sanitized.hosts, [{ id: "owner-laptop", name: "Owner laptop", kind: "mac", location: "local" }]);
  assert.deepEqual(sanitized.projects[0].services[0], {
    id: "web",
    name: "Web",
    kind: "web",
    environment: "production",
    host: "owner-laptop",
    runtime: "node",
    mode: "always-on",
    visibility: "tailnet",
  });
  const serialized = JSON.stringify(sanitized);
  for (const forbidden of [
    "token@example", "SECRET_TOKEN", "private-workspace-path", "private/secret-project", "print-secret",
    "tailscaleName", "tailscaleIPv4", "credentials", "workspaces", "readiness", "probe", "links", "reported",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
});

test("companion access defaults owner-only and an external binding deterministically reuses one Site", () => {
  const base = {
    source: { releaseTag: "v1.2.3", sourceCommit: REVISION, manifestSha256: DIGEST },
    catalog: { revision: REVISION, fingerprint: DIGEST },
    statusApiOrigin: "https://central.example.test",
  };
  const create = createSitesCompanionPlan(base);
  assert.equal(create.site.action, "create");
  assert.deepEqual(create.site.access, {
    visibility: "custom",
    ownerSource: "invoking-sites-account",
    allowedOwnerCount: 1,
    allowedGroupCount: 0,
    externalVisitorCount: 0,
  });
  assert.equal(create.publication.automatic, false);
  assert.equal(create.publication.requiresExplicitApproval, true);

  const binding = {
    version: 1,
    kind: "devhub-sites-companion",
    projectId: "site-project-123",
    siteOrigin: "https://owner.example.test",
    currentVersionId: "version-7",
    previousVersionId: "version-6",
  };
  const first = createSitesCompanionPlan({ ...base, binding });
  const second = createSitesCompanionPlan({ ...base, binding });
  assert.equal(first.site.action, "reuse");
  assert.equal(first.site.projectId, "site-project-123");
  assert.equal(second.site.projectId, first.site.projectId);
  assert.equal(first.rollback.restoreVersionId, "version-6");
  assert.equal(first.rollback.removeBindingOnly, true);
  assert.throws(
    () => createSitesCompanionPlan({ ...base, binding: { ...binding, token: "forbidden" } }),
    /unsupported fields/,
  );
});

async function createPublicSource(directory) {
  const files = new Map([
    ["package.json", '{"name":"fixture","version":"1.2.3","scripts":{"build":"true"}}\n'],
    ["README.md", "verified public source\n"],
    ["app/page.tsx", "export default function Page() { return null; }\n"],
    ["app/api/context/route.ts", "export function GET() {}\n"],
    ["app/api/status/route.ts", "export function GET() {}\n"],
    ["app/mcp/route.ts", "export function POST() {}\n"],
    ["app/generated/catalog.json", "{}\n"],
    ["public/catalog.json", "{}\n"],
    ["catalog/hosts.yaml", "version: 1\nhosts: []\n"],
    ["catalog/projects/demo.yaml", "private: true\n"],
  ]);
  for (const [relative, contents] of files) {
    const filename = path.join(directory, ...relative.split("/"));
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, contents);
  }
  const manifest = {
    manifestVersion: 2,
    exporterVersion: 1,
    source: { commit: REVISION, state: "clean" },
    files: [...files].map(([relative, contents]) => ({ path: relative, sha256: sha256(contents) })),
  };
  const manifestContents = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(path.join(directory, "PUBLIC_EXPORT_MANIFEST.json"), manifestContents);
  return sha256(manifestContents);
}

async function createCatalogRepository(directory) {
  const catalog = path.join(directory, "catalog");
  await mkdir(path.join(catalog, "projects"), { recursive: true });
  await writeFile(path.join(catalog, "hosts.yaml"), `version: 1
hosts:
  - id: owner-laptop
    name: Owner laptop
    kind: mac
    location: local
    tailscaleName: owner-tailnet
`);
  await writeFile(path.join(catalog, "projects", "secret-project.yaml"), `version: 1
id: secret-project
title: Secret Project
registration: overlay
description: Private source detail
lifecycle: production
kind: product
workspaces:
  - host: owner-laptop
    path: /srv/reviewed-project
stewards:
  - id: owner
    name: Owner
    kind: person
    source: operator
credentials:
  - id: api
    provider: Example
    purpose: API
    secretRef:
      kind: environment
      locator: SECRET_TOKEN
    consumers: [web]
    owner: owner
    source: operator
services:
  - id: web
    name: Web
    kind: web
    environment: production
    host: owner-laptop
    runtime: node
    mode: always-on
    visibility: tailnet
    url: https://private.example.test/dashboard
    commands:
      logs: print-secret
`);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Sites companion test");
  await git(directory, "config", "user.email", "sites-companion@example.invalid");
  await git(directory, "add", "--", "catalog/hosts.yaml", "catalog/projects/secret-project.yaml");
  await git(directory, "commit", "-m", "fixture: reviewed catalog");
  return { catalog, revision: await git(directory, "rev-parse", "HEAD") };
}

test("preview is read-only and apply stages only verified source plus sanitized catalog", gitTestOptions, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-sites-companion-test-"));
  try {
    const source = path.join(temporary, "source");
    const catalogRepository = path.join(temporary, "catalog-repository");
    const staging = path.join(temporary, "staging");
    await mkdir(source);
    await mkdir(catalogRepository);
    const manifestDigest = await createPublicSource(source);
    const catalog = await createCatalogRepository(catalogRepository);
    const paths = resolveDevHubPaths(root, {}, { pathOptions: { catalogDirectory: catalog.catalog } });
    const baseArguments = [
      "--source-dir", source,
      "--source-tag", "v1.2.3",
      "--source-manifest-sha256", manifestDigest,
      "--catalog-revision", catalog.revision,
      "--status-api-origin", "https://central.example.test",
      "--staging-dir", staging,
      "--json",
    ];
    const withStaging = (destination) => {
      const argumentsList = [...baseArguments];
      argumentsList[argumentsList.indexOf("--staging-dir") + 1] = destination;
      return argumentsList;
    };

    const forbiddenStaging = [
      path.join(source, "staging"),
      path.join(catalogRepository, "staging"),
      path.join(root, ".sites-companion-test"),
    ];
    const catalogLink = path.join(temporary, "catalog-link");
    await symlink(catalogRepository, catalogLink, "dir");
    forbiddenStaging.push(path.join(catalogLink, "staging"));
    for (const destination of forbiddenStaging) {
      await assert.rejects(
        runSitesCompanion(root, [...withStaging(destination), "--apply"], { paths, environment: {} }),
        (error) => error?.code === "sites-companion-staging-invalid",
      );
      await assert.rejects(access(destination), /ENOENT/);
    }
    assert.equal(await git(catalogRepository, "status", "--porcelain=v1", "--untracked-files=all"), "");

    const preview = await runSitesCompanion(root, baseArguments, { paths, environment: {} });
    assert.equal(preview.result.state, "preview");
    assert.equal(preview.result.readOnly, true);
    await assert.rejects(access(staging), /ENOENT/);

    const applied = await runSitesCompanion(root, [...baseArguments, "--apply"], { paths, environment: {} });
    assert.equal(applied.result.state, "staged");
    assert.equal(applied.result.staging.projectCount, 1);
    assert.equal(applied.result.staging.serviceCount, 1);
    for (const removed of [
      ".openai/hosting.json",
      "app/api/context/route.ts",
      "app/api/status/route.ts",
      "app/mcp/route.ts",
    ]) {
      await assert.rejects(access(path.join(staging, removed)), /ENOENT/);
    }
    assert.equal(await readFile(path.join(staging, "README.md"), "utf8"), "verified public source\n");
    const stagedHosts = parse(await readFile(path.join(staging, "catalog/hosts.yaml"), "utf8"));
    const stagedProject = parse(await readFile(path.join(staging, "catalog/projects/secret-project.yaml"), "utf8"));
    assert.deepEqual(stagedHosts.hosts[0], { id: "owner-laptop", name: "Owner laptop", kind: "mac", location: "local" });
    assert.equal(stagedProject.services[0].url, undefined);
    assert.equal(stagedProject.services[0].commands, undefined);
    assert.equal(stagedProject.credentials, undefined);
    assert.equal(stagedProject.workspaces, undefined);
    const stagedManifest = JSON.parse(await readFile(path.join(staging, "SITES-COMPANION-MANIFEST.json"), "utf8"));
    assert.equal(stagedManifest.backend.statusApiEndpoint, "https://central.example.test/api/status");
    assert.equal(stagedManifest.backend.credentials, "omit");
    assert.equal(stagedManifest.backend.contextRoute, false);
    assert.equal(stagedManifest.hostingMetadata, "add only inside this staging tree after Sites create/reuse");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("public guidance keeps Sites optional, owner-only, preview-first and outside canonical DevHub", async () => {
  const [document, skill, exportList, runtimeList, dashboard] = await Promise.all([
    readFile(path.join(root, "docs/SITES_COMPANION.md"), "utf8"),
    readFile(path.join(root, "plugins/devhub/skills/devhub-registry/SKILL.md"), "utf8"),
    readFile(path.join(root, "config/public-export-files.txt"), "utf8").catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    }),
    readFile(path.join(root, "config/user-runtime-files.txt"), "utf8"),
    readFile(path.join(root, "app/DevHubDashboard.tsx"), "utf8"),
  ]);
  for (const contract of [document, skill]) {
    assert.match(contract, /optional/i);
    assert.match(contract, /exact annotated public tag/i);
    assert.match(contract, /one owner|exactly the invoking owner/i);
    assert.match(contract, /zero\s+groups|0\s+groups/i);
    assert.match(contract, /zero\s+external visitors|0\s+external visitors/i);
    assert.match(contract, /Publish this private companion/);
    assert.match(contract, /previousVersionId|prior Site version/i);
    assert.match(contract, /never.*(?:tunnel|Funnel|public ingress|Worker relay)/is);
    assert.match(contract, /\/api\/context/);
  }
  if (exportList !== null) {
    assert.match(exportList, /^docs\/SITES_COMPANION\.md\tdocs\/SITES_COMPANION\.md$/m);
    assert.match(exportList, /^scripts\/sites-companion\.mjs$/m);
  }
  assert.match(runtimeList, /^scripts\/sites-companion\.mjs$/m);
  assert.match(dashboard, /credentials: "omit", mode: "cors"/);
  assert.match(dashboard, /viewerContextEndpoint/);
});
