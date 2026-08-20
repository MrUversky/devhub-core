import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import packageMetadata from "../package.json" with { type: "json" };
import {
  getProject,
  getRunbook,
  getService,
  getStatus,
  listProjects,
  planReconciliation,
  searchProjects,
} from "@/lib/mcp-tools";

const id = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).describe("Stable kebab-case catalog ID");
const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const serviceLinkSchema = z.object({
  id,
  type: z.enum(["primary", "dashboard", "docs", "repository", "logs", "console"]),
  label: z.string(),
  url: z.string().url().regex(/^https?:\/\//),
});

const serviceEndpointSchema = z.object({
  canonical: z.string().url().regex(/^https?:\/\//).optional(),
  fallback: z.string().url().regex(/^https?:\/\//),
});

const selectedEndpointSchema = z.object({
  url: z.string().url().regex(/^https?:\/\//),
  source: z.enum(["canonical", "host-fallback", "primary-link", "legacy-url"]),
  reason: z.string(),
});

const readinessEvidenceSchema = z.object({
  id,
  check: z.enum(["monitoring", "alerting", "backup", "restore", "rollback", "security-review", "privacy", "ownership", "cost", "deployment"]),
  state: z.enum(["verified", "declared", "missing", "not-applicable", "unknown"]),
  source: z.enum(["operator", "agent", "integration", "catalog"]),
  note: z.string(),
  observedAt: z.string().optional(),
  validUntil: z.string().optional(),
  url: z.string().url().regex(/^https?:\/\//).optional(),
});

const passportDependencySchema = z.object({
  id,
  kind: z.enum(["data-store", "external-api", "auth", "payment", "messaging", "storage", "ai-model", "other"]),
  name: z.string(),
  criticality: z.enum(["required", "degraded", "optional"]),
  provider: z.string().optional(),
  url: z.string().url().regex(/^https?:\/\//).optional(),
  note: z.string().optional(),
});

const readinessSchema = z.object({
  profile: z.enum(["personal", "internal", "customer-facing", "sensitive"]).optional(),
  owner: z.string().optional(),
  dataClassification: z.enum(["none", "internal", "personal", "sensitive", "regulated", "unknown"]).optional(),
  costModel: z.enum(["free", "fixed", "metered", "unknown"]).optional(),
  deployment: z.object({
    source: z.enum(["operator", "agent", "integration", "catalog"]),
    provider: z.string().optional(),
    revision: z.string().optional(),
    deployedAt: z.string().optional(),
    url: z.string().url().regex(/^https?:\/\//).optional(),
  }).optional(),
  dependencies: z.array(passportDependencySchema).optional(),
  evidence: z.array(readinessEvidenceSchema),
});

const readinessFieldProvenanceSchema = z.enum(["service", "project", "absent"]);
const readinessContextSchema = z.object({
  fields: z.object({
    profile: z.object({
      value: z.enum(["personal", "internal", "customer-facing", "sensitive"]).nullable(),
      provenance: readinessFieldProvenanceSchema,
    }),
    owner: z.object({ value: z.string().nullable(), provenance: readinessFieldProvenanceSchema }),
    dataClassification: z.object({
      value: z.enum(["none", "internal", "personal", "sensitive", "regulated", "unknown"]).nullable(),
      provenance: readinessFieldProvenanceSchema,
    }),
    costModel: z.object({
      value: z.enum(["free", "fixed", "metered", "unknown"]).nullable(),
      provenance: readinessFieldProvenanceSchema,
    }),
  }),
  evidenceProvenance: z.enum(["service", "absent"]),
});

const readinessAssessmentItemSchema = z.object({
  check: z.enum(["monitoring", "alerting", "backup", "restore", "rollback", "security-review", "privacy", "ownership", "cost", "deployment"]),
  expected: z.boolean(),
  state: z.enum(["verified", "declared", "missing", "stale", "not-applicable", "unknown"]),
  evidence: readinessEvidenceSchema.nullable(),
  provenance: z.object({
    source: z.enum(["operator", "agent", "integration", "catalog"]),
    observedAt: z.string().optional(),
    validUntil: z.string().optional(),
    url: z.string().url().regex(/^https?:\/\//).optional(),
  }).nullable(),
  actionable: z.boolean(),
  action: z.string().nullable(),
});

const readinessAssessmentSchema = z.object({
  profile: z.enum(["personal", "internal", "customer-facing", "sensitive"]).nullable(),
  evaluatedAt: z.string(),
  checks: z.array(readinessAssessmentItemSchema),
  gaps: z.array(readinessAssessmentItemSchema.extend({ actionable: z.literal(true), action: z.string() })),
  counts: z.object({
    verified: z.number(),
    declared: z.number(),
    missing: z.number(),
    stale: z.number(),
    "not-applicable": z.number(),
    unknown: z.number(),
  }),
});

const serviceSummarySchema = z.object({
  id,
  name: z.string(),
  kind: z.string(),
  environment: z.string(),
  host: id,
  runtime: z.string(),
  mode: z.enum(["always-on", "on-demand", "managed", "internal"]),
  visibility: z.enum(["public", "authenticated", "tailnet", "local", "internal"]),
  url: z.string().nullable(),
  endpoint: serviceEndpointSchema.nullable(),
  selectedEndpoint: selectedEndpointSchema.nullable(),
  readiness: readinessSchema.nullable(),
  readinessContext: readinessContextSchema,
  readinessAssessment: readinessAssessmentSchema,
  links: z.array(serviceLinkSchema),
  hasProbe: z.boolean(),
  hasRunbook: z.boolean(),
});

const projectSummarySchema = z.object({
  id,
  title: z.string(),
  description: z.string(),
  lifecycle: z.enum(["discovery", "active", "production", "paused", "archived"]),
  kind: z.string(),
  registration: z.enum(["native", "overlay"]),
  repository: z.string().nullable(),
  tags: z.array(z.string()),
  services: z.array(serviceSummarySchema),
});

const statusSchema = z.object({
  key: z.string(),
  state: z.enum(["up", "down", "stopped", "degraded", "registered", "unknown", "protected"]),
  source: z.enum(["probe", "reported", "catalog"]),
  reason: z.enum(["live-probe", "reported", "catalog-only", "remote-loopback", "probe-timeout", "probe-failed"]),
  checkedAt: z.string(),
  observedAt: z.string().optional(),
  latencyMs: z.number().optional(),
  httpStatus: z.number().optional(),
  note: z.string().optional(),
  ageMs: z.number().nonnegative().optional(),
  freshness: z.enum(["fresh", "stale"]).optional(),
  refreshAfter: z.string().optional(),
});

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

export function createDevHubMcpServer() {
  const server = new McpServer(
    { name: "devhub", version: packageMetadata.version },
    {
      instructions:
        "DevHub is a self-hosted read-only service registry. Search before selecting a project or service. Treat live probes, reported state, and catalog-only state as different evidence, including freshness. Runbook commands are copy-only guidance and were not executed. This server cannot mutate manifests, run commands, or probe caller-supplied URLs; propose catalog changes through a reviewed Git diff.",
    },
  );

  server.registerTool("list_projects", {
    title: "List DevHub projects",
    description: "List reviewed projects and service summaries from the configured DevHub catalog.",
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({ projects: z.array(projectSummarySchema) }),
    annotations: readOnlyAnnotations,
  }, async () => result({ projects: listProjects() }));

  server.registerTool("search_projects", {
    title: "Search DevHub projects",
    description: "Search reviewed project and service metadata. This never scans hosts, ports, or repositories.",
    inputSchema: z.object({ query: z.string().trim().min(1).max(200) }).strict(),
    outputSchema: z.object({ query: z.string(), projects: z.array(projectSummarySchema) }),
    annotations: readOnlyAnnotations,
  }, async ({ query }) => result({ query, projects: searchProjects(query) }));

  server.registerTool("get_project", {
    title: "Get a DevHub project",
    description: "Get one reviewed project and its service summaries by stable project ID.",
    inputSchema: z.object({ projectId: id }).strict(),
    outputSchema: projectSummarySchema,
    annotations: readOnlyAnnotations,
  }, async ({ projectId }) => result(getProject(projectId)));

  server.registerTool("get_service", {
    title: "Get a DevHub service",
    description: "Get reviewed metadata for one registered service. Commands are available only through get_runbook.",
    inputSchema: z.object({ projectId: id, serviceId: id }).strict(),
    outputSchema: z.object({
      key: z.string(),
      project: z.object({ id, title: z.string(), repository: z.string().nullable() }),
      service: serviceSummarySchema.extend({ description: z.string().nullable() }),
      host: z.object({
        id,
        name: z.string(),
        kind: z.enum(["mac", "windows", "linux", "cloud"]),
        location: z.enum(["local", "remote", "cloud"]),
        tailscaleName: z.string().optional(),
        tailscaleIPv4: z.string().optional(),
      }).nullable(),
    }),
    annotations: readOnlyAnnotations,
  }, async ({ projectId, serviceId }) => result(getService(projectId, serviceId)));

  server.registerTool("get_runbook", {
    title: "Get service runbook",
    description: "Return reviewed copy-only operator commands for a service. This tool never executes commands.",
    inputSchema: z.object({ projectId: id, serviceId: id }).strict(),
    outputSchema: z.object({
      key: z.string(),
      host: id,
      workspace: z.string().nullable(),
      commands: z.record(z.string(), z.string()),
      executionPolicy: z.literal("copy-only"),
      note: z.string(),
    }),
    annotations: readOnlyAnnotations,
  }, async ({ projectId, serviceId }) => result(getRunbook(projectId, serviceId)));

  server.registerTool("get_status", {
    title: "Get service status",
    description: "Read centrally cached status for reviewed catalog services, refreshing only expired reviewed probes. Caller-provided URLs are not accepted.",
    inputSchema: z.object({
      projectId: id.optional(),
      serviceId: id.optional(),
    }).strict(),
    outputSchema: z.object({ checkedAt: z.string(), statuses: z.array(statusSchema) }),
    annotations: { ...readOnlyAnnotations, openWorldHint: true },
  }, async ({ projectId, serviceId }) => result(await getStatus(projectId, serviceId)));

  server.registerTool("plan_reconciliation", {
    title: "Plan catalog reconciliation",
    description: "Compare structured repository, workspace, host, and service-ID evidence with one reviewed record. Returns a review plan and never changes files.",
    inputSchema: z.object({
      projectId: id,
      evidence: z.object({
        repository: z.string().trim().min(1).max(300).optional(),
        workspace: z.string().trim().min(1).max(1000).optional(),
        runtimeHostId: id.optional(),
        serviceIds: z.array(id).max(100).optional(),
      }).strict(),
    }).strict(),
    outputSchema: z.object({
      projectId: id,
      readOnly: z.literal(true),
      registration: z.enum(["native", "overlay"]),
      evidenceAccepted: z.array(z.string()),
      findings: z.array(z.object({
        field: z.string(),
        state: z.enum(["match", "mismatch"]),
        catalog: z.unknown(),
        evidence: z.unknown(),
      })),
      reviewRequired: z.boolean(),
      guidance: z.string(),
    }),
    annotations: readOnlyAnnotations,
  }, async ({ projectId, evidence }) => result(planReconciliation(projectId, evidence)));

  return server;
}

export async function handleMcpRequest(request: Request) {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = createDevHubMcpServer();
  await server.connect(transport);
  const response = await transport.handleRequest(request);
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store, max-age=0");
  headers.set("x-content-type-options", "nosniff");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
