import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";
import {
  CatalogValidationError,
  validateHostsDocument,
  validateProjectDocument,
} from "../scripts/catalog-validation.mjs";

const root = path.resolve(import.meta.dirname, "..");

async function readYaml(filename) {
  return parse(await readFile(filename, "utf8"));
}

test("strict schemas describe valid JSON Schema documents", async () => {
  for (const name of ["hosts.schema.json", "project.schema.json"]) {
    const schema = JSON.parse(await readFile(path.join(root, "schema", name), "utf8"));
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
  }
});

test("credential reference JSON Schema patterns stay in parity with manual validation", async () => {
  const schema = JSON.parse(await readFile(path.join(root, "schema/project.schema.json"), "utf8"));
  const reference = schema.$defs.credentialRef;
  const patternByKind = Object.fromEntries(reference.allOf.map((condition) => [
    condition.if.properties.kind.const,
    new RegExp(condition.then.properties.locator.pattern),
  ]));
  const unsafe = new RegExp(reference.properties.locator.not.pattern, "i");
  const cases = [
    ["environment", "EXAMPLE_API_KEY", true],
    ["environment", "literal-value", false],
    ["keychain", "generic-password:devhub:example", true],
    ["keychain", ["generic-password:", "sk-", "proj-", "abcdefghijklmnop:example"].join(""), false],
    ["secret-manager", "op://Example/App/value", true],
    ["secret-manager", ["op://Example/App/", "sk-", "proj-", "abcdefghijklmnop"].join(""), false],
    ["secret-manager", "op://Example/App/eyJaaaaaa.eyJbbbbbb.eyJcccccc", false],
    ["secret-manager", ["op://Example/App/", "to", "ken=", "abcdefghijklmnop"].join(""), false],
  ];
  for (const [kind, locator, expected] of cases) {
    const schemaAccepts = patternByKind[kind].test(locator) && !unsafe.test(locator);
    assert.equal(schemaAccepts, expected, `${kind}:${locator}`);
    const project = {
      version: 1, id: "example", title: "Example", registration: "overlay", description: "Example",
      lifecycle: "active", kind: "product",
      stewards: [{ id: "owner", name: "Owner", kind: "person", source: "operator" }],
      credentials: [{ id: "api", provider: "Example", purpose: "Fixture", secretRef: { kind, locator }, consumers: [], owner: "owner", source: "operator" }],
      services: [],
    };
    let manualAccepts = true;
    try { validateProjectDocument(project, { source: "parity.yaml" }); } catch { manualAccepts = false; }
    assert.equal(manualAccepts, schemaAccepts, `${kind}:${locator} manual/schema parity`);
  }
});

test("strict validation accepts the complete reviewed catalog", async () => {
  const hosts = await readYaml(path.join(root, "catalog/hosts.yaml"));
  const { hostIds } = validateHostsDocument(hosts, "catalog/hosts.yaml");
  const projectDirectory = path.join(root, "catalog/projects");
  const files = (await readdir(projectDirectory)).filter((file) => file.endsWith(".yaml"));

  for (const file of files) {
    validateProjectDocument(await readYaml(path.join(projectDirectory, file)), {
      source: `catalog/projects/${file}`,
      hostIds,
      expectedId: file.replace(/\.yaml$/, ""),
    });
  }
});

test("public demo exercises project readiness defaults without native/catalog drift", async () => {
  const hosts = await readYaml(path.join(root, "examples/demo/catalog/hosts.yaml"));
  const { hostIds } = validateHostsDocument(hosts, "examples/demo/catalog/hosts.yaml");
  const catalogProject = await readYaml(path.join(root, "examples/demo/catalog/projects/example-app.yaml"));
  const nativeProject = await readYaml(path.join(root, "examples/demo/.devhub/project.yaml"));

  assert.deepEqual(nativeProject, catalogProject);
  assert.equal(catalogProject.readinessDefaults.profile, "personal");
  assert.equal(catalogProject.services[1].readiness.profile, "customer-facing");
  assert.equal(catalogProject.services[1].readiness.owner, undefined);
  assert.doesNotThrow(() => validateProjectDocument(catalogProject, {
    source: "examples/demo/catalog/projects/example-app.yaml",
    hostIds,
    expectedId: "example-app",
  }));
});

test("strict validation reports the source and exact invalid field", () => {
  const project = {
    version: 1,
    id: "example-app",
    title: "Example app",
    registration: "overlay",
    description: "Example",
    lifecycle: "active",
    kind: "product",
    services: [{
      id: "web",
      name: "Web",
      kind: "web",
      environment: "local",
      host: "developer-laptop",
      runtime: "node",
      mode: "on-demand",
      visibility: "local",
      probe: {
        type: "http",
        url: "file:///etc/passwd",
        successStatuses: [200],
        timeoutMs: 1,
      },
    }],
  };

  assert.throws(
    () => validateProjectDocument(project, {
      source: "catalog/projects/example-app.yaml",
      hostIds: new Set(["developer-laptop"]),
      expectedId: "example-app",
    }),
    (error) => error instanceof CatalogValidationError
      && error.message === "catalog/projects/example-app.yaml: services[0].probe.url: must use http or https",
  );

  project.services[0].probe.url = "http://127.0.0.1:3000/health";
  assert.throws(
    () => validateProjectDocument(project, {
      source: "catalog/projects/example-app.yaml",
      hostIds: new Set(["developer-laptop"]),
      expectedId: "example-app",
    }),
    /services\[0\]\.probe\.timeoutMs: must be an integer from 100 to 60000/,
  );
});

test("reviewed Tailscale Serve publishers are path-specific and match the HTTPS probe", async () => {
  const project = {
    version: 1,
    id: "example-app",
    title: "Example app",
    registration: "overlay",
    description: "Example",
    lifecycle: "active",
    kind: "product",
    services: [{
      id: "web",
      name: "Web",
      kind: "web",
      environment: "local",
      host: "developer-laptop",
      runtime: "node",
      mode: "always-on",
      visibility: "local",
      probe: {
        type: "http",
        url: "https://developer-laptop.example.test/health/example",
        successStatuses: [200],
        publish: {
          type: "tailscale-serve",
          visibility: "tailnet",
          targetUrl: "http://127.0.0.1:3000/api/health",
          path: "/health/example",
        },
      },
    }],
  };
  const validate = () => validateProjectDocument(project, {
    source: "catalog/projects/example-app.yaml",
    hostIds: new Set(["developer-laptop"]),
    expectedId: "example-app",
  });
  assert.doesNotThrow(validate);

  const publisherSchema = JSON.parse(await readFile(path.join(root, "schema/project.schema.json"), "utf8")).$defs.probePublisher;
  const targetSchema = publisherSchema.properties.targetUrl;
  for (const [targetUrl, expected] of [
    ["http://127.0.0.1:3000/api/health", true],
    ["http://127.0.0.1:65535/api/health", true],
    ["http://127.0.0.1:99999/api/health", false],
    ["http://127.0.0.1:3000/", false],
    ["http://127.0.0.1:3000/api//health", false],
    ["http://127.0.0.1:3000/api/../health", false],
    ["http://127.0.0.1:3000/api/health?fixture=value", false],
  ]) {
    project.services[0].probe.publish.targetUrl = targetUrl;
    const schemaAccepts = new RegExp(targetSchema.pattern).test(targetUrl)
      && !new RegExp(targetSchema.not.pattern).test(targetUrl);
    let manualAccepts = true;
    try { validate(); } catch { manualAccepts = false; }
    assert.equal(schemaAccepts, expected, targetUrl);
    assert.equal(manualAccepts, schemaAccepts, `${targetUrl} manual/schema parity`);
  }

  project.services[0].probe.publish.targetUrl = "http://192.168.1.5:3000/api/health";
  assert.throws(validate, /publish\.targetUrl: must be a path-specific http:\/\/127\.0\.0\.1 loopback URL/);

  project.services[0].probe.publish.targetUrl = "http://127.0.0.1:3000/api/health";
  project.services[0].probe.publish.visibility = "local";
  assert.throws(validate, /publish\.visibility: must be tailnet/);

  project.services[0].probe.publish.visibility = "tailnet";
  const pathSchema = publisherSchema.properties.path;
  for (const [publisherPath, expected] of [
    ["/health/example", true],
    ["/health//example", false],
    ["/health/../example", false],
    ["/", false],
  ]) {
    project.services[0].probe.publish.path = publisherPath;
    const schemaAccepts = new RegExp(pathSchema.pattern).test(publisherPath)
      && !new RegExp(pathSchema.not.pattern).test(publisherPath);
    assert.equal(schemaAccepts, expected, publisherPath);
  }
  project.services[0].probe.publish.path = "/health/other";
  assert.throws(validate, /probe\.url: must be an HTTPS URL with exactly the published Tailscale Serve path/);
});

test("strict validation rejects filename drift, unknown fields and unsupported commands", () => {
  const base = {
    version: 1,
    id: "example-app",
    title: "Example app",
    registration: "native",
    description: "Example",
    lifecycle: "active",
    kind: "product",
    services: [],
  };

  assert.throws(
    () => validateProjectDocument(base, { source: "wrong.yaml", expectedId: "wrong" }),
    /wrong\.yaml: id: must match filename wrong\.yaml/,
  );
  assert.throws(
    () => validateProjectDocument({ ...base, mystery: true }, { source: "example-app.yaml" }),
    /\$root\.mystery: is not a supported field/,
  );
  assert.throws(
    () => validateProjectDocument({
      ...base,
      services: [{
        id: "web",
        name: "Web",
        kind: "web",
        environment: "local",
        host: "developer-laptop",
        runtime: "node",
        mode: "on-demand",
        visibility: "local",
        commands: { erase: "rm -rf data" },
      }],
    }, { source: "example-app.yaml", hostIds: new Set(["developer-laptop"]) }),
    /services\[0\]\.commands\.erase: is not a supported field/,
  );
});

test("strict validation rejects secret-bearing URLs and commands", () => {
  const secret = ["abcdefgh", "ijklmnop"].join("");
  const password = ["pass", "word"].join("");
  const tokenQuery = ["to", "ken"].join("");
  const accessTokenQuery = ["access", "_token"].join("");
  const project = {
    version: 1,
    id: "example-app",
    title: "Example app",
    registration: "native",
    description: "Example",
    lifecycle: "active",
    kind: "product",
    services: [{
      id: "web",
      name: "Web",
      kind: "web",
      environment: "local",
      host: "developer-laptop",
      runtime: "node",
      mode: "on-demand",
      visibility: "local",
      url: `https://user:${password}@example.test`,
    }],
  };
  const options = { source: "example-app.yaml", hostIds: new Set(["developer-laptop"]) };

  assert.throws(() => validateProjectDocument(project, options), /services\[0\]\.url: must not contain URL credentials/);
  project.services[0].url = `https://example.test/callback?${tokenQuery}=${secret}`;
  assert.throws(() => validateProjectDocument(project, options), /secret-bearing query parameter token/);
  project.services[0].url = "https://example.test";
  project.services[0].commands = { start: `API_KEY=${secret} npm start` };
  assert.throws(() => validateProjectDocument(project, options), /inline secret assignment/);
  project.services[0].commands = { start: `curl https://example.test/start?${accessTokenQuery}=${secret}` };
  assert.throws(() => validateProjectDocument(project, options), /secret-bearing query parameter access_token/);
  project.services[0].commands = { start: "API_KEY=$API_KEY npm start" };
  assert.doesNotThrow(() => validateProjectDocument(project, options));
});

test("strict validation accepts typed service links and rejects unsafe or unstable links", () => {
  const project = {
    version: 1,
    id: "example-app",
    title: "Example app",
    registration: "native",
    description: "Example",
    lifecycle: "active",
    kind: "product",
    services: [{
      id: "web",
      name: "Web",
      kind: "web",
      environment: "local",
      host: "developer-laptop",
      runtime: "node",
      mode: "on-demand",
      visibility: "local",
      url: "https://app.example.test",
      links: [
        { id: "primary", type: "primary", label: "Open application", url: "https://app.example.test" },
        { id: "docs", type: "docs", label: "Documentation", url: "https://docs.example.test/app" },
      ],
    }],
  };
  const options = { source: "example-app.yaml", hostIds: new Set(["developer-laptop"]) };
  const credential = ["pass", "word"].join("");
  const tokenKey = ["access", "_token"].join("");

  assert.doesNotThrow(() => validateProjectDocument(project, options));

  project.services[0].links[1].id = "primary";
  assert.throws(() => validateProjectDocument(project, options), /links\[1\]\.id: duplicates link primary/);
  project.services[0].links[1].id = "docs";
  project.services[0].links[1].type = "ssh";
  assert.throws(() => validateProjectDocument(project, options), /links\[1\]\.type: must be one of/);
  project.services[0].links[1].type = "docs";
  project.services[0].links[1].url = "file:///etc/passwd";
  assert.throws(() => validateProjectDocument(project, options), /links\[1\]\.url: must use http or https/);
  project.services[0].links[1].url = `https://user:${credential}@example.test/docs`;
  assert.throws(() => validateProjectDocument(project, options), /links\[1\]\.url: must not contain URL credentials/);
  project.services[0].links[1].url = `https://docs.example.test/app?${tokenKey}=redacted-value`;
  assert.throws(() => validateProjectDocument(project, options), /links\[1\]\.url: must not contain secret-bearing query parameter access_token/);
});

test("strict validation accepts evidence-backed App Passports and rejects unsafe evidence", () => {
  const project = {
    version: 1,
    id: "example-app",
    title: "Example app",
    registration: "native",
    description: "Example",
    lifecycle: "active",
    kind: "product",
    services: [{
      id: "web",
      name: "Web",
      kind: "web",
      environment: "production",
      host: "managed-cloud",
      runtime: "managed",
      mode: "managed",
      visibility: "authenticated",
      readiness: {
        profile: "customer-facing",
        evidence: [{
          id: "restore-review",
          check: "restore",
          state: "verified",
          source: "operator",
          note: "A fictional restore exercise completed successfully.",
          observedAt: "2026-08-01T10:00:00Z",
          validUntil: "2026-09-01T10:00:00Z",
          url: "https://evidence.example.test/restore-review",
        }],
      },
    }],
  };
  const options = { source: "example-app.yaml", hostIds: new Set(["managed-cloud"]) };

  assert.doesNotThrow(() => validateProjectDocument(project, options));
  project.services[0].readiness.evidence.push({ ...project.services[0].readiness.evidence[0] });
  assert.throws(() => validateProjectDocument(project, options), /duplicates evidence restore-review/);
  project.services[0].readiness.evidence.pop();
  project.services[0].readiness.evidence[0].validUntil = "2026-07-01T10:00:00Z";
  assert.throws(() => validateProjectDocument(project, options), /validUntil: must not be earlier than observedAt/);
  project.services[0].readiness.evidence[0].validUntil = "2026-09-01T10:00:00Z";
  project.services[0].readiness.evidence[0].url = "https://user:password@evidence.example.test/restore-review";
  assert.throws(() => validateProjectDocument(project, options), /readiness\.evidence\[0\]\.url: must not contain URL credentials/);
});

test("App Passport records non-secret ownership, deployment and dependency facts", () => {
  const project = {
    version: 1,
    id: "example-app",
    title: "Example app",
    registration: "native",
    description: "Example",
    lifecycle: "active",
    kind: "product",
    services: [{
      id: "api",
      name: "API",
      kind: "api",
      environment: "production",
      host: "managed-cloud",
      runtime: "managed",
      mode: "managed",
      visibility: "authenticated",
      readiness: {
        profile: "customer-facing",
        owner: "Example product owner",
        dataClassification: "personal",
        costModel: "metered",
        deployment: {
          source: "integration",
          provider: "Example Cloud",
          revision: "release-42",
          deployedAt: "2026-08-13T10:00:00Z",
          url: "https://deployments.example.test/release-42",
        },
        dependencies: [{
          id: "primary-database",
          kind: "data-store",
          name: "Primary database",
          criticality: "required",
          provider: "Example Database",
          url: "https://console.example.test/database",
          note: "Stores fictional customer records for the demo.",
        }],
        evidence: [],
      },
    }],
  };
  const options = { source: "example-app.yaml", hostIds: new Set(["managed-cloud"]) };

  assert.doesNotThrow(() => validateProjectDocument(project, options));
  project.services[0].readiness.dependencies.push({ ...project.services[0].readiness.dependencies[0] });
  assert.throws(() => validateProjectDocument(project, options), /duplicates dependency primary-database/);
  project.services[0].readiness.dependencies.pop();
  project.services[0].readiness.dependencies[0].url = "https://user:password@console.example.test/database";
  assert.throws(() => validateProjectDocument(project, options), /dependencies\[0\]\.url: must not contain URL credentials/);
});

test("project readiness defaults are additive, service overrides win and evidence remains service-scoped", () => {
  const project = {
    version: 1,
    id: "example-app",
    title: "Example app",
    registration: "overlay",
    description: "Example",
    lifecycle: "active",
    kind: "product",
    readinessDefaults: {
      profile: "internal",
      owner: "Example product team",
      dataClassification: "internal",
      costModel: "fixed",
    },
    services: [{
      id: "api",
      name: "API",
      kind: "api",
      environment: "production",
      host: "managed-cloud",
      runtime: "managed",
      mode: "managed",
      visibility: "authenticated",
      readiness: {
        profile: "customer-facing",
        dataClassification: "personal",
        evidence: [{
          id: "ownership-attestation",
          check: "ownership",
          state: "declared",
          source: "operator",
          note: "The project team reviewed the ownership boundary.",
          observedAt: "2026-08-13T10:00:00Z",
          validUntil: "2026-11-13T10:00:00Z",
        }],
      },
    }],
  };
  const options = { source: "example-app.yaml", hostIds: new Set(["managed-cloud"]) };

  assert.strictEqual(validateProjectDocument(project, options), project);
  assert.equal(project.services[0].readiness.owner, undefined);
  assert.equal(project.services[0].readiness.evidence.length, 1);

  project.readinessDefaults.evidence = [];
  assert.throws(() => validateProjectDocument(project, options), /readinessDefaults\.evidence: is not a supported field/);
  delete project.readinessDefaults.evidence;

  project.readinessDefaults = {};
  assert.throws(() => validateProjectDocument(project, options), /readinessDefaults: must contain at least one default/);
});

test("reviewed stewardship keeps roles, access and external credential references separate", () => {
  const project = {
    version: 1,
    id: "example-app",
    title: "Example app",
    registration: "overlay",
    description: "Example",
    lifecycle: "active",
    kind: "product",
    stewards: [
      { id: "product-team", name: "Product team", kind: "team", source: "operator" },
      { id: "founder", name: "Example founder", kind: "person", source: "operator" },
    ],
    stewardshipDefaults: { accountableOwner: "founder", operator: "product-team", billingOwner: "founder", credentialOwner: "product-team" },
    access: [
      { id: "repository", kind: "repository", subject: "example/app", access: "yes", source: "operator", note: "Repository access was reviewed separately." },
      { id: "provider", kind: "provider", subject: "Example Cloud workspace", access: "unknown", source: "agent", note: "Provider access was not inferred from repository access." },
      { id: "billing", kind: "billing", subject: "Example Cloud billing", access: "no", source: "operator", note: "Billing access was reviewed separately." },
    ],
    credentials: [{
      id: "mail-api",
      provider: "Example Mail",
      purpose: "Send fictional mail",
      secretRef: { kind: "environment", locator: "EXAMPLE_MAIL_API_KEY" },
      consumers: ["api"],
      owner: "product-team",
      payer: "founder",
      source: "operator",
    }],
    services: [{
      id: "api", name: "API", kind: "api", environment: "production", host: "managed-cloud", runtime: "managed", mode: "managed", visibility: "authenticated",
      stewardship: { operator: "founder" },
    }],
  };
  const options = { source: "example-app.yaml", hostIds: new Set(["managed-cloud"]) };
  assert.doesNotThrow(() => validateProjectDocument(project, options));

  project.credentials[0].consumers.push("api");
  assert.throws(() => validateProjectDocument(project, options), /duplicates consumer api/);
  project.credentials[0].consumers.pop();
  project.credentials[0].consumers.push("missing-service");
  assert.throws(() => validateProjectDocument(project, options), /references unknown service missing-service/);
  project.credentials[0].consumers.pop();
  project.credentials[0].payer = "missing-steward";
  assert.throws(() => validateProjectDocument(project, options), /references unknown steward missing-steward/);
  project.credentials[0].payer = "founder";
  project.services[0].stewardship.operator = "missing-steward";
  assert.throws(() => validateProjectDocument(project, options), /references unknown steward missing-steward/);
  project.services[0].stewardship.operator = null;
  assert.doesNotThrow(() => validateProjectDocument(project, options));
});

test("stewardship rejects secret material, unsafe references, future observations and duplicate identities", () => {
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const project = {
    version: 1,
    id: "example-app",
    title: "Example app",
    registration: "overlay",
    description: "Example",
    lifecycle: "active",
    kind: "product",
    stewards: [{ id: "owner", name: "Example owner", kind: "person", source: "operator" }],
    access: [{ id: "repository", kind: "repository", subject: "example/app", access: "yes", source: "operator", note: "Reviewed access." }],
    credentials: [{ id: "api", provider: "Example AI", purpose: "Inference", secretRef: { kind: "environment", locator: "EXAMPLE_AI_KEY" }, consumers: [], owner: "owner", source: "operator" }],
    services: [],
  };
  const options = { source: "example-app.yaml" };
  assert.doesNotThrow(() => validateProjectDocument(project, options));

  project.credentials[0].secretRef.locator = "literal-value";
  assert.throws(() => validateProjectDocument(project, options), /must name an uppercase environment variable/);
  project.credentials[0].secretRef = { kind: "keychain", locator: "generic-password:devhub:example" };
  assert.doesNotThrow(() => validateProjectDocument(project, options));
  project.credentials[0].secretRef = { kind: "secret-manager", locator: "op://Example/App/value" };
  assert.doesNotThrow(() => validateProjectDocument(project, options));
  for (const locator of [
    ["op://Example/App/", "sk-", "proj-", "abcdefghijklmnop"].join(""),
    "op://Example/App/Bearer-abcdefghijk",
    "op://Example/App/eyJaaaaaa.eyJbbbbbb.eyJcccccc",
    ["op://Example/App/", "post", "gresql://user:password@example.test/database"].join(""),
    ["op://Example/App/", "to", "ken=", "abcdefghijklmnop"].join(""),
  ]) {
    project.credentials[0].secretRef = { kind: "secret-manager", locator };
    assert.throws(() => validateProjectDocument(project, options), /credential material|non-secret op:\/\/ reference/);
  }
  project.credentials[0].secretRef = { kind: "secret-manager", locator: "op://Example/App/value" };

  const bearerHeader = ["Author", "ization: ", "Bea", "rer abcdefghijklmnopqrstuvwxyz"].join("");
  project.access[0].note = bearerHeader;
  assert.throws(() => validateProjectDocument(project, options), /credential material/);
  project.access[0].note = ["-----BEGIN ", "PRIVATE KEY-----", "\nfixture"].join("");
  assert.throws(() => validateProjectDocument(project, options), /credential material/);
  project.access[0].note = ["sk-", "proj-", "abcdefghijklmnop"].join("");
  assert.throws(() => validateProjectDocument(project, options), /credential material/);
  project.access[0].note = ["post", "gresql://user:password@example.test/database"].join("");
  assert.throws(() => validateProjectDocument(project, options), /credential material/);
  project.access[0].note = "See https://user:password@example.test";
  assert.throws(() => validateProjectDocument(project, options), /URL credentials/);
  const sensitiveQuery = ["to", "ken"].join("");
  project.access[0].note = `See https://example.test?a=1&${sensitiveQuery}=abcdefghijk`;
  assert.throws(() => validateProjectDocument(project, options), /secret-bearing query parameter token/);
  project.access[0].note = "Reviewed access.";

  project.stewards[0].observedAt = future;
  assert.throws(() => validateProjectDocument(project, options), /more than five minutes in the future/);
  delete project.stewards[0].observedAt;
  project.credentials[0].lastVerifiedAt = future;
  assert.throws(() => validateProjectDocument(project, options), /more than five minutes in the future/);
  delete project.credentials[0].lastVerifiedAt;

  project.stewards.push({ ...project.stewards[0] });
  assert.throws(() => validateProjectDocument(project, options), /duplicates steward owner/);
  project.stewards.pop();
  project.access.push({ ...project.access[0] });
  assert.throws(() => validateProjectDocument(project, options), /duplicates access fact repository/);
  project.access.pop();
  project.access.push({ ...project.access[0], id: "other-access", subject: "EXAMPLE/APP", access: "no" });
  assert.throws(() => validateProjectDocument(project, options), /duplicates logical repository access subject/);
  project.access.pop();
  project.credentials.push({ ...project.credentials[0] });
  assert.throws(() => validateProjectDocument(project, options), /duplicates credential api/);
  project.credentials.pop();
  project.credentials[0].source = "catalog";
  assert.throws(() => validateProjectDocument(project, options), /must be one of: operator, agent, integration/);
});

test("a service readiness profile may be inherited but remains required when no project default exists", () => {
  const project = {
    version: 1,
    id: "example-app",
    title: "Example app",
    registration: "overlay",
    description: "Example",
    lifecycle: "active",
    kind: "product",
    readinessDefaults: { profile: "personal" },
    services: [{
      id: "worker",
      name: "Worker",
      kind: "worker",
      environment: "production",
      host: "managed-cloud",
      runtime: "managed",
      mode: "managed",
      visibility: "internal",
      readiness: { evidence: [] },
    }],
  };
  const options = { source: "example-app.yaml", hostIds: new Set(["managed-cloud"]) };
  assert.doesNotThrow(() => validateProjectDocument(project, options));

  delete project.readinessDefaults;
  assert.throws(
    () => validateProjectDocument(project, options),
    /services\[0\]\.readiness\.profile: is required when readinessDefaults\.profile is absent/,
  );
});

test("strict validation accepts a canonical endpoint with a required host fallback", () => {
  const project = {
    version: 1,
    id: "example-app",
    title: "Example app",
    registration: "native",
    description: "Example",
    lifecycle: "active",
    kind: "product",
    services: [{
      id: "web",
      name: "Web",
      kind: "web",
      environment: "production",
      host: "server",
      runtime: "systemd",
      mode: "always-on",
      visibility: "tailnet",
      url: "https://server.example.test:8443",
      endpoint: {
        canonical: "https://app.example.test",
        fallback: "https://server.example.test:8443",
      },
    }],
  };
  const options = { source: "example-app.yaml", hostIds: new Set(["server"]) };

  assert.doesNotThrow(() => validateProjectDocument(project, options));

  delete project.services[0].endpoint.fallback;
  assert.throws(() => validateProjectDocument(project, options), /endpoint\.fallback: is required/);
  project.services[0].endpoint.fallback = "https://server.example.test:8443";
  project.services[0].endpoint.canonical = project.services[0].endpoint.fallback;
  assert.throws(() => validateProjectDocument(project, options), /canonical and fallback must be different URLs/);
  project.services[0].endpoint.canonical = "file:///etc/passwd";
  assert.throws(() => validateProjectDocument(project, options), /endpoint\.canonical: must use http or https/);
});
