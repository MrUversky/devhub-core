import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const catalog = JSON.parse(await readFile(new URL("../app/generated/catalog.json", import.meta.url), "utf8"));
const projectFixture = catalog.projects.find((project) => project.services.some((service) => Object.keys(service.commands ?? {}).length)) ?? catalog.projects[0];
const serviceFixture = projectFixture.services.find((service) => Object.keys(service.commands ?? {}).length) ?? projectFixture.services[0];
const reportedFixture = catalog.projects.flatMap((project) => project.services.map((service) => ({ project, service })))
  .find(({ service }) => service.reported && !service.probe);
const endpointFixture = catalog.projects.flatMap((project) => project.services.map((service) => ({ project, service })))
  .find(({ service }) => service.endpoint);

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
  assert.equal("score" in project.structuredContent.services[0].readinessAssessment, false);
  assert.ok(Array.isArray(project.structuredContent.services[0].readinessAssessment.gaps));

  const service = await callTool("get_service", { projectId: projectFixture.id, serviceId: serviceFixture.id });
  assert.equal(service.structuredContent.key, `${projectFixture.id}/${serviceFixture.id}`);
  assert.equal("commands" in service.structuredContent.service, false);
  assert.deepEqual(service.structuredContent.service.links, serviceFixture.links ?? []);
  assert.deepEqual(service.structuredContent.service.readiness, serviceFixture.readiness ?? null);
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
