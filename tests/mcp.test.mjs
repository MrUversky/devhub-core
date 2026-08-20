import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

const catalog = JSON.parse(await readFile(new URL("../app/generated/catalog.json", import.meta.url), "utf8"));
const projectFixture = catalog.projects.find((project) => project.services.some((service) => Object.keys(service.commands ?? {}).length)) ?? catalog.projects[0];
const serviceFixture = projectFixture.services.find((service) => Object.keys(service.commands ?? {}).length) ?? projectFixture.services[0];
const reportedFixture = catalog.projects.flatMap((project) => project.services.map((service) => ({ project, service })))
  .find(({ service }) => service.reported && !service.probe);
const endpointFixture = catalog.projects.flatMap((project) => project.services.map((service) => ({ project, service })))
  .find(({ service }) => service.endpoint);

function dataModule(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

async function loadMcpToolsWithCatalog(fixtureCatalog) {
  const source = await readFile(new URL("../lib/mcp-tools.ts", import.meta.url), "utf8");
  let output = transpileModule(source, {
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
  }).outputText;
  const catalogModule = dataModule(`
    export const catalog = ${JSON.stringify(fixtureCatalog)};
    export const serviceKey = (projectId, serviceId) => \`${"${projectId}"}/${"${serviceId}"}\`;
    export const resolveServiceEndpoint = (service) => service.url
      ? { url: service.url, source: "legacy-url", reason: "Fictional test endpoint." }
      : null;
  `);
  const statusModule = dataModule("export async function getCatalogStatuses() { return []; }");
  const readinessModule = new URL("../lib/readiness.mjs", import.meta.url).href;
  const stewardshipModule = new URL("../lib/stewardship.mjs", import.meta.url).href;
  output = output
    .replace(/(["'])@\/lib\/catalog\1/g, JSON.stringify(catalogModule))
    .replace(/(["'])@\/lib\/readiness\.mjs\1/g, JSON.stringify(readinessModule))
    .replace(/(["'])@\/lib\/stewardship\.mjs\1/g, JSON.stringify(stewardshipModule))
    .replace(/(["'])@\/lib\/status\1/g, JSON.stringify(statusModule));
  return import(dataModule(output));
}

const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("mcp-test", `${process.pid}-${Date.now()}`);
const { default: worker } = await import(workerUrl.href);

const environment = {
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
};
const context = { waitUntil() {}, passThroughOnException() {} };
let requestId = 0;

async function requestMcp(body, method = "POST", headers = {}) {
  const response = await worker.fetch(
    new Request("http://localhost/mcp", {
      method,
      headers: method === "POST" ? {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
        ...headers,
      } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }),
    environment,
    context,
  );
  const payload = response.status === 204 ? null : await response.json();
  return { response, payload };
}

async function mcpRequest(method, params = {}) {
  requestId += 1;
  const { response, payload } = await requestMcp({ jsonrpc: "2.0", id: requestId, method, params });
  assert.equal(response.status, 200);
  assert.equal(payload.jsonrpc, "2.0");
  assert.equal(payload.id, requestId);
  return payload;
}

async function callTool(name, args = {}) {
  const payload = await mcpRequest("tools/call", { name, arguments: args });
  return payload.result;
}

test("MCP initializes and advertises only read-only tools", async () => {
  const initialized = await mcpRequest("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "devhub-test", version: "1.0.0" },
  });
  assert.equal(initialized.result.serverInfo.name, "devhub");
  assert.match(initialized.result.instructions, /self-hosted read-only service registry/i);
  assert.match(initialized.result.instructions, /cannot mutate manifests/i);

  const listed = await mcpRequest("tools/list");
  const tools = listed.result.tools;
  assert.deepEqual(tools.map((tool) => tool.name), [
    "list_projects",
    "search_projects",
    "get_project",
    "get_service",
    "get_runbook",
    "get_status",
    "plan_reconciliation",
  ]);
  for (const tool of tools) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.annotations.idempotentHint, true);
    assert.equal(tool.annotations.openWorldHint, tool.name === "get_status");
  }
});

test("MCP catalog, runbook and reconciliation tools return reviewed structured data", async () => {
  const projects = await callTool("list_projects");
  assert.equal(projects.isError, undefined);
  assert.ok(projects.structuredContent.projects.some((project) => project.id === projectFixture.id));

  const search = await callTool("search_projects", { query: projectFixture.title });
  assert.ok(search.structuredContent.projects.some((project) => project.id === projectFixture.id));

  const project = await callTool("get_project", { projectId: projectFixture.id });
  assert.equal(project.structuredContent.registration, projectFixture.registration);
  assert.equal("commands" in project.structuredContent.services[0], false);
  assert.deepEqual(project.structuredContent.services[0].links, projectFixture.services[0].links ?? []);
  assert.deepEqual(project.structuredContent.services[0].readiness, projectFixture.services[0].readiness ?? null);
  assert.ok(project.structuredContent.services[0].readinessContext);
  assert.equal("score" in project.structuredContent.services[0].readinessAssessment, false);
  assert.ok(Array.isArray(project.structuredContent.services[0].readinessAssessment.gaps));

  const service = await callTool("get_service", { projectId: projectFixture.id, serviceId: serviceFixture.id });
  assert.equal(service.structuredContent.key, `${projectFixture.id}/${serviceFixture.id}`);
  assert.equal("commands" in service.structuredContent.service, false);
  assert.deepEqual(service.structuredContent.service.links, serviceFixture.links ?? []);
  assert.deepEqual(service.structuredContent.service.readiness, serviceFixture.readiness ?? null);
  assert.ok(service.structuredContent.service.readinessContext);
  assert.equal("score" in service.structuredContent.service.readinessAssessment, false);

  assert.ok(endpointFixture, "fixture catalog needs one service with endpoint selection");
  const endpointService = await callTool("get_service", {
    projectId: endpointFixture.project.id,
    serviceId: endpointFixture.service.id,
  });
  assert.deepEqual(endpointService.structuredContent.service.endpoint, endpointFixture.service.endpoint);
  const expectedEndpointSource = endpointFixture.service.endpoint.canonical ? "canonical" : "host-fallback";
  assert.equal(endpointService.structuredContent.service.selectedEndpoint.source, expectedEndpointSource);
  assert.equal(
    endpointService.structuredContent.service.selectedEndpoint.url,
    endpointFixture.service.endpoint.canonical ?? endpointFixture.service.endpoint.fallback,
  );

  const runbook = await callTool("get_runbook", { projectId: projectFixture.id, serviceId: serviceFixture.id });
  assert.equal(runbook.structuredContent.executionPolicy, "copy-only");
  assert.deepEqual(runbook.structuredContent.commands, serviceFixture.commands);

  const plan = await callTool("plan_reconciliation", {
    projectId: projectFixture.id,
    evidence: {
      ...(projectFixture.repository ? { repository: `https://github.com/${projectFixture.repository}.git` } : {}),
      runtimeHostId: "unregistered-host",
      serviceIds: [serviceFixture.id, "unregistered-service"],
    },
  });
  assert.equal(plan.structuredContent.readOnly, true);
  assert.equal(plan.structuredContent.reviewRequired, true);
  assert.ok(plan.structuredContent.findings.some((finding) => finding.state === "match"));
  assert.ok(plan.structuredContent.findings.some((finding) => finding.state === "mismatch"));
});

test("MCP summaries expose effective project defaults without inheriting service evidence", async () => {
  const inheritedService = {
    id: "inherited-worker",
    name: "Inherited worker",
    kind: "worker",
    environment: "production",
    host: "fixture-cloud",
    runtime: "managed",
    mode: "managed",
    visibility: "internal",
  };
  const overrideService = {
    ...inheritedService,
    id: "override-worker",
    name: "Override worker",
    readiness: {
      profile: "sensitive",
      owner: "Explicit service owner",
      evidence: [{
        id: "service-ownership",
        check: "ownership",
        state: "declared",
        source: "operator",
        note: "Service-specific ownership attestation.",
      }],
    },
  };
  const project = {
    version: 1,
    id: "inheritance-fixture",
    title: "Inheritance fixture",
    registration: "overlay",
    description: "Fictional MCP presentation fixture.",
    lifecycle: "active",
    kind: "product",
    readinessDefaults: {
      profile: "internal",
      owner: "Inherited project owner",
      dataClassification: "internal",
      costModel: "fixed",
    },
    services: [inheritedService, overrideService],
  };
  const tools = await loadMcpToolsWithCatalog({
    version: 1,
    hosts: [{ id: "fixture-cloud", name: "Fixture Cloud", kind: "cloud", location: "cloud" }],
    projects: [project],
  });

  const summary = tools.getProject(project.id);
  const inherited = summary.services.find((service) => service.id === inheritedService.id);
  assert.equal(inherited.readiness.profile, "internal");
  assert.equal(inherited.readiness.owner, "Inherited project owner");
  assert.equal(inherited.readinessContext.fields.profile.provenance, "project");
  assert.equal(inherited.readinessContext.fields.owner.provenance, "project");
  assert.equal(inherited.readinessContext.evidenceProvenance, "absent");
  assert.deepEqual(inherited.readiness.evidence, []);
  assert.equal(inherited.readiness.deployment, undefined);
  assert.equal(inherited.readiness.dependencies, undefined);
  assert.equal(inherited.readinessAssessment.checks.find((item) => item.check === "ownership").state, "unknown");

  const overridden = summary.services.find((service) => service.id === overrideService.id);
  assert.equal(overridden.readiness.profile, "sensitive");
  assert.equal(overridden.readiness.owner, "Explicit service owner");
  assert.equal(overridden.readinessContext.fields.profile.provenance, "service");
  assert.equal(overridden.readinessContext.fields.owner.provenance, "service");
  assert.equal(overridden.readinessContext.evidenceProvenance, "service");
  assert.equal(overridden.readiness.evidence.length, 1);

  assert.ok(tools.searchProjects("Inherited project owner").some((item) => item.id === project.id));
  assert.ok(tools.searchProjects("internal").some((item) => item.id === project.id));
});

test("MCP presents reviewed stewardship without serializing credential locators", async () => {
  const project = {
    version: 1,
    id: "stewardship-fixture",
    title: "Stewardship fixture",
    registration: "overlay",
    description: "Fictional stewardship fixture.",
    lifecycle: "active",
    kind: "product",
    stewards: [
      { id: "product-team", name: "Product team", kind: "team", source: "operator" },
      { id: "billing-owner", name: "Billing owner", kind: "person", source: "operator" },
    ],
    stewardshipDefaults: { accountableOwner: "product-team", operator: "product-team", billingOwner: "billing-owner", credentialOwner: "product-team" },
    access: [{ id: "repository", kind: "repository", subject: "example/app", access: "yes", source: "operator", note: "Reviewed separately." }],
    credentials: [{ id: "mail-api", provider: "Example Mail", purpose: "Send mail", secretRef: { kind: "secret-manager", locator: "op://Example/Mail/value" }, consumers: ["api"], owner: "product-team", payer: "billing-owner", source: "operator" }],
    services: [{ id: "api", name: "API", kind: "api", environment: "production", host: "fixture-cloud", runtime: "managed", mode: "managed", visibility: "authenticated" }],
  };
  const tools = await loadMcpToolsWithCatalog({
    version: 1,
    hosts: [{ id: "fixture-cloud", name: "Fixture Cloud", kind: "cloud", location: "cloud" }],
    projects: [project],
  });

  const result = tools.getProject(project.id);
  assert.equal(result.services[0].stewardship.roles.accountableOwner.steward.name, "Product team");
  assert.equal(result.services[0].stewardship.roles.accountableOwner.provenance, "project");
  assert.deepEqual(result.credentials[0].secretRef, { kind: "secret-manager", configured: true });
  assert.equal(JSON.stringify(result).includes("op://Example/Mail/value"), false);
  assert.ok(tools.searchProjects("Billing owner").some((item) => item.id === project.id));
});

test("MCP reports stale access and credential stewardship as unknown historical context", async () => {
  const project = {
    version: 1,
    id: "stale-stewardship",
    title: "Stale stewardship",
    registration: "overlay",
    description: "Fictional stale fixture.",
    lifecycle: "active",
    kind: "product",
    stewards: [{ id: "founder", name: "Founder", kind: "person", source: "operator", validUntil: "2000-01-01T00:00:00Z" }],
    stewardshipDefaults: { accountableOwner: "founder", operator: "founder", billingOwner: "founder", credentialOwner: "founder" },
    access: [{ id: "provider", kind: "provider", subject: "Example Cloud", access: "yes", source: "operator", note: "Historical.", validUntil: "2000-01-01T00:00:00Z" }],
    credentials: [{ id: "api", provider: "Example", purpose: "Fixture", secretRef: { kind: "environment", locator: "EXAMPLE_API_KEY" }, consumers: ["api"], owner: "founder", payer: "founder", source: "operator", rotationDueAt: "2000-01-01T00:00:00Z" }],
    services: [{ id: "api", name: "API", kind: "api", environment: "production", host: "fixture-cloud", runtime: "managed", mode: "managed", visibility: "authenticated", stewardship: { billingOwner: null } }],
  };
  const tools = await loadMcpToolsWithCatalog({
    version: 1,
    hosts: [{ id: "fixture-cloud", name: "Fixture Cloud", kind: "cloud", location: "cloud" }],
    projects: [project],
  });
  const result = tools.getProject(project.id);
  assert.equal(result.access[0].recordedAccess, "yes");
  assert.equal(result.access[0].access, "unknown");
  assert.equal(result.access[0].freshnessState, "stale");
  assert.equal(result.credentials[0].owner.state, "stale");
  assert.equal(result.credentials[0].payer.state, "stale");
  assert.equal(result.services[0].stewardship.roles.billingOwner.provenance, "explicit-unknown");
  assert.equal(result.services[0].stewardship.credentials[0].verificationState, "rotation-due");
  assert.equal(JSON.stringify(result).includes("EXAMPLE_API_KEY"), false);
});

test("MCP status probes only reviewed services and rejects arbitrary URL arguments", async () => {
  assert.ok(reportedFixture, "fixture catalog needs one reported service without a live probe");
  const status = await callTool("get_status", { projectId: reportedFixture.project.id, serviceId: reportedFixture.service.id });
  assert.equal(status.isError, undefined);
  assert.deepEqual(status.structuredContent.statuses.map((item) => item.key), [`${reportedFixture.project.id}/${reportedFixture.service.id}`]);
  assert.equal(status.structuredContent.statuses[0].reason, "reported");

  const arbitraryUrl = await callTool("get_status", { url: "http://169.254.169.254/latest/meta-data" });
  assert.equal(arbitraryUrl.isError, true);
  assert.match(arbitraryUrl.content[0].text, /unrecognized key|invalid/i);

  const unknownProject = await callTool("get_project", { projectId: "does-not-exist" });
  assert.equal(unknownProject.isError, true);
  assert.match(unknownProject.content[0].text, /Unknown project/);
});

test("MCP uses POST-only stateless HTTP semantics", async () => {
  for (const method of ["GET", "DELETE"]) {
    const { response, payload } = await requestMcp(null, method);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST, OPTIONS");
    assert.match(payload.error, /stateless Streamable HTTP/);
  }
  const { response, payload } = await requestMcp(null, "OPTIONS");
  assert.equal(response.status, 204);
  assert.equal(payload, null);
});

test("MCP bearer mode fails closed and accepts only the configured token", async () => {
  const previousMode = process.env.DEVHUB_MCP_AUTH_MODE;
  const previousToken = process.env.DEVHUB_MCP_TOKEN;
  const token = ["devhub", "test", "token", "with", "at", "least", "32", "bytes"].join("-");
  process.env.DEVHUB_MCP_AUTH_MODE = "bearer";
  process.env.DEVHUB_MCP_TOKEN = token;
  try {
    const body = {
      jsonrpc: "2.0",
      id: "auth-test",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "devhub-auth-test", version: "1.0.0" },
      },
    };
    const missing = await requestMcp(body);
    assert.equal(missing.response.status, 401);
    assert.equal(missing.response.headers.get("www-authenticate"), 'Bearer realm="devhub-mcp"');

    const invalid = await requestMcp(body, "POST", { authorization: "Bearer wrong-token" });
    assert.equal(invalid.response.status, 401);

    const valid = await requestMcp(body, "POST", { authorization: `Bearer ${token}` });
    assert.equal(valid.response.status, 200);
    assert.equal(valid.payload.result.serverInfo.name, "devhub");

    process.env.DEVHUB_MCP_TOKEN = "too-short";
    const misconfigured = await requestMcp(body, "POST", { authorization: "Bearer too-short" });
    assert.equal(misconfigured.response.status, 503);
  } finally {
    if (previousMode === undefined) delete process.env.DEVHUB_MCP_AUTH_MODE;
    else process.env.DEVHUB_MCP_AUTH_MODE = previousMode;
    if (previousToken === undefined) delete process.env.DEVHUB_MCP_TOKEN;
    else process.env.DEVHUB_MCP_TOKEN = previousToken;
  }
});

test("MCP invalid and removed none auth modes fail closed", async () => {
  const previousMode = process.env.DEVHUB_MCP_AUTH_MODE;
  try {
    process.env.DEVHUB_MCP_AUTH_MODE = "invalid";
    const invalid = await requestMcp({ jsonrpc: "2.0", id: "invalid-mode", method: "tools/list", params: {} });
    assert.equal(invalid.response.status, 503);

    process.env.DEVHUB_MCP_AUTH_MODE = "none";
    const none = await requestMcp({ jsonrpc: "2.0", id: "none-mode", method: "tools/list", params: {} });
    assert.equal(none.response.status, 503);
  } finally {
    if (previousMode === undefined) delete process.env.DEVHUB_MCP_AUTH_MODE;
    else process.env.DEVHUB_MCP_AUTH_MODE = previousMode;
  }
});
