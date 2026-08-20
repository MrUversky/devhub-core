import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";
import {
  RECONCILIATION_EXIT,
  ReconciliationApplyError,
  applyNativeReconciliation,
  createOverlayProposal,
  createReconciliationPlan,
  formatOverlayProposal,
  formatReconciliation,
  registerNativeManifest,
} from "../scripts/reconciliation.mjs";

const hosts = `version: 1
hosts:
  - id: example-laptop
    name: Example laptop
    kind: mac
    location: local
`;

function manifest({ title = "Example app", registration = "native" } = {}) {
  return `version: 1
id: example-app
title: ${title}
registration: ${registration}
description: Generic reconciliation fixture.
lifecycle: active
kind: product
repository: example/example-app
services:
  - id: web
    name: Web
    kind: web
    environment: local
    host: example-laptop
    runtime: node
    mode: on-demand
    visibility: local
`;
}

async function createFixture(options = {}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "devhub-reconciliation-"));
  const root = path.join(temporary, "registry");
  const target = path.join(temporary, "example-app");
  await Promise.all([
    mkdir(path.join(root, "catalog/projects"), { recursive: true }),
    mkdir(path.join(root, "app/generated"), { recursive: true }),
    mkdir(path.join(root, "public"), { recursive: true }),
    mkdir(path.join(target, ".devhub"), { recursive: true }),
  ]);
  await writeFile(path.join(root, "catalog/hosts.yaml"), hosts);
  if (!options.unregistered) {
    await writeFile(path.join(root, "catalog/projects/example-app.yaml"), manifest({
      title: options.catalogTitle ?? "Example app",
      registration: options.catalogRegistration ?? "native",
    }));
  }
  if (!options.noNative) {
    await writeFile(path.join(target, ".devhub/project.yaml"), manifest({
      title: options.nativeTitle ?? "Example app",
      registration: options.nativeRegistration ?? "native",
    }));
  }
  await writeFile(path.join(root, "app/generated/catalog.json"), "generated-before\n");
  await writeFile(path.join(root, "public/catalog.json"), "public-before\n");
  return { temporary, root, target };
}

async function compileFixture(root) {
  const project = parse(await readFile(path.join(root, "catalog/projects/example-app.yaml"), "utf8"));
  const generated = `${JSON.stringify({ version: 1, projects: [project] }, null, 2)}\n`;
  await writeFile(path.join(root, "app/generated/catalog.json"), generated);
  await writeFile(path.join(root, "public/catalog.json"), generated);
}

test("new overlay proposal uses only observed evidence and never writes either repository", async () => {
  const fixture = await createFixture({ unregistered: true, noNative: true });
  try {
    await writeFile(path.join(fixture.target, "package.json"), JSON.stringify({
      name: "@example/observed-app",
      scripts: { dev: "vite", test: "node --test" },
    }));
    await writeFile(path.join(fixture.target, "compose.yaml"), "services: {}\n");
    const catalogBefore = await readdir(path.join(fixture.root, "catalog/projects"));
    const projectBefore = await readdir(fixture.target);

    const proposal = await createOverlayProposal(
      fixture.root,
      fixture.target,
      "example-laptop",
      { proposedId: "observed-app" },
    );

    assert.equal(proposal.status, "review-required");
    assert.equal(proposal.readOnly, true);
    assert.equal(proposal.catalogMutation, false);
    assert.equal(proposal.externalRepositoryMutation, false);
    assert.equal(proposal.existingOverlay, null);
    assert.deepEqual(proposal.evidence.package, { name: "@example/observed-app", scripts: ["dev", "test"] });
    assert.deepEqual(proposal.evidence.composeFiles, ["compose.yaml"]);
    assert.deepEqual(proposal.candidate.manifest.workspaces, [{ host: "example-laptop", path: fixture.target }]);
    assert.equal(proposal.candidate.manifest.registration, "overlay");
    assert.equal(proposal.candidate.manifest.repository, undefined);
    assert.deepEqual(proposal.candidate.manifest.services, []);
    assert.ok(proposal.unknowns.some((unknown) => unknown.field === "services"));
    assert.ok(proposal.unknowns.some((unknown) => unknown.field === "services[].url/probe"));
    assert.match(formatOverlayProposal(proposal), /Candidate YAML \(review only\)/);
    assert.deepEqual(await readdir(path.join(fixture.root, "catalog/projects")), catalogBefore);
    assert.deepEqual(await readdir(fixture.target), projectBefore);
    await assert.rejects(readFile(proposal.candidate.reviewDestination, "utf8"), /ENOENT/);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("existing overlay remains the candidate source of truth", async () => {
  const fixture = await createFixture({ catalogRegistration: "overlay", noNative: true });
  try {
    const catalogPath = path.join(fixture.root, "catalog/projects/example-app.yaml");
    const reviewed = (await readFile(catalogPath, "utf8")).replace(
      "services:\n",
      `workspaces:\n  - host: example-laptop\n    path: ${JSON.stringify(fixture.target)}\nservices:\n`,
    );
    await writeFile(catalogPath, reviewed);
    const before = await readFile(catalogPath, "utf8");

    const proposal = await createOverlayProposal(fixture.root, fixture.target, "example-laptop");

    assert.equal(proposal.existingOverlay.id, "example-app");
    assert.equal(proposal.existingOverlay.matchType, "workspace");
    assert.deepEqual(proposal.candidate.manifest, parse(reviewed));
    assert.equal(proposal.defaults.length, 0);
    assert.ok(proposal.unknowns.some((unknown) => unknown.field === "reviewed overlay drift"));
    assert.equal(await readFile(catalogPath, "utf8"), before);
    await assert.rejects(readFile(path.join(fixture.target, ".devhub/project.yaml"), "utf8"), /ENOENT/);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("overlay proposal refuses missing, invalid, conflicting and native identities", async () => {
  const unregistered = await createFixture({ unregistered: true, noNative: true });
  const native = await createFixture({ noNative: true });
  try {
    const missing = await createOverlayProposal(unregistered.root, unregistered.target, "example-laptop");
    assert.equal(missing.status, "invalid");
    assert.equal(missing.error.code, "overlay-id-required");

    const invalid = await createOverlayProposal(unregistered.root, unregistered.target, "example-laptop", { proposedId: "Bad ID" });
    assert.equal(invalid.error.code, "invalid-overlay-id");

    const nativeBoundary = await createOverlayProposal(native.root, native.target, "example-laptop", { proposedId: "example-app" });
    assert.equal(nativeBoundary.error.code, "registration-boundary");
    assert.equal(nativeBoundary.candidate, null);

    const unregisteredNative = await createFixture({ unregistered: true });
    try {
      const nativeManifestBoundary = await createOverlayProposal(
        unregisteredNative.root,
        unregisteredNative.target,
        "example-laptop",
        { proposedId: "other-overlay" },
      );
      assert.equal(nativeManifestBoundary.error.code, "registration-boundary");
      assert.equal(nativeManifestBoundary.candidate, null);
    } finally {
      await rm(unregisteredNative.temporary, { recursive: true, force: true });
    }
  } finally {
    await Promise.all([unregistered, native].map((fixture) => rm(fixture.temporary, { recursive: true, force: true })));
  }
});

test("reconciliation produces a strict reviewed field-level plan", async () => {
  const fixture = await createFixture({ catalogTitle: "Old title", nativeTitle: "Reviewed title" });
  try {
    const plan = await createReconciliationPlan(fixture.root, fixture.target, "example-laptop");
    assert.equal(plan.status, "drift");
    assert.equal(plan.exitCode, RECONCILIATION_EXIT.drift);
    assert.equal(plan.readOnly, true);
    assert.equal(plan.reviewRequired, true);
    assert.equal(plan.plan.action, "update-catalog-from-native");
    assert.deepEqual(plan.diff, [{
      path: "title",
      state: "changed",
      catalog: "Old title",
      project: "Reviewed title",
    }]);
    assert.match(formatReconciliation(plan), /Review required: yes/);
    assert.match(formatReconciliation(plan), /~ title: "Old title" -> "Reviewed title"/);
    assert.match(formatReconciliation(plan, { diffOnly: true }), /DevHub semantic diff/);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("native reconciliation preserves reviewed stewardship metadata without inventing it", async () => {
  const fixture = await createFixture();
  try {
    const nativePath = path.join(fixture.target, ".devhub/project.yaml");
    const stewardship = `stewards:\n  - id: product-team\n    name: Product team\n    kind: team\n    source: operator\nstewardshipDefaults:\n  accountableOwner: product-team\n  operator: product-team\ncredentials:\n  - id: example-api\n    provider: Example Provider\n    purpose: Fictional API access\n    secretRef:\n      kind: environment\n      locator: EXAMPLE_API_KEY\n    consumers: [web]\n    owner: product-team\n    source: operator\n`;
    const original = await readFile(nativePath, "utf8");
    await writeFile(nativePath, original.replace("services:\n", `${stewardship}services:\n`));

    const plan = await createReconciliationPlan(fixture.root, fixture.target, "example-laptop");
    assert.equal(plan.status, "drift");
    assert.equal(plan.readOnly, true);
    assert.ok(plan.diff.some((item) => item.path === "stewards" && item.state === "added"));
    assert.ok(plan.diff.some((item) => item.path === "stewardshipDefaults" && item.state === "added"));
    assert.ok(plan.diff.some((item) => item.path === "credentials" && item.state === "added"));
    const serialized = JSON.stringify(plan);
    const human = formatReconciliation(plan);
    assert.equal(serialized.includes("EXAMPLE_API_KEY"), false);
    assert.equal(human.includes("EXAMPLE_API_KEY"), false);
    assert.match(serialized, /configured/);
    assert.match(human, /configured/);
    assert.equal((await readFile(path.join(fixture.root, "catalog/projects/example-app.yaml"), "utf8")).includes("stewardshipDefaults"), false);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("locator-only reconciliation drift never exposes the field or either locator", async () => {
  const fixture = await createFixture();
  try {
    const catalogPath = path.join(fixture.root, "catalog/projects/example-app.yaml");
    const nativePath = path.join(fixture.target, ".devhub/project.yaml");
    const stewardship = (locator) => `stewards:\n  - id: product-team\n    name: Product team\n    kind: team\n    source: operator\ncredentials:\n  - id: example-api\n    provider: Example Provider\n    purpose: Fictional API access\n    secretRef:\n      kind: environment\n      locator: ${locator}\n    consumers: [web]\n    owner: product-team\n    source: operator\n`;
    const catalog = await readFile(catalogPath, "utf8");
    const native = await readFile(nativePath, "utf8");
    await writeFile(catalogPath, catalog.replace("services:\n", `${stewardship("CATALOG_API_KEY")}services:\n`));
    await writeFile(nativePath, native.replace("services:\n", `${stewardship("NATIVE_API_KEY")}services:\n`));
    const plan = await createReconciliationPlan(fixture.root, fixture.target, "example-laptop");
    const serialized = JSON.stringify(plan);
    const human = formatReconciliation(plan);
    assert.equal(plan.status, "drift");
    assert.equal(serialized.includes("CATALOG_API_KEY"), false);
    assert.equal(serialized.includes("NATIVE_API_KEY"), false);
    assert.equal(serialized.includes("secretRef.locator"), false);
    assert.equal(human.includes("CATALOG_API_KEY"), false);
    assert.equal(human.includes("NATIVE_API_KEY"), false);
    assert.equal(human.includes("secretRef.locator"), false);
    assert.ok(plan.diff.some((item) => item.path.endsWith("secretRef") && item.state === "changed"));
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("overlay proposal fails closed instead of serializing reviewed credential locators", async () => {
  const fixture = await createFixture({ catalogRegistration: "overlay", noNative: true });
  try {
    const catalogPath = path.join(fixture.root, "catalog/projects/example-app.yaml");
    const reviewed = (await readFile(catalogPath, "utf8")).replace(
      "services:\n",
      `stewards:\n  - id: team\n    name: Example team\n    kind: team\n    source: operator\ncredentials:\n  - id: example-api\n    provider: Example Provider\n    purpose: Fictional API access\n    secretRef:\n      kind: environment\n      locator: EXAMPLE_API_KEY\n    consumers: [web]\n    owner: team\n    source: operator\nservices:\n`,
    ).replace(
      "services:\n",
      `workspaces:\n  - host: example-laptop\n    path: ${JSON.stringify(fixture.target)}\nservices:\n`,
    );
    await writeFile(catalogPath, reviewed);
    const proposal = await createOverlayProposal(fixture.root, fixture.target, "example-laptop");
    assert.equal(proposal.status, "invalid");
    assert.equal(proposal.error.code, "credential-bearing-overlay-proposal");
    assert.equal(JSON.stringify(proposal).includes("EXAMPLE_API_KEY"), false);
    assert.equal(proposal.candidate, null);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("explicit native apply refreshes generated output and is idempotent", async () => {
  const fixture = await createFixture({ catalogTitle: "Old title", nativeTitle: "Reviewed title" });
  try {
    const first = await applyNativeReconciliation({
      root: fixture.root,
      target: fixture.target,
      runtimeHostId: "example-laptop",
      runCompiler: () => compileFixture(fixture.root),
    });
    assert.equal(first.status, "clean");
    assert.equal(first.application.applied, true);
    assert.equal(parse(await readFile(path.join(fixture.root, "catalog/projects/example-app.yaml"), "utf8")).title, "Reviewed title");
    assert.match(await readFile(path.join(fixture.root, "public/catalog.json"), "utf8"), /Reviewed title/);

    const catalogAfterFirstApply = await readFile(path.join(fixture.root, "catalog/projects/example-app.yaml"), "utf8");
    const second = await applyNativeReconciliation({
      root: fixture.root,
      target: fixture.target,
      runtimeHostId: "example-laptop",
      runCompiler: () => compileFixture(fixture.root),
    });
    assert.equal(second.application.applied, false);
    assert.equal(second.application.reason, "already-in-sync");
    assert.equal(await readFile(path.join(fixture.root, "catalog/projects/example-app.yaml"), "utf8"), catalogAfterFirstApply);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("failed generated refresh rolls the entire reconciliation back", async () => {
  const fixture = await createFixture({ catalogTitle: "Old title", nativeTitle: "Reviewed title" });
  try {
    const catalogBefore = await readFile(path.join(fixture.root, "catalog/projects/example-app.yaml"), "utf8");
    const generatedBefore = await readFile(path.join(fixture.root, "app/generated/catalog.json"), "utf8");
    const publicBefore = await readFile(path.join(fixture.root, "public/catalog.json"), "utf8");
    await assert.rejects(
      applyNativeReconciliation({
        root: fixture.root,
        target: fixture.target,
        runtimeHostId: "example-laptop",
        runCompiler: async () => {
          await writeFile(path.join(fixture.root, "app/generated/catalog.json"), "partial-write\n");
          await writeFile(path.join(fixture.root, "public/catalog.json"), "partial-write\n");
          throw new Error("synthetic compiler failure");
        },
      }),
      (error) => error instanceof ReconciliationApplyError && error.code === "apply-failed" && /rolled back/.test(error.message),
    );
    assert.equal(await readFile(path.join(fixture.root, "catalog/projects/example-app.yaml"), "utf8"), catalogBefore);
    assert.equal(await readFile(path.join(fixture.root, "app/generated/catalog.json"), "utf8"), generatedBefore);
    assert.equal(await readFile(path.join(fixture.root, "public/catalog.json"), "utf8"), publicBefore);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("ownership conflicts remain invalid and never modify the external project", async () => {
  for (const options of [{ catalogRegistration: "overlay" }]) {
    const fixture = await createFixture(options);
    try {
      const nativePath = path.join(fixture.target, ".devhub/project.yaml");
      const before = await readFile(nativePath, "utf8");
      const plan = await createReconciliationPlan(fixture.root, fixture.target, "example-laptop");
      assert.equal(plan.status, "invalid");
      assert.equal(plan.exitCode, RECONCILIATION_EXIT.invalid);
      assert.equal(plan.reviewRequired, true);
      assert.equal(plan.proposal.status, "review-required");
      assert.deepEqual(plan.proposal.omittedUnverifiedFields, ["id", "hosts", "service URLs", "commands"]);
      await assert.rejects(
        applyNativeReconciliation({
          root: fixture.root,
          target: fixture.target,
          runtimeHostId: "example-laptop",
          runCompiler: () => compileFixture(fixture.root),
        }),
        ReconciliationApplyError,
      );
      assert.equal(await readFile(nativePath, "utf8"), before);
    } finally {
      await rm(fixture.temporary, { recursive: true, force: true });
    }
  }
});

test("overlay and unregistered projects return review proposals instead of invalid native errors", async () => {
  for (const options of [
    { catalogRegistration: "overlay", noNative: true, matchWorkspace: true, expectedAction: "review-overlay" },
    { unregistered: true, expectedAction: "review-registration" },
    { unregistered: true, noNative: true, expectedAction: "review-registration" },
  ]) {
    const fixture = await createFixture(options);
    try {
      if (options.matchWorkspace) {
        const catalogPath = path.join(fixture.root, "catalog/projects/example-app.yaml");
        const contents = await readFile(catalogPath, "utf8");
        await writeFile(catalogPath, contents.replace(
          "services:\n",
          `workspaces:\n  - host: example-laptop\n    path: ${JSON.stringify(fixture.target)}\nservices:\n`,
        ));
      }
      const plan = await createReconciliationPlan(fixture.root, fixture.target, "example-laptop");
      assert.equal(plan.status, "review-required");
      assert.equal(plan.exitCode, RECONCILIATION_EXIT.drift);
      assert.equal(plan.plan.action, options.expectedAction);
      assert.equal(plan.plan.applicable, false);
      assert.equal(plan.error, null);
      assert.equal(plan.proposal.status, "review-required");
      await assert.rejects(
        applyNativeReconciliation({
          root: fixture.root,
          target: fixture.target,
          runtimeHostId: "example-laptop",
          runCompiler: () => compileFixture(fixture.root),
        }),
        ReconciliationApplyError,
      );
    } finally {
      await rm(fixture.temporary, { recursive: true, force: true });
    }
  }
});

test("explicit roots ignore ambient external catalog configuration", async () => {
  const fixture = await createFixture({ catalogTitle: "Old title", nativeTitle: "Reviewed title" });
  const external = await createFixture({ catalogTitle: "External live title", nativeTitle: "External native title" });
  const previous = process.env.DEVHUB_CATALOG_DIR;
  process.env.DEVHUB_CATALOG_DIR = path.join(external.root, "catalog");
  try {
    const externalPath = path.join(external.root, "catalog/projects/example-app.yaml");
    const externalBefore = await readFile(externalPath, "utf8");
    const result = await applyNativeReconciliation({
      root: fixture.root,
      target: fixture.target,
      runtimeHostId: "example-laptop",
      runCompiler: () => compileFixture(fixture.root),
    });
    assert.equal(result.application.applied, true);
    assert.equal(await readFile(externalPath, "utf8"), externalBefore);
    assert.equal(parse(await readFile(path.join(fixture.root, "catalog/projects/example-app.yaml"), "utf8")).title, "Reviewed title");
  } finally {
    if (previous === undefined) delete process.env.DEVHUB_CATALOG_DIR;
    else process.env.DEVHUB_CATALOG_DIR = previous;
    await rm(fixture.temporary, { recursive: true, force: true });
    await rm(external.temporary, { recursive: true, force: true });
  }
});

test("exact native id wins over conflicting workspace evidence", async () => {
  const fixture = await createFixture({ catalogTitle: "Old title", nativeTitle: "Reviewed title" });
  try {
    const conflicting = manifest({ registration: "overlay" }).replace(
      "services:\n",
      `workspaces:\n  - host: example-laptop\n    path: ${JSON.stringify(fixture.target)}\nservices:\n`,
    ).replace("id: example-app", "id: a-conflict");
    await writeFile(path.join(fixture.root, "catalog/projects/a-conflict.yaml"), conflicting);
    const plan = await createReconciliationPlan(fixture.root, fixture.target, "example-laptop");
    assert.equal(plan.status, "drift");
    assert.equal(plan.match.project.id, "example-app");
    assert.equal(plan.match.matchType, "native-id");
    assert.match(plan.plan.destination, /example-app\.yaml$/);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("ambiguous best-tier matches block reconciliation", async () => {
  const fixture = await createFixture({ unregistered: true, noNative: true });
  try {
    for (const id of ["first-overlay", "second-overlay"]) {
      const overlay = manifest({ registration: "overlay" })
        .replace("id: example-app", `id: ${id}`)
        .replace("services:\n", `workspaces:\n  - host: example-laptop\n    path: ${JSON.stringify(fixture.target)}\nservices:\n`);
      await writeFile(path.join(fixture.root, `catalog/projects/${id}.yaml`), overlay);
    }
    const plan = await createReconciliationPlan(fixture.root, fixture.target, "example-laptop");
    assert.equal(plan.status, "invalid");
    assert.equal(plan.error.code, "ambiguous-catalog-match");
    assert.equal(plan.error.candidates.length, 2);
    assert.equal(plan.plan.applicable, false);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("rollback preserves an outside edit and reports a conflict", async () => {
  const fixture = await createFixture({ catalogTitle: "Old title", nativeTitle: "Reviewed title" });
  try {
    const destination = path.join(fixture.root, "catalog/projects/example-app.yaml");
    const concurrent = manifest({ title: "Concurrent reviewed edit" });
    await assert.rejects(
      applyNativeReconciliation({
        root: fixture.root,
        target: fixture.target,
        runtimeHostId: "example-laptop",
        runCompiler: async () => {
          await writeFile(destination, concurrent);
          throw new Error("synthetic compiler failure after outside edit");
        },
      }),
      (error) => error instanceof ReconciliationApplyError
        && error.code === "rollback-conflict"
        && /changed outside/.test(error.message),
    );
    assert.equal(await readFile(destination, "utf8"), concurrent);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("catalog mutation lock blocks concurrent apply", async () => {
  const fixture = await createFixture({ catalogTitle: "Old title", nativeTitle: "Reviewed title" });
  const lockPath = path.join(fixture.root, "catalog/.devhub-mutation.lock");
  try {
    await writeFile(lockPath, "existing transaction\n");
    await assert.rejects(
      applyNativeReconciliation({
        root: fixture.root,
        target: fixture.target,
        runtimeHostId: "example-laptop",
        runCompiler: () => compileFixture(fixture.root),
      }),
      (error) => error instanceof ReconciliationApplyError && error.code === "catalog-locked",
    );
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("first registration is native-only, atomic and never overwrites", async () => {
  const fresh = await createFixture({ unregistered: true });
  const existing = await createFixture({ catalogTitle: "Reviewed central title", nativeTitle: "Different native title" });
  const overlay = await createFixture({ unregistered: true, nativeRegistration: "overlay" });
  try {
    const registered = await registerNativeManifest({
      root: fresh.root,
      target: fresh.target,
      runCompiler: () => compileFixture(fresh.root),
    });
    assert.equal(registered.id, "example-app");
    assert.equal(parse(await readFile(registered.destination, "utf8")).title, "Example app");

    const existingPath = path.join(existing.root, "catalog/projects/example-app.yaml");
    const existingBefore = await readFile(existingPath, "utf8");
    await assert.rejects(
      registerNativeManifest({ root: existing.root, target: existing.target, runCompiler: () => compileFixture(existing.root) }),
      (error) => error instanceof ReconciliationApplyError && error.code === "already-registered",
    );
    assert.equal(await readFile(existingPath, "utf8"), existingBefore);

    await assert.rejects(
      registerNativeManifest({ root: overlay.root, target: overlay.target, runCompiler: () => compileFixture(overlay.root) }),
      (error) => error instanceof ReconciliationApplyError && error.code === "registration-boundary",
    );
    await assert.rejects(readFile(path.join(overlay.root, "catalog/projects/example-app.yaml"), "utf8"), /ENOENT/);
  } finally {
    await Promise.all([fresh, existing, overlay].map((fixture) => rm(fixture.temporary, { recursive: true, force: true })));
  }
});
