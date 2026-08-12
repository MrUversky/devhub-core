import { catalog, resolveServiceEndpoint, serviceKey, type Project, type Service } from "@/lib/catalog";
import { evaluateReadiness } from "@/lib/readiness.mjs";
import { getCatalogStatuses } from "@/lib/status";

function requireProject(projectId: string) {
  const project = catalog.projects.find((candidate) => candidate.id === projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  return project;
}

function requireService(projectId: string, serviceId: string) {
  const project = requireProject(projectId);
  const service = project.services.find((candidate) => candidate.id === serviceId);
  if (!service) throw new Error(`Unknown service: ${projectId}/${serviceId}`);
  return { project, service };
}

function normalizeRepository(value: string | undefined) {
  if (!value) return null;
  const trimmed = value.trim().replace(/\.git$/, "");
  const ssh = trimmed.match(/^git@github\.com:(.+\/.+)$/);
  if (ssh) return ssh[1].toLowerCase();
  try {
    const url = new URL(trimmed);
    if (url.hostname === "github.com") return url.pathname.replace(/^\//, "").toLowerCase();
  } catch {
    // owner/repository is already the canonical catalog shape.
  }
  return trimmed.toLowerCase();
}

function serviceSummary(service: Service) {
  return {
    id: service.id,
    name: service.name,
    kind: service.kind,
    environment: service.environment,
    host: service.host,
    runtime: service.runtime,
    mode: service.mode,
    visibility: service.visibility,
    url: service.url ?? null,
    endpoint: service.endpoint ?? null,
    selectedEndpoint: resolveServiceEndpoint(service),
    readiness: service.readiness ?? null,
    readinessAssessment: evaluateReadiness(service.readiness),
    links: service.links ?? [],
    hasProbe: Boolean(service.probe),
    hasRunbook: Boolean(service.commands && Object.keys(service.commands).length),
  };
}

function projectSummary(project: Project) {
  return {
    id: project.id,
    title: project.title,
    description: project.description,
    lifecycle: project.lifecycle,
    kind: project.kind,
    registration: project.registration,
    repository: project.repository ?? null,
    tags: project.tags ?? [],
    services: project.services.map(serviceSummary),
  };
}

export function listProjects() {
  return catalog.projects.map(projectSummary);
}

export function searchProjects(query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return listProjects();
  return catalog.projects
    .filter((project) => [
      project.id,
      project.title,
      project.description,
      project.repository,
      ...(project.aliases ?? []),
      ...(project.tags ?? []),
      ...project.services.flatMap((service) => [
        service.id,
        service.name,
        service.kind,
        service.runtime,
        service.host,
        service.endpoint?.canonical,
        service.endpoint?.fallback,
        service.readiness?.profile,
        service.readiness?.owner,
        service.readiness?.dataClassification,
        service.readiness?.costModel,
        service.readiness?.deployment?.provider,
        service.readiness?.deployment?.revision,
        ...(service.readiness?.dependencies?.flatMap((dependency) => [
          dependency.id,
          dependency.kind,
          dependency.name,
          dependency.provider,
          dependency.criticality,
        ]) ?? []),
        ...(service.readiness?.evidence.flatMap((evidence) => [evidence.id, evidence.check, evidence.state, evidence.note]) ?? []),
        ...(service.links ?? []).flatMap((link) => [link.id, link.type, link.label, link.url]),
      ]),
    ].filter(Boolean).join(" ").toLowerCase().includes(needle))
    .map(projectSummary);
}

export function getProject(projectId: string) {
  return projectSummary(requireProject(projectId));
}

export function getService(projectId: string, serviceId: string) {
  const { project, service } = requireService(projectId, serviceId);
  const host = catalog.hosts.find((candidate) => candidate.id === service.host);
  return {
    key: serviceKey(project.id, service.id),
    project: { id: project.id, title: project.title, repository: project.repository ?? null },
    service: { ...serviceSummary(service), description: service.description ?? null },
    host: host ?? null,
  };
}

export function getRunbook(projectId: string, serviceId: string) {
  const { project, service } = requireService(projectId, serviceId);
  const workspace = project.workspaces?.find((candidate) => candidate.host === service.host)?.path ?? null;
  return {
    key: serviceKey(project.id, service.id),
    host: service.host,
    workspace,
    commands: service.commands ?? {},
    executionPolicy: "copy-only",
    note: "These reviewed commands are operator guidance. DevHub MCP never executes them.",
  };
}

export async function getStatus(projectId?: string, serviceId?: string) {
  if (serviceId && !projectId) throw new Error("serviceId requires projectId");
  if (projectId && serviceId) requireService(projectId, serviceId);
  else if (projectId) requireProject(projectId);
  const statuses = await getCatalogStatuses({ projectId, serviceId });
  return { checkedAt: new Date().toISOString(), statuses };
}

export type ReconciliationEvidence = {
  repository?: string;
  workspace?: string;
  runtimeHostId?: string;
  serviceIds?: string[];
};

export function planReconciliation(projectId: string, evidence: ReconciliationEvidence) {
  const project = requireProject(projectId);
  const findings: Array<{ field: string; state: "match" | "mismatch"; catalog: unknown; evidence: unknown }> = [];

  if (evidence.repository !== undefined) {
    findings.push({
      field: "repository",
      state: normalizeRepository(project.repository) === normalizeRepository(evidence.repository) ? "match" : "mismatch",
      catalog: project.repository ?? null,
      evidence: evidence.repository,
    });
  }
  if (evidence.workspace !== undefined) {
    const known = (project.workspaces ?? []).some((workspace) => workspace.path === evidence.workspace);
    findings.push({ field: "workspace", state: known ? "match" : "mismatch", catalog: project.workspaces ?? [], evidence: evidence.workspace });
  }
  if (evidence.runtimeHostId !== undefined) {
    const projectHosts = [...new Set([
      ...(project.workspaces ?? []).map((workspace) => workspace.host),
      ...project.services.map((service) => service.host),
    ])].sort();
    findings.push({
      field: "runtimeHostId",
      state: projectHosts.includes(evidence.runtimeHostId) ? "match" : "mismatch",
      catalog: projectHosts,
      evidence: evidence.runtimeHostId,
    });
  }
  if (evidence.serviceIds !== undefined) {
    const registered = project.services.map((service) => service.id).sort();
    const supplied = [...new Set(evidence.serviceIds)].sort();
    findings.push({
      field: "serviceIds",
      state: registered.length === supplied.length && registered.every((id, index) => id === supplied[index]) ? "match" : "mismatch",
      catalog: registered,
      evidence: supplied,
    });
  }

  return {
    projectId,
    readOnly: true,
    registration: project.registration,
    evidenceAccepted: Object.keys(evidence),
    findings,
    reviewRequired: findings.some((finding) => finding.state === "mismatch"),
    guidance: findings.length
      ? "Review mismatches against the project repository before proposing a manifest diff. This tool does not mutate the catalog."
      : "No evidence was supplied. Inspect the project first, then call this tool with structured evidence.",
  };
}
