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
