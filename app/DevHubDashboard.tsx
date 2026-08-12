"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Catalog, Host, LiveServiceStatus, Project, Service, ViewerContext } from "@/lib/catalog";
import { resolveServiceEndpoint, serviceKey } from "@/lib/catalog";

type StatusResponse = { observedAt: string; statuses: LiveServiceStatus[] };
type SelectedService = { project: Project; service: Service };

const lifecycleLabels: Record<string, string> = {
  discovery: "Discovery",
  active: "Active",
  production: "Production",
  paused: "Paused",
  archived: "Archived",
};

const stateLabels: Record<string, string> = {
  up: "LIVE",
  down: "UNREACHABLE",
  stopped: "STOPPED",
  degraded: "DEGRADED",
  registered: "NOT CHECKED",
  protected: "LOGIN",
  unknown: "NOT CHECKED",
  checking: "CHECKING",
};

const modeLabels: Record<string, string> = {
  "always-on": "Expected to stay online",
  "on-demand": "Started when needed",
  managed: "Managed by a cloud platform",
  internal: "Internal component",
};

const linkTypeLabels: Record<string, string> = {
  dashboard: "Dashboard",
  docs: "Documentation",
  repository: "Repository",
  logs: "Logs",
  console: "Console",
  primary: "Open",
};

const readinessLabels: Record<string, string> = {
  monitoring: "Monitoring",
  alerting: "Alerting",
  backup: "Backup",
  restore: "Restore tested",
  rollback: "Rollback",
  "security-review": "Security review",
  privacy: "Privacy",
  ownership: "Ownership",
  cost: "Cost boundary",
  deployment: "Deployment",
};

const profileLabels: Record<string, string> = {
  personal: "Personal",
  internal: "Internal business",
  "customer-facing": "Customer-facing",
  sensitive: "Sensitive data",
};

const devHubAgentRequest = `Use the DevHub plugin and its read-only MCP tools to register or update this project and its runnable services in the configured registry.

Search DevHub for an existing project and services before proposing anything. Then inspect the current project locally to infer the services, URLs, host, runtime, operating mode, health endpoints and safe start/restart/log guidance. Propose an App Passport with evidence for monitoring, backup, restore, rollback, security review, privacy, ownership and cost; mark anything you cannot verify as unknown rather than passing. If a record already exists, update it instead of creating a duplicate.

Use native registration only when we control the repository and the metadata belongs there; otherwise use a private DevHub overlay without changing the project repository. Keep separate machines or independently operated instances as separate services. Never put secrets in the catalog.

The MCP interface is read-only. Locate the registry checkout from the workspace or repository instructions and make catalog changes through a reviewed branch or pull request, never through a hidden control action. Ask me only for facts you cannot discover. Present the manifest diff, validate and test it, then publish the reviewed change and tell me how to open, start or recover the service.

If the DevHub tools are unavailable, tell me that the DevHub plugin needs to be installed; do not require a checkout at a machine-specific path.`;

function serviceMode(service: Service) {
  return service.mode;
}

function getInitialStatus(projectId: string, service: Service): LiveServiceStatus {
  return {
    key: serviceKey(projectId, service.id),
    state: service.probe ? "unknown" : (service.reported?.state ?? "registered"),
    source: service.reported ? "reported" : "catalog",
    reason: service.reported ? "reported" : "catalog-only",
    checkedAt: "",
    observedAt: service.reported?.observedAt,
    note: service.reported?.note,
  };
}

function matches(project: Project, query: string) {
  const haystack = [
    project.id,
    project.title,
    project.description,
    ...(project.aliases ?? []),
    ...(project.tags ?? []),
    ...project.services.flatMap((service) => [
      service.name,
      service.kind,
      service.runtime,
      service.host,
      ...(service.links ?? []).flatMap((link) => [link.label, link.type, link.url]),
    ]),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(query.trim().toLowerCase());
}

function isAttention(service: Service, status: LiveServiceStatus) {
  return serviceMode(service) === "always-on" && (status.state === "down" || status.state === "degraded");
}

function servicePlacement(service: Service, currentHostId: string | null) {
  if (!currentHostId) return { kind: "unknown" as const, label: "Current device unknown" };
  if (service.host === currentHostId) return { kind: "here" as const, label: "Here" };
  return { kind: "other-device" as const, label: "Other device" };
}

function canOpenHere(service: Service, currentHostId: string | null) {
  return Boolean(resolveServiceEndpoint(service) && (service.visibility !== "local" || service.host === currentHostId));
}

function isEvidenceStale(validUntil?: string) {
  return Boolean(validUntil && Date.parse(validUntil) < Date.now());
}

function nextAction(service: Service, status: LiveServiceStatus, currentHostId: string | null) {
  if (isAttention(service, status)) return "Recover";
  if (service.visibility === "local" && !currentHostId) return "Locate device";
  if (service.visibility === "local" && service.host !== currentHostId) return "Other device";
  if (serviceMode(service) === "on-demand" && status.state === "stopped") return "How to start";
  if (canOpenHere(service, currentHostId)) return status.state === "protected" ? "Sign in" : "Open";
  if (serviceMode(service) === "on-demand") return "How to start";
  return "Details";
}

function StatusPill({ status }: { status: LiveServiceStatus }) {
  const state = status.state || "unknown";
  const label = status.source === "reported" && state === "up" ? "REPORTED UP" : (stateLabels[state] ?? state.toUpperCase());
  return (
    <span className={`status status-${state}`} title={status.note}>
      <i aria-hidden="true" />
      {label}
    </span>
  );
}

function ServiceRow({ project, service, status, hostName, currentHostId, onSelect }: {
  project: Project;
  service: Service;
  status: LiveServiceStatus;
  hostName: string;
  currentHostId: string | null;
  onSelect: (selection: SelectedService) => void;
}) {
  const placement = servicePlacement(service, currentHostId);
  const action = nextAction(service, status, currentHostId);

  return (
    <button
      className={`service-row ${isAttention(service, status) ? "service-row-alert" : ""}`}
      onClick={() => onSelect({ project, service })}
      aria-label={`${service.name}: ${action}`}
    >
      <span className="service-main">
        <strong>{service.name}</strong>
        <small>
          {placement.kind === "here"
            ? `Here · ${service.environment} · ${service.runtime}`
            : placement.kind === "other-device"
              ? `Other device · ${hostName}`
              : `Device unknown · runs on ${hostName}`}
        </small>
      </span>
      <StatusPill status={status} />
      <span className={`service-next ${action === "Recover" ? "service-next-alert" : ""}`}>{action}</span>
    </button>
  );
}

function ProjectCard({ project, statuses, hostNames, currentHostId, onSelect }: {
  project: Project;
  statuses: Map<string, LiveServiceStatus>;
  hostNames: Map<string, string>;
  currentHostId: string | null;
  onSelect: (selection: SelectedService) => void;
}) {
  const attentionCount = project.services.filter((service) => {
    const status = statuses.get(serviceKey(project.id, service.id)) ?? getInitialStatus(project.id, service);
    return isAttention(service, status);
  }).length;

  return (
    <article className={`project-card ${attentionCount ? "project-card-alert" : ""}`}>
      <header className="project-header">
        <div>
          <span className="project-kind">{project.kind} · {project.registration}</span>
          <h2>{project.title}</h2>
          {project.aliases?.length ? <p className="aliases">also: {project.aliases.join(" · ")}</p> : null}
        </div>
        <span className={`lifecycle lifecycle-${project.lifecycle}`}>{lifecycleLabels[project.lifecycle]}</span>
      </header>

      <p className="project-description">{project.description}</p>

      <div className="service-list">
        {project.services.length ? project.services.map((service) => (
          <ServiceRow
            key={service.id}
            project={project}
            service={service}
            status={statuses.get(serviceKey(project.id, service.id)) ?? getInitialStatus(project.id, service)}
            hostName={hostNames.get(service.host) ?? service.host}
            currentHostId={currentHostId}
            onSelect={onSelect}
          />
        )) : (
          <div className="no-runtime">
            <span>◇</span>
            <p><strong>No runtime</strong><small>Tracked as a project, not an always-on service.</small></p>
          </div>
        )}
      </div>

      <footer className="project-footer">
        <div className="tags">{project.tags?.map((tag) => <span key={tag}>{tag}</span>)}</div>
        {project.repository ? (
          <a href={`https://github.com/${project.repository}`} target="_blank" rel="noreferrer">Repository ↗</a>
        ) : <span className="repo-missing">Repository not registered</span>}
      </footer>
    </article>
  );
}

function statusExplanation(service: Service, status: LiveServiceStatus, hostName: string, sameDevice: boolean) {
  if (status.state === "up" && status.source === "reported") return `The catalog last recorded this service as running on ${hostName}, but there is no live probe.`;
  if (status.state === "up") return `DevHub reached this service successfully${status.latencyMs ? ` in ${status.latencyMs} ms` : ""}.`;
  if (status.state === "protected") return "The service is reachable and correctly asks you to sign in.";
  if (status.state === "stopped") return `This is not running now. ${serviceMode(service) === "on-demand" ? "That is normal until you need it." : "Start or recover it if it should be available."}`;
  if (status.state === "down" || status.state === "degraded") return status.source === "reported"
    ? `This service was reported as ${status.state} on ${hostName}; use the recovery guidance below to verify it.`
    : `This service is expected to stay online on ${hostName}, but its live check is failing.`;
  if (service.visibility === "local") return sameDevice
    ? "This service belongs to this device. Central DevHub cannot probe its localhost, so open it or use the start guidance below."
    : `This service belongs to ${hostName}. Central DevHub cannot probe that computer's localhost.`;
  return "The service is in the catalog, but no live health result is available.";
}

function statusEvidence(status: LiveServiceStatus) {
  if (status.source === "probe") {
    return status.observedAt ? `Live probe · ${new Date(status.observedAt).toLocaleString()}` : "Live probe";
  }
  if (status.source === "reported") {
    return status.observedAt ? `Reported · observed ${new Date(status.observedAt).toLocaleString()}` : "Reported · observation date missing";
  }
  return status.reason === "remote-loopback" ? "Not checked · localhost belongs to another host" : "Catalog only · no live observation";
}

function copyRequest(project: Project, service: Service, status: LiveServiceStatus, hostName: string) {
  const problem = isAttention(service, status)
    ? `DevHub reports ${status.state}. Diagnose the cause and restore it safely.`
    : serviceMode(service) === "on-demand"
      ? "I want to use it now. Check the project instructions and start it safely."
      : "Check its current configuration and tell me what action is needed.";
  return `In DevHub, look at ${project.title} / ${service.name}. It runs on ${hostName}. ${problem} If the URL, host, health check, commands or App Passport evidence changed, update the DevHub manifest, leave unverifiable safeguards unknown, validate it and publish the change.`;
}

function ServicePanel({ selection, status, hosts, currentHostId, onClose }: {
  selection: SelectedService;
  status: LiveServiceStatus;
  hosts: Host[];
  currentHostId: string | null;
  onClose: () => void;
}) {
  const { project, service } = selection;
  const [copied, setCopied] = useState<string | null>(null);
  const host = hosts.find((item) => item.id === service.host);
  const currentHost = hosts.find((item) => item.id === currentHostId);
  const hostName = host?.name ?? service.host;
  const currentHostName = currentHost?.name ?? null;
  const placement = servicePlacement(service, currentHostId);
  const sameDevice = placement.kind === "here";
  const openHere = canOpenHere(service, currentHostId);
  const selectedEndpoint = resolveServiceEndpoint(service);
  const openUrl = selectedEndpoint?.url;
  const supportingLinks = [
    ...(service.endpoint?.canonical && service.endpoint.fallback !== openUrl
      ? [{ id: "host-fallback", type: "host-fallback", label: `Open via ${hostName}`, url: service.endpoint.fallback }]
      : []),
    ...(service.links ?? [])
      .filter((link) => link.url !== openUrl && link.url !== service.endpoint?.fallback && link.type !== "primary")
      .map((link) => ({ ...link, type: link.type as string })),
  ];
  const readinessEvidence = service.readiness?.evidence ?? [];
  const verifiedEvidence = readinessEvidence.filter((evidence) => evidence.state === "verified" && !isEvidenceStale(evidence.validUntil)).length;
  const staleEvidence = readinessEvidence.filter((evidence) => evidence.state === "verified" && isEvidenceStale(evidence.validUntil)).length;
  const unknownEvidence = readinessEvidence.filter((evidence) => evidence.state === "unknown" || evidence.state === "missing").length;
  const workspace = project.workspaces?.find((item) => item.host === service.host)?.path;
  const mode = serviceMode(service);
  const commandName = isAttention(service, status)
    ? (service.commands?.restart ? "restart" : service.commands?.logs ? "logs" : service.commands?.start ? "start" : null)
    : mode === "on-demand"
      ? (service.commands?.start ? "start" : service.commands?.restart ? "restart" : null)
      : service.commands?.restart ? "restart" : null;
  const command = commandName ? service.commands?.[commandName] : null;

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const copy = async (label: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(label);
    window.setTimeout(() => setCopied(null), 1800);
  };

  return (
    <div className="panel-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="service-panel" role="dialog" aria-modal="true" aria-labelledby="service-panel-title">
        <header className="panel-header">
          <div>
            <p className="eyebrow">{project.title}</p>
            <h2 id="service-panel-title">{service.name}</h2>
          </div>
          <button className="panel-close" onClick={onClose} aria-label="Close service details">×</button>
        </header>

        <div className={`panel-state panel-state-${status.state}`}>
          <StatusPill status={status} />
          <p>{statusExplanation(service, status, hostName, sameDevice)}</p>
        </div>

        <dl className="service-facts">
          <div><dt>Runs on</dt><dd>{hostName}<em className={`placement-${placement.kind}`}>{placement.label}</em></dd></div>
          <div><dt>Operation</dt><dd>{modeLabels[mode]}</dd></div>
          <div><dt>Environment</dt><dd>{service.environment} · {service.runtime}</dd></div>
          <div><dt>Access</dt><dd>{service.visibility === "local" ? (sameDevice ? "Only on this device" : `Only from ${hostName}`) : service.visibility}</dd></div>
          {selectedEndpoint ? (
            <div>
              <dt>Open address</dt>
              <dd>
                {selectedEndpoint.source === "canonical" ? "Stable service address" : selectedEndpoint.source === "host-fallback" ? "Host-specific fallback" : "Reviewed address"}
                <small>{selectedEndpoint.reason}</small>
              </dd>
            </div>
          ) : null}
          <div><dt>Status source</dt><dd>{status.source === "probe" ? "Live probe" : status.source === "reported" ? "Manual report" : "Catalog only"}</dd></div>
        </dl>

        <section className="app-passport" aria-label="App Passport">
          <header>
            <div><small>App Passport</small><strong>{service.readiness ? profileLabels[service.readiness.profile] : "Not assessed"}</strong></div>
            {service.readiness ? <span>{verifiedEvidence} verified{staleEvidence ? ` · ${staleEvidence} stale` : ""}{unknownEvidence ? ` · ${unknownEvidence} unknown` : ""}</span> : null}
          </header>
          {readinessEvidence.length ? (
            <div className="passport-evidence">
              {readinessEvidence.map((evidence) => {
                const stale = evidence.state === "verified" && isEvidenceStale(evidence.validUntil);
                const state = stale ? "stale" : evidence.state;
                const content = (
                  <>
                    <span className={`passport-state passport-state-${state}`} aria-hidden="true" />
                    <span><strong>{readinessLabels[evidence.check] ?? evidence.check}</strong><small>{stale ? "stale" : evidence.state} · {evidence.source}</small></span>
                    <p>{evidence.note}</p>
                  </>
                );
                return evidence.url ? <a key={evidence.id} href={evidence.url} target="_blank" rel="noreferrer">{content}<i>↗</i></a> : <div key={evidence.id}>{content}</div>;
              })}
            </div>
          ) : <p className="passport-empty">No readiness evidence is registered. Unknown is not a passing result; ask Codex to inspect this project and propose a reviewed passport.</p>}
        </section>

        {service.visibility === "local" && placement.kind !== "here" ? (
          <div className="device-guidance">
            <strong>{placement.kind === "unknown" ? "Select your current device" : `Continue on ${hostName}`}</strong>
            <p>{placement.kind === "unknown"
              ? `DevHub could not identify this browser. Choose your device above; this local service is registered on ${hostName}.`
              : `You are viewing DevHub from ${currentHostName}. Open DevHub on ${hostName}, or expose this service through Tailscale before using it remotely.`}</p>
          </div>
        ) : null}

        <div className="panel-actions">
          {openHere && openUrl && !(mode === "on-demand" && status.state === "stopped") ? (
            <a className="panel-primary" href={openUrl} target="_blank" rel="noreferrer">
              {status.state === "protected" ? "Open and sign in" : service.visibility === "local" ? "Open on this device" : "Open service"} ↗
            </a>
          ) : null}

          {supportingLinks.length ? (
            <div className="panel-links" aria-label="Service links">
              {supportingLinks.map((link) => (
                <a key={link.id} href={link.url} target="_blank" rel="noreferrer">
                  <small>{link.type === "host-fallback" ? "Host fallback" : (linkTypeLabels[link.type] ?? link.type)}</small>
                  <strong>{link.label}</strong>
                  <i aria-hidden="true">↗</i>
                </a>
              ))}
            </div>
          ) : null}

          {command ? (
            <button className="panel-command" onClick={() => void copy("command", `${workspace ? `cd ${JSON.stringify(workspace)} && ` : ""}${command}`)}>
              <span><small>Run on {hostName}</small><strong>{commandName === "restart" ? "Copy restart command" : commandName === "logs" ? "Copy log command" : "Copy start command"}</strong></span>
              <i>{copied === "command" ? "Copied" : "Copy"}</i>
            </button>
          ) : null}

          <button className="panel-command panel-codex" onClick={() => void copy("codex", copyRequest(project, service, status, hostName))}>
            <span><small>Need help?</small><strong>Copy request for Codex</strong></span>
            <i>{copied === "codex" ? "Copied" : "Copy"}</i>
          </button>
        </div>

        <footer className="panel-footer">
          <span>{statusEvidence(status)}</span>
          {project.repository ? <a href={`https://github.com/${project.repository}`} target="_blank" rel="noreferrer">Repository ↗</a> : null}
        </footer>
      </aside>
    </div>
  );
}

export function DevHubDashboard({ catalog }: { catalog: Catalog }) {
  const [query, setQuery] = useState("");
  const [lifecycle, setLifecycle] = useState("all");
  const [liveStatuses, setLiveStatuses] = useState<LiveServiceStatus[]>([]);
  const [viewerContext, setViewerContext] = useState<ViewerContext | null>(null);
  const [hostOverride, setHostOverride] = useState("auto");
  const [selectedService, setSelectedService] = useState<SelectedService | null>(null);
  const [registrationCopied, setRegistrationCopied] = useState(false);
  const [refreshing, setRefreshing] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [statusResponse, contextResponse] = await Promise.all([
        fetch("/api/status", { cache: "no-store" }),
        fetch("/api/context", { cache: "no-store" }),
      ]);
      if (!statusResponse.ok || !contextResponse.ok) throw new Error("DevHub status refresh failed");
      const statusResult = await statusResponse.json() as StatusResponse;
      const contextResult = await contextResponse.json() as ViewerContext;
      setLiveStatuses(statusResult.statuses);
      setLastRefresh(statusResult.observedAt);
      setViewerContext(contextResult);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const firstRun = window.setTimeout(() => {
      const savedHost = window.localStorage.getItem("devhub-viewer-host");
      if (savedHost) setHostOverride(savedHost);
      void refresh();
    }, 0);
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => {
      window.clearTimeout(firstRun);
      window.clearInterval(timer);
    };
  }, [refresh]);

  const changeHost = (value: string) => {
    setHostOverride(value);
    window.localStorage.setItem("devhub-viewer-host", value);
  };

  const copyRegistrationRequest = async () => {
    await navigator.clipboard.writeText(devHubAgentRequest);
    setRegistrationCopied(true);
    window.setTimeout(() => setRegistrationCopied(false), 2200);
  };

  const statusMap = useMemo(() => {
    const initial = catalog.projects.flatMap((project) =>
      project.services.map((service) => getInitialStatus(project.id, service)),
    );
    return new Map([...initial, ...liveStatuses].map((status) => [status.key, status]));
  }, [catalog.projects, liveStatuses]);

  const currentHostId = hostOverride === "auto" ? (viewerContext?.detectedHostId ?? null) : hostOverride;
  const currentHost = catalog.hosts.find((host) => host.id === currentHostId) ?? null;
  const selectableHosts = catalog.hosts.filter((host) => host.kind === "mac" || host.kind === "linux");
  const hostNames = useMemo(() => new Map(catalog.hosts.map((host) => [host.id, host.name])), [catalog.hosts]);
  const detectedHostName = viewerContext?.detectedHostId ? hostNames.get(viewerContext.detectedHostId) : null;
  const visibleProjects = catalog.projects.filter((project) =>
    (lifecycle === "all" || project.lifecycle === lifecycle) && matches(project, query),
  );
  const serviceStatuses = catalog.projects.flatMap((project) => project.services.map((service) => ({
    service,
    status: statusMap.get(serviceKey(project.id, service.id)) ?? getInitialStatus(project.id, service),
  })));
  const upCount = serviceStatuses.filter(({ status }) => status.source === "probe" && (status.state === "up" || status.state === "protected")).length;
  const attentionCount = serviceStatuses.filter(({ service, status }) => isAttention(service, status)).length;
  const serviceCount = serviceStatuses.length;

  return (
    <main>
      <section className="hero">
        <nav className="topbar" aria-label="DevHub navigation">
          <a className="brand" href="#top" aria-label="DevHub home"><span>DH</span> DevHub</a>
          <div className="topbar-actions">
            <span className="viewer-badge"><i />{currentHost ? `You are on ${currentHost.name}` : "Choose your device below"}</span>
            <a className="topbar-link" href="#catalog">Catalog</a>
            <a className="topbar-link" href="#why-devhub">Why DevHub</a>
            <a href="#registration">Add a project</a>
          </div>
        </nav>

        <div className="hero-grid" id="top">
          <div className="hero-copy">
            <p className="eyebrow">Operational memory for everything you build</p>
            <h1>Git remembers the code.<br/><em>DevHub remembers how it runs.</em></h1>
            <p>Your coding agent can build and deploy it. DevHub helps you understand it, trust it, operate it and recover it across every laptop, server and cloud.</p>
            <div className="hero-actions">
              <a className="hero-primary" href="#catalog">Explore {serviceCount} services</a>
              <a className="hero-secondary" href="#why-devhub">See how it works ↓</a>
            </div>
          </div>
          <div className="hero-stats" aria-label="Catalog summary">
            <div><strong>{catalog.projects.length}</strong><span>projects</span></div>
            <div><strong>{serviceCount}</strong><span>services</span></div>
            <div><strong>{upCount}</strong><span>reachable</span></div>
            <div className={attentionCount ? "attention" : ""}><strong>{attentionCount}</strong><span>needs action</span></div>
          </div>
        </div>

        <div className="host-strip" aria-label="Registered hosts">
          {catalog.hosts.map((host) => (
            <span key={host.id} className={currentHostId === host.id ? "current-host" : ""}>
              <i className={`host-${host.location}`} />{host.name}
              <small>{currentHostId === host.id ? "this device" : host.tailscaleName ?? host.kind}</small>
            </span>
          ))}
        </div>
      </section>

      <section className="workspace" id="catalog">
        <div className="control-row">
          <label className="search">
            <span aria-hidden="true">⌕</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search projects, services, runtimes…" aria-label="Search catalog" />
          </label>
          <label className="device-picker">
            <small>Viewing from</small>
            <select value={hostOverride} onChange={(event) => changeHost(event.target.value)} aria-label="Current device">
              <option value="auto">{detectedHostName ? `Auto · ${detectedHostName}` : "Auto · not detected"}</option>
              {selectableHosts.map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}
            </select>
          </label>
          <div className="filters" aria-label="Lifecycle filter">
            {["all", "production", "active", "discovery"].map((value) => (
              <button key={value} className={lifecycle === value ? "selected" : ""} onClick={() => setLifecycle(value)}>
                {value === "all" ? "All" : lifecycleLabels[value]}
              </button>
            ))}
          </div>
          <button className="refresh" onClick={() => void refresh()} disabled={refreshing}>
            {refreshing ? "Checking…" : "Refresh"}
          </button>
        </div>

        <div className="section-heading">
          <div><p className="eyebrow">Operational catalog</p><h2>{visibleProjects.length} visible projects</h2></div>
          <p>{lastRefresh ? `Live probes ${new Date(lastRefresh).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Waiting for live probes"}</p>
        </div>

        <div className="project-grid">
          {visibleProjects.map((project) => (
            <ProjectCard key={project.id} project={project} statuses={statusMap} hostNames={hostNames} currentHostId={currentHostId} onSelect={setSelectedService} />
          ))}
          {!visibleProjects.length ? (
            <div className="empty-state"><strong>Nothing matches this view.</strong><span>Try another lifecycle or clear the search.</span></div>
          ) : null}
        </div>

        <section className="product-story" id="why-devhub">
          <header className="product-story-heading">
            <div>
              <p className="eyebrow">One operational contract</p>
              <h2>Everything you build stays findable, trustworthy and recoverable.</h2>
            </div>
            <p>DevHub does not care whether a service runs in Docker, systemd, a cloud platform or a terminal on another laptop. It keeps the context that disappears first: ownership, location, lifecycle, trustworthy status and the next safe action.</p>
          </header>

          <div className="value-grid">
            <article>
              <span>01</span>
              <h3>Find it</h3>
              <p>Search every application, API, worker, bot, database and internal tool from one reviewed catalog.</p>
            </article>
            <article>
              <span>02</span>
              <h3>Trust it</h3>
              <p>See whether a state comes from a live probe, a timestamped report or catalog-only knowledge. Unknown never pretends to be green.</p>
            </article>
            <article>
              <span>03</span>
              <h3>Operate it</h3>
              <p>Open the right entry point, move to the right device, copy reviewed recovery guidance or hand the exact context to your coding agent.</p>
            </article>
            <article>
              <span>04</span>
              <h3>Recover it</h3>
              <p>Keep monitoring, backup, restore, rollback, security, ownership and cost evidence together without pretending unknown means safe.</p>
            </article>
          </div>

          <div className="runtime-ribbon" aria-label="Supported service categories">
            <span>Web apps</span><i />
            <span>APIs</span><i />
            <span>Workers</span><i />
            <span>Bots</span><i />
            <span>Databases</span><i />
            <span>Local tools</span><i />
            <span>Managed services</span>
          </div>
        </section>

        <section className="registration" id="registration">
          <div className="registration-copy">
            <p className="eyebrow">Codex handoff</p>
            <h2>One request. DevHub handles the rest.</h2>
            <p>With the DevHub plugin installed, open a Codex task beside any project and say what appeared or changed. Paste the universal request only when you want the full workflow spelled out.</p>
          </div>
          <ol>
            <li><span>01</span><p><strong>Open the project task</strong><small>Any Codex task that can inspect the project files and runtime.</small></p></li>
            <li><span>02</span><p><strong>Say what changed</strong><small>For example: “new admin”, “URL changed”, or “this moved to another Mac”.</small></p></li>
            <li><span>03</span><p><strong>Review the proposal</strong><small>Codex queries DevHub through MCP, chooses the safe boundary and shows the catalog diff.</small></p></li>
          </ol>
          <div className="handoff-card" aria-label="Universal DevHub request for Codex">
            <header><span>devhub-agent-request.txt</span><i>universal</i></header>
            <pre>{devHubAgentRequest}</pre>
            <button onClick={() => void copyRegistrationRequest()}>
              <span><small>Use in any project task</small><strong aria-live="polite">{registrationCopied ? "Copied — paste it into Codex" : "Copy for Codex"}</strong></span>
              <i>{registrationCopied ? "✓" : "Copy"}</i>
            </button>
          </div>
        </section>
      </section>

      <footer className="site-footer"><span>DevHub · the operational home for everything you build</span><span>Find it · trust it · continue safely</span></footer>

      {selectedService ? (
        <ServicePanel
          selection={selectedService}
          status={statusMap.get(serviceKey(selectedService.project.id, selectedService.service.id)) ?? getInitialStatus(selectedService.project.id, selectedService.service)}
          hosts={catalog.hosts}
          currentHostId={currentHostId}
          onClose={() => setSelectedService(null)}
        />
      ) : null}
    </main>
  );
}
