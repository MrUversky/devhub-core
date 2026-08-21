"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Catalog, Host, LiveServiceStatus, Project, Service, ViewerContext } from "@/lib/catalog";
import { resolveServiceEndpoint, serviceKey } from "@/lib/catalog";
import type { ConnectionSnapshot, ConnectorConnection } from "@/lib/connection-status.mjs";
import { resolveConnectorConnection } from "@/lib/connection-status.mjs";
import {
  buildConnectedSetupAgentPrompt,
  CONNECTED_SETUP,
  CONNECTED_SETUP_STEPS,
  listConnectors,
  recommendedConnectors,
  type ConnectorDefinition,
} from "@/lib/connectors.mjs";
import {
  evaluateReadiness,
  groupRecoveryReadiness,
  resolveServiceReadinessContext,
  type ReadinessAssessment,
} from "@/lib/readiness.mjs";
import { STEWARDSHIP_ROLES, resolveServiceStewardshipContext, stewardshipSearchTerms } from "@/lib/stewardship.mjs";
import { deriveCatalogReviewPresentation, type CatalogReviewPresentation } from "@/lib/catalog-review-presentation.mjs";
import {
  matchesServiceStatusFilter,
  serviceStatusFilterLabels,
  type ServiceStatusFilter,
} from "@/lib/catalog-service-filters.mjs";
import {
  buildPortfolioReviewAgentPrompt,
  buildProjectRegistrationAgentPrompt,
  type PortfolioReviewScope,
} from "@/lib/agent-handoff-prompts.mjs";
import {
  isFreshLiveStatus,
  SAME_ORIGIN_STATUS_API_ENDPOINT,
  selectReviewedStatusSnapshot,
  statusBridgePresentation,
} from "@/lib/status-bridge.mjs";

type StatusResponse = {
  observedAt: string;
  statuses: LiveServiceStatus[];
  freshness: {
    mode: "cache" | "refresh" | "mixed" | "shared";
    newestCheckedAt: string | null;
    maxAgeMs: number;
  };
};
type SelectedService = { project: Project; service: Service };
type CatalogInsight = "all" | "passport" | "evidence-gap" | "stewardship";

const lifecycleLabels: Record<string, string> = {
  discovery: "Discovery",
  active: "Active",
  production: "Production",
  paused: "Paused",
  archived: "Archived",
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

const stewardshipRoleLabels: Record<string, string> = {
  accountableOwner: "Accountable",
  operator: "Operator",
  billingOwner: "Billing owner",
  credentialOwner: "Credential owner",
};

const catalogInsightLabels: Record<CatalogInsight, string> = {
  all: "All projects",
  passport: "Services with App Passport",
  "evidence-gap": "Services with evidence gaps",
  stewardship: "Services needing ownership review",
};

const serviceStatusFilterValues: readonly ServiceStatusFilter[] = ["all", "live", "reported", "unchecked", "attention"];

const devHubAgentRequest = buildProjectRegistrationAgentPrompt();

const devHubInstallRequest = `Install the current approved DevHub alpha on this computer from an approved release or an authorized DevHub checkout available to this task.

Read and follow the repository instructions, verify the required Node.js version, install the locked dependencies with npm ci, and start the local dashboard with npm run dev. Do not install an unrelated package that happens to be named devhub.

When the dashboard is ready, give me its local URL and help me continue with Connected Setup.`;

const portfolioMetricHelp: Record<Exclude<CatalogInsight, "all">, string> = {
  passport: "An App Passport records the service owner, deployment, dependencies, and the evidence needed to operate it.",
  "evidence-gap": "These services have expected evidence that is missing, unknown, or stale, so they are ready for review.",
  stewardship: "These services need a clearer accountable, operator, billing, or credential-owner role.",
};

const portfolioScopeCopy: Record<PortfolioReviewScope, { title: string; match: string }> = {
  all: { title: "Review this catalog", match: "Catalog review" },
  passport: { title: "Review App Passport context", match: "App Passport" },
  "evidence-gap": { title: "Review evidence gaps", match: "Needs evidence" },
  stewardship: { title: "Review service ownership", match: "Needs ownership review" },
};

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return count === 1 ? singular : pluralForm;
}

const emptyConnectionSnapshot: ConnectionSnapshot = { version: 1, source: "not-configured", profiles: [] };

const connectorConnectionCopy: Record<ConnectorConnection["state"], string> = {
  connected: "Last check succeeded",
  stale: "Check expired",
  "authorization-required": "Access needed",
  unavailable: "Unavailable",
  unknown: "Unknown",
  "not-configured": "Not configured",
};

const demoConnectorLabel = "Available";

const defaultSetupConnectorIds = Object.freeze(["github", "local-host", "vercel", "railway", "openai"] as const);

function futureRefreshCopy(connectorId: string, connection: ConnectorConnection) {
  if (!connection.profileCount) return "Not saved";
  if (connection.state === "connected") return "Saved";
  if (connection.state === "stale" || connectorId === "local-host") return "Saved · needs recheck";
  if (connection.state === "authorization-required") return "Saved · sign-in needed";
  return "Saved · needs review";
}

function connectorCapabilityLabel(capability: string) {
  return capability.split("-").map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(" ");
}

function connectionTimestamp(value: string | null) {
  if (!value) return null;
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" }).format(new Date(value));
}

async function copyText(value: string) {
  if (typeof document !== "undefined" && document.body) {
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const activeTextControl = activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement ? activeElement : null;
    const controlSelection = activeTextControl
      ? { start: activeTextControl.selectionStart, end: activeTextControl.selectionEnd, direction: activeTextControl.selectionDirection }
      : null;
    const selection = document.getSelection();
    const selectedRanges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
    const scrollPosition = { x: window.scrollX, y: window.scrollY };
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.readOnly = true;
    textarea.tabIndex = -1;
    textarea.setAttribute("aria-hidden", "true");
    textarea.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
    document.body.appendChild(textarea);

    let copied = false;
    try {
      // Keep the activation-sensitive path before the first async boundary.
      textarea.focus({ preventScroll: true });
      textarea.select();
      textarea.setSelectionRange(0, value.length);
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    } finally {
      textarea.remove();
      try {
        if (activeElement?.isConnected) activeElement.focus({ preventScroll: true });
        if (activeTextControl && controlSelection && controlSelection.start !== null && controlSelection.end !== null) {
          activeTextControl.setSelectionRange(controlSelection.start, controlSelection.end, controlSelection.direction ?? undefined);
        } else if (selection) {
          selection.removeAllRanges();
          selectedRanges.forEach((range) => selection.addRange(range));
        }
        window.scrollTo(scrollPosition.x, scrollPosition.y);
      } catch {
        // Copy result is still authoritative when restoring a stale selection fails.
      }
    }

    if (copied) return true;
  }

  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

function CopyFallback({ value, label }: { value: string; label: string }) {
  return (
    <label className="copy-fallback">
      <span role="status">Copy failed — select and copy</span>
      <textarea aria-label={label} readOnly value={value} onFocus={(event) => event.currentTarget.select()} />
    </label>
  );
}

function CatalogReviewHandoff({
  scope,
  presentation,
  restoreFocus,
  onClose,
}: {
  scope: PortfolioReviewScope;
  presentation: CatalogReviewPresentation;
  restoreFocus: () => void;
  onClose: () => void;
}) {
  const [copyState, setCopyState] = useState<"copied" | "failed" | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const request = buildPortfolioReviewAgentPrompt({ scope });
  const selectedScope = scope === "all" ? null : presentation.scopes[scope];
  const serviceCount = selectedScope?.matchingServiceCount ?? presentation.universe.serviceCount;
  const projectCount = selectedScope?.matchingProjectCount ?? presentation.universe.projectCount;
  const scopeCopy = portfolioScopeCopy[scope];

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const dialog = dialogRef.current;
    const hiddenSiblings: Array<{ element: HTMLElement; inert: boolean; ariaHidden: string | null }> = [];
    let branch: HTMLElement | null = dialog;
    while (branch?.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (sibling === branch || !(sibling instanceof HTMLElement)) continue;
        hiddenSiblings.push({ element: sibling, inert: sibling.inert, ariaHidden: sibling.getAttribute("aria-hidden") });
        sibling.inert = true;
        sibling.setAttribute("aria-hidden", "true");
      }
      branch = branch.parentElement;
      if (branch === document.body) break;
    }
    document.body.style.overflow = "hidden";
    const containKeyboardFocus = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialog.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", containKeyboardFocus);
    window.requestAnimationFrame(() => headingRef.current?.focus({ preventScroll: true }));
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", containKeyboardFocus);
      for (const { element, inert, ariaHidden } of hiddenSiblings) {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", ariaHidden);
      }
      window.requestAnimationFrame(restoreFocus);
    };
  }, [onClose, restoreFocus]);

  const copyReviewRequest = async () => {
    const succeeded = await copyText(request);
    setCopyState(succeeded ? "copied" : "failed");
    if (succeeded) window.setTimeout(() => setCopyState(null), 2200);
  };

  return (
    <div className="setup-overlay catalog-review-overlay">
      <section ref={dialogRef} className="setup-dialog catalog-review-dialog" role="dialog" aria-modal="true" aria-labelledby="catalog-review-dialog-title" aria-describedby="catalog-review-dialog-description" tabIndex={-1}>
        <header className="setup-dialog-header">
          <div><p className="eyebrow">Agent-assisted review</p><strong>{scopeCopy.title}</strong></div>
          <button className="setup-close" aria-label="Close catalog review" onClick={onClose}>×</button>
        </header>
        <div className="catalog-review-scopebar" aria-label="Review scope">
          <strong>{serviceCount} {plural(serviceCount, "service")}</strong>
          <span>{projectCount} {plural(projectCount, "project")} in this review</span>
          {selectedScope?.questionItemCount ? <span>{selectedScope.questionItemCount} {scope === "evidence-gap" ? "evidence checks" : "ownership items"}</span> : null}
        </div>
        <div className="setup-dialog-scroll">
          <div className="setup-stage catalog-review-stage">
            <div className="setup-stage-heading">
              <div><p className="eyebrow">Ready to hand off</p><h3 ref={headingRef} tabIndex={-1} id="catalog-review-dialog-title">Review this finite scope with your coding agent</h3></div>
              <p id="catalog-review-dialog-description">Your agent reads the reviewed catalog, explains the highest-priority finding, and prepares a change only when the evidence supports one.</p>
            </div>
            <section className="setup-after-paste" aria-labelledby="catalog-review-next-title">
              <h4 id="catalog-review-next-title">What happens after you paste</h4>
              <ol>
                <li><span>1</span><p><strong>Review this scope</strong><small>The request keeps the review to the selected catalog signal.</small></p></li>
                <li><span>2</span><p><strong>See the next decision</strong><small>Your agent shows one affected service, why it matters, and one safe next action.</small></p></li>
                <li><span>3</span><p><strong>Approve any update</strong><small>You get a minimal reviewed diff or draft pull request, never a hidden change.</small></p></li>
              </ol>
            </section>
            <section className="setup-run-location" aria-labelledby="catalog-review-task-title">
              <h4 id="catalog-review-task-title">Paste it into a coding-agent task</h4>
              <p>Open a task that can use your configured DevHub workflow. The agent will keep the review read-only until it has a reviewable proposal.</p>
              <details className="setup-agent-details">
                <summary>Which task should I open?</summary>
                <div>
                  <p>Use the DevHub workspace for a portfolio-wide review. If the DevHub workflow is installed user-wide, you can start from the project you want to update.</p>
                  <div className="setup-agent-clients" aria-label="Supported coding agents">
                    <article><strong>Codex</strong><span>Open a coding task and paste the copied review request.</span></article>
                    <article><strong>Claude Code</strong><span>Open the DevHub or project workspace, then paste the same request.</span></article>
                    <article><strong>Cursor</strong><span>Open the relevant workspace and use the same guided handoff.</span></article>
                  </div>
                </div>
              </details>
            </section>
            {copyState === "copied" ? <p className="setup-copy-ack" role="status">Copied. Continue in your coding-agent task.</p> : null}
            {copyState === "failed" ? <CopyFallback value={request} label="Catalog review request to copy manually" /> : null}
          </div>
        </div>
        <footer className="setup-action-bar catalog-review-action-bar">
          <button className="setup-text-button" type="button" onClick={onClose}>Close</button>
          <div className="setup-action-summary" aria-live="polite">
            <strong>{scopeCopy.title}</strong>
            <span>{serviceCount} {plural(serviceCount, "service")} · {projectCount} {plural(projectCount, "project")}</span>
          </div>
          <button className="setup-primary" type="button" onClick={() => void copyReviewRequest()}>{copyState === "copied" ? "Copied — paste into your agent" : copyState === "failed" ? "Try copying again" : "Copy review request"}</button>
        </footer>
      </section>
    </div>
  );
}

export function ConnectedSetup({ existingCatalog = false, instanceMode = "private", connections = emptyConnectionSnapshot, connectionNow, initialOpen = false, initialStep = 0, initialShowRoadmap = false, initialSelectedConnectorIds }: { existingCatalog?: boolean; instanceMode?: Catalog["instance"]["mode"]; connections?: ConnectionSnapshot; connectionNow?: string; initialOpen?: boolean; initialStep?: number; initialShowRoadmap?: boolean; /** Deterministic initial UI state for SSR and tests; selection remains local to this dialog. */ initialSelectedConnectorIds?: readonly string[] }) {
  const connectors = listConnectors();
  const recommended = recommendedConnectors(6);
  const availableConnectors = connectors.filter((connector) => connector.stage === "available");
  const plannedConnectors = connectors
    .filter((connector) => connector.stage === "planned")
    .sort((left, right) => (left.roadmap?.milestone ?? "").localeCompare(right.roadmap?.milestone ?? ""));
  const [open, setOpen] = useState(initialOpen);
  const [step, setStep] = useState(Math.min(1, Math.max(0, initialStep)));
  const [showAllAvailable, setShowAllAvailable] = useState(false);
  const [showRoadmap, setShowRoadmap] = useState(initialShowRoadmap);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => {
    const initialIds = initialSelectedConnectorIds ?? defaultSetupConnectorIds;
    const selection = new Set(initialIds);
    if (selection.size !== initialIds.length || initialIds.some((id) => typeof id !== "string" || !availableConnectors.some((connector) => connector.id === id))) {
      throw new TypeError("Connected Setup initial selection accepts unique available canonical source IDs only");
    }
    return selection;
  });
  const [copied, setCopied] = useState<string | null>(null);
  const setupDialogRef = useRef<HTMLElement>(null);
  const setupScrollRef = useRef<HTMLDivElement>(null);
  const setupStageHeadingRef = useRef<HTMLHeadingElement>(null);
  const setupTriggerRef = useRef<HTMLElement | null>(null);
  const visibleAvailableConnectors = showAllAvailable ? availableConnectors : recommended;
  const selectedConnectors = availableConnectors.filter((connector) => selectedIds.has(connector.id));
  const setupRequest = selectedConnectors.length
    ? buildConnectedSetupAgentPrompt(selectedConnectors.map((connector) => connector.id))
    : null;
  const statusClock = connectionNow ?? new Date().toISOString();
  const connectionStates = new Map(availableConnectors.map((connector) => [connector.id, resolveConnectorConnection(connections, connector.id, { now: statusClock })]));
  const connectedCount = [...connectionStates.values()].filter((connection) => connection.state === "connected").length;
  const configuredCount = [...connectionStates.values()].filter((connection) => connection.state !== "not-configured").length;
  const hasReviewedConnections = connections.source === "reviewed-profiles" && configuredCount > 0;
  const isDemo = instanceMode === "demo";
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const trigger = setupTriggerRef.current;
    const dialog = setupDialogRef.current;
    const hiddenSiblings: Array<{ element: HTMLElement; inert: boolean; ariaHidden: string | null }> = [];
    let branch: HTMLElement | null = dialog;
    while (branch?.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (sibling === branch || !(sibling instanceof HTMLElement)) continue;
        hiddenSiblings.push({ element: sibling, inert: sibling.inert, ariaHidden: sibling.getAttribute("aria-hidden") });
        sibling.inert = true;
        sibling.setAttribute("aria-hidden", "true");
      }
      branch = branch.parentElement;
      if (branch === document.body) break;
    }
    document.body.style.overflow = "hidden";
    const containKeyboardFocus = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialog.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", containKeyboardFocus);
    window.requestAnimationFrame(() => setupStageHeadingRef.current?.focus({ preventScroll: true }));
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", containKeyboardFocus);
      for (const { element, inert, ariaHidden } of hiddenSiblings) {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", ariaHidden);
      }
      window.requestAnimationFrame(() => trigger?.focus({ preventScroll: true }));
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    window.requestAnimationFrame(() => setupStageHeadingRef.current?.focus({ preventScroll: true }));
  }, [open, step]);

  const copySetupPrompt = async () => {
    if (!setupRequest) return;
    const succeeded = await copyText(setupRequest);
    setCopied(succeeded ? "setup" : "failed");
    if (succeeded) window.setTimeout(() => setCopied(null), 2200);
  };

  const startSetup = (nextStep = 0, trigger: HTMLElement | null = document.activeElement instanceof HTMLElement ? document.activeElement : null) => {
    setupTriggerRef.current = trigger;
    setStep(nextStep);
    setOpen(true);
  };

  const goToStep = (nextStep: number) => {
    setStep(nextStep);
    window.requestAnimationFrame(() => setupScrollRef.current?.scrollTo({ top: 0, behavior: "smooth" }));
  };

  const toggleConnector = (connector: ConnectorDefinition) => {
    if (connector.stage !== "available") return;
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(connector.id)) next.delete(connector.id);
      else next.add(connector.id);
      return next;
    });
  };

  return (
    <section className="connected-setup" id="connections" aria-labelledby="connected-setup-title">
      <header className="connected-setup-header">
        <div>
          <p className="eyebrow">Connections</p>
          <h2 id="connected-setup-title">{isDemo ? "Set up connections in a few clicks." : hasReviewedConnections ? "Prepare a fresh check of your map." : existingCatalog ? "Prepare a setup request for your map." : CONNECTED_SETUP.title}</h2>
          <p>{isDemo ? "Choose the tools you use. DevHub turns that selection into one guided setup request for your coding agent." : hasReviewedConnections ? `${connectedCount} of ${configuredCount} reviewed sources have a fresh last check. Choose what your coding agent should check next.` : existingCatalog ? "Choose what belongs in this setup, then continue with your coding agent." : "Choose your tools, paste one request, and let your coding agent guide the remaining connections."}</p>
        </div>
        <div className="connected-setup-actions">
          {existingCatalog ? (
            <button className="setup-primary" onClick={(event) => startSetup(1, event.currentTarget)}>{isDemo ? "Start connection setup" : "Prepare setup request"}</button>
          ) : <button className="setup-primary" onClick={(event) => startSetup(1, event.currentTarget)}>{CONNECTED_SETUP.title}</button>}
          <small>{isDemo ? "Works with Codex, Claude Code, and Cursor" : "Read-only check · reviewed results"}</small>
        </div>
      </header>

      {open ? (
        <div className="setup-overlay">
          <section ref={setupDialogRef} className="setup-dialog" role="dialog" aria-modal="true" aria-labelledby="setup-dialog-title" aria-describedby="setup-dialog-description" tabIndex={-1}>
            <header className="setup-dialog-header">
              <div><p className="eyebrow">Agent-assisted setup</p><strong id="setup-dialog-title">{step === 0 ? "Choose your sources" : "Setup request ready"}</strong><span id="setup-dialog-description" className="sr-only">{step === 0 ? "Choose sources, then continue to the setup request." : "Review the included sources, then copy the setup request to your coding agent."}</span></div>
              <button className="setup-close" aria-label="Close connected setup" onClick={() => setOpen(false)}>×</button>
            </header>
            <ol className="setup-progress" aria-label="Connected setup progress" aria-live="polite">
            {CONNECTED_SETUP_STEPS.map((item, index) => (
              <li key={item.id} className={index === step ? "active" : index < step ? "done" : ""} aria-current={index === step ? "step" : undefined}>
                <span>{index < step ? "✓" : index + 1}</span><strong>{item.title}</strong>
              </li>
            ))}
            </ol>
            <div className="setup-dialog-scroll" ref={setupScrollRef}>

          {step === 0 ? (
            <div className="setup-stage" aria-labelledby="setup-connect-title">
              <div className="setup-stage-heading">
                <div><p className="eyebrow">Step 1</p><h3 ref={setupStageHeadingRef} tabIndex={-1} id="setup-connect-title">{CONNECTED_SETUP_STEPS[0].title}</h3></div>
                <p>Choose what your agent may check in this task. Five common sources are included; remove anything you do not want.</p>
              </div>
              <div className="connector-section-heading">
                <div><h4>{isDemo ? "Available now" : "Your sources"}</h4><p>Selection controls this read-only check. Saved connection status is shown separately when available.</p></div>
                <span>{isDemo ? `${availableConnectors.length} available` : `${connectedCount} fresh · ${availableConnectors.length} supported`}</span>
              </div>
              <div className={`setup-selection-summary${isDemo ? " support-only" : ""}`} aria-live="polite">
                <strong>{selectedConnectors.length} {selectedConnectors.length === 1 ? "source" : "sources"} included</strong>
                <span>This page prepares the request. Read-only checks start only after you paste it into your coding-agent task.</span>
              </div>
              <div className="connector-grid">
                {visibleAvailableConnectors.map((connector) => {
                  const selected = selectedIds.has(connector.id);
                  const connection = connectionStates.get(connector.id) ?? resolveConnectorConnection(connections, connector.id, { now: statusClock });
                  const statusLabel = isDemo ? demoConnectorLabel : connectorConnectionCopy[connection.state];
                  const observed = connectionTimestamp(connection.lastObservedAt);
                  return (
                    <article key={connector.id} className={`connector-card connection-${isDemo ? "not-configured" : connection.state}${selected ? " selected" : ""}`}>
                      <header><strong>{connector.name}</strong><span>{isDemo ? "Support" : "Reviewed status"}: {statusLabel}</span></header>
                      <p>{connector.summary}</p>
                      <div className="connector-capabilities"><small>Can inspect</small>{connector.capabilities.slice(0, 3).map((capability) => <span key={capability}>{connectorCapabilityLabel(capability)}</span>)}</div>
                      {!isDemo && observed ? <small>Checked {observed}</small> : null}
                      <footer>
                        <small>Selection</small>
                        <button type="button" aria-label={isDemo ? `${selected ? "Remove" : "Select"} ${connector.name}` : `${selected ? "Remove" : "Include"} ${connector.name}${selected ? " from this setup run" : " in this setup run"}`} aria-pressed={selected} onClick={() => toggleConnector(connector)}>{isDemo ? (selected ? "Selected" : "Select") : (selected ? "Included" : "Include in this run")}</button>
                      </footer>
                    </article>
                  );
                })}
              </div>
              <section className="connector-roadmap" aria-labelledby="connector-roadmap-title">
                <div className="connector-roadmap-header">
                  <div>
                    <p className="eyebrow">Coming later</p>
                    <h4 id="connector-roadmap-title">Connector roadmap</h4>
                    <p>Planned sources are visible for direction, but cannot be included in this release.</p>
                    {!showRoadmap ? <small>Next: {plannedConnectors.slice(0, 3).map((connector) => connector.name).join(" · ")} · +{Math.max(0, plannedConnectors.length - 3)} more</small> : null}
                  </div>
                  <button className="setup-text-button" type="button" aria-expanded={showRoadmap} onClick={() => setShowRoadmap((current) => !current)}>{showRoadmap ? "Hide roadmap" : `View roadmap · ${plannedConnectors.length} planned`}</button>
                </div>
                {showRoadmap ? (
                  <div className="connector-grid roadmap-grid">
                    {plannedConnectors.map((connector) => (
                      <article key={connector.id} className="connector-card planned">
                        <header><strong>{connector.name}</strong><span>{connector.roadmap?.milestone}</span></header>
                        <p>{connector.summary}</p>
                        <div className="connector-capabilities">{connector.capabilities.slice(0, 3).map((capability) => <span key={capability}>{capability}</span>)}</div>
                        <footer><span>{connector.roadmap?.theme}</span><strong>Planned</strong></footer>
                      </article>
                    ))}
                  </div>
                ) : null}
              </section>
              {availableConnectors.length > recommended.length && !showAllAvailable ? <button className="setup-text-button setup-show-all" onClick={() => setShowAllAvailable(true)}>Show all available sources</button> : null}
            </div>
          ) : null}

          {step === 1 ? (
            <div className="setup-stage setup-agent-handoff" aria-labelledby="setup-agent-title">
              <div className="setup-stage-heading">
                <div><p className="eyebrow">Step 2</p><h3 ref={setupStageHeadingRef} tabIndex={-1} id="setup-agent-title">{CONNECTED_SETUP_STEPS[1].title}</h3></div>
                <p>Paste one request. Your agent uses available sign-ins for safe read-only checks and asks only when an account choice or new sign-in is required.</p>
              </div>
              <section className={`setup-source-summary${isDemo ? " support-only" : ""}`} aria-labelledby="setup-selected-sources-title">
                <header className="setup-source-summary-header">
                  <div>
                    <small id="setup-selected-sources-title">Included in this run</small>
                    <strong>{isDemo ? selectedConnectors.map((connector) => connector.name).join(" · ") : `${selectedConnectors.length} ${selectedConnectors.length === 1 ? "source" : "sources"}`}</strong>
                  </div>
                  <button className="setup-text-button" type="button" onClick={() => goToStep(0)}>Change sources</button>
                </header>
                <ul className="setup-source-status-list" aria-label="Selected source handoff">
                  {selectedConnectors.map((connector) => {
                    const connection = connectionStates.get(connector.id) ?? resolveConnectorConnection(connections, connector.id, { now: statusClock });
                    const refreshCopy = futureRefreshCopy(connector.id, connection);
                    return (
                      <li key={connector.id}>
                        <strong>{connector.name}</strong>
                        <div className="setup-source-states">
                          <div><small>This run</small><strong>Included</strong></div>
                          <div><small>Future refresh</small><strong className={connection.profileCount ? "saved" : "not-saved"}>{refreshCopy}</strong></div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
                <div className="setup-run-guidance">
                  <strong>Available sign-ins are checked automatically</strong>
                  <span>Your agent asks only if there is more than one account or a new sign-in is needed. After the results, saving a connection for future refresh is optional.</span>
                </div>
              </section>
              <div className="setup-after-paste" aria-label="What happens after you paste the request">
                <h4>One request, then one clear step at a time</h4>
                <ol>
                  <li><span>1</span><p><strong>Paste once</strong> Start one coding-agent task with the request below.</p></li>
                  <li><span>2</span><p><strong>Check what is available</strong> Your agent uses existing access for the selected read-only checks.</p></li>
                  <li><span>3</span><p><strong>Review the results</strong> You see candidates before saving a connection or changing the catalog.</p></li>
                </ol>
              </div>
              <section className="setup-run-location" aria-labelledby="setup-run-location-title">
                <h4 id="setup-run-location-title">Open a fresh Codex task</h4>
                <p>Open it on the computer with the selected projects or sign-ins. When <strong>This computer</strong> is included, use the computer you want DevHub to inspect.</p>
                <p>DevHub verifies its installed setup workflow before it checks any selected source.</p>
                <details className="setup-agent-details">
                  <summary>Other agents and contributor checkout</summary>
                  <div>
                    <p>If DevHub is not installed for all coding-agent tasks yet, open an approved DevHub checkout instead. No absolute path is required.</p>
                    <div className="setup-agent-clients" aria-label="Supported coding agents">
                      {[
                        ["Claude Code", "Paste into a new coding task"],
                        ["Cursor", "Paste into Agent chat"],
                      ].map(([name, instruction]) => <article key={name}><strong>{name}</strong><span>{instruction}</span></article>)}
                    </div>
                  </div>
                </details>
              </section>
              {copied === "setup" ? <p className="setup-copy-ack" role="status">Copied. Continue in your coding-agent task.</p> : null}
              {copied === "failed" && setupRequest ? <CopyFallback value={setupRequest} label="Setup request to copy manually" /> : null}
            </div>
          ) : null}
            </div>

            <footer className="setup-action-bar">
              <button className="setup-text-button" type="button" disabled={step === 0} onClick={() => goToStep(Math.max(0, step - 1))}>{step ? "← Back" : ""}</button>
              <div className="setup-action-summary" aria-live="polite">
                {step === 0 ? <><strong>{selectedConnectors.length} {selectedConnectors.length === 1 ? "source" : "sources"} included</strong><span>{selectedConnectors.length ? "Ready to prepare request" : "Select at least one source"}</span></> : null}
                {step === 1 ? <><strong>Continue with your coding agent</strong><span>{selectedConnectors.length} {selectedConnectors.length === 1 ? "source" : "sources"} · read-only after paste</span></> : null}
              </div>
              {step === 0 ? <button className="setup-primary" disabled={!selectedConnectors.length} onClick={() => goToStep(1)}>Continue with {selectedConnectors.length} {selectedConnectors.length === 1 ? "source" : "sources"} <span aria-hidden="true">→</span></button> : null}
              {step === 1 ? <button className="setup-primary" disabled={!setupRequest} onClick={() => void copySetupPrompt()}>{copied === "setup" ? "Copied — paste into your agent" : copied === "failed" ? "Try copying again" : "Copy setup request"}</button> : null}
            </footer>
          </section>
        </div>
      ) : null}
    </section>
  );
}

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

function matches(project: Project, query: string, hostNames: Map<string, string>) {
  const haystack = [
    project.id,
    project.title,
    project.description,
    ...(project.aliases ?? []),
    ...(project.tags ?? []),
    ...project.services.flatMap((service) => {
      const readiness = resolveServiceReadinessContext(project, service).readiness;
      return [
        service.name,
        service.kind,
        service.runtime,
        service.host,
        hostNames.get(service.host),
        readiness?.profile,
        readiness?.owner,
        readiness?.dataClassification,
        readiness?.costModel,
        ...stewardshipSearchTerms(project, service),
        ...(service.links ?? []).flatMap((link) => [link.label, link.type, link.url]),
      ];
    }),
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

type ReadinessEvidence = NonNullable<Service["readiness"]>["evidence"][number];
type RecoveryState = ReadinessEvidence["state"] | "stale" | "registered";
type RecoverySignal = {
  id: string;
  title: string;
  state: RecoveryState;
  label: string;
  detail: string;
};

const recoveryStateLabels: Record<RecoveryState, string> = {
  verified: "Verified",
  declared: "Declared",
  missing: "Missing",
  "not-applicable": "Not applicable",
  unknown: "Unknown",
  stale: "Stale",
  registered: "Registered",
};

function recoveryAssessmentSignal(assessment: ReadinessAssessment, check: ReadinessEvidence["check"], title: string): RecoverySignal {
  const item = assessment.checks.find((candidate) => candidate.check === check);
  if (!item) {
    return {
      id: check,
      title,
      state: "unknown",
      label: "Unknown",
      detail: `No ${title.toLowerCase()} evidence is registered.`,
    };
  }

  return {
    id: check,
    title,
    state: item.state,
    label: recoveryStateLabels[item.state],
    detail: item.evidence?.note ?? item.action ?? `No ${title.toLowerCase()} evidence is registered.`,
  };
}

function recoverySignals(
  service: Service,
  assessment: ReadinessAssessment,
  ownerContext?: { value: string | null; provenance: "service" | "project" | "absent" },
): RecoverySignal[] {
  const logsLink = service.links?.some((link) => link.type === "logs") ?? false;
  const logsCommand = Boolean(service.commands?.logs);
  const logsLabel = logsLink && logsCommand
    ? "Link + command registered"
    : logsLink
      ? "Link registered"
      : logsCommand
        ? "Command registered"
        : "Unknown";
  const deployment = recoveryAssessmentSignal(assessment, "deployment", "Deployment");
  const rollback = recoveryAssessmentSignal(assessment, "rollback", "Rollback");
  const backup = recoveryAssessmentSignal(assessment, "backup", "Backup");
  const restore = recoveryAssessmentSignal(assessment, "restore", "Restore");
  const ownership = recoveryAssessmentSignal(assessment, "ownership", "Ownership");
  const deploymentFacts = service.readiness?.deployment;
  if (deploymentFacts) {
    const facts = [deploymentFacts.provider, deploymentFacts.revision, deploymentFacts.deployedAt
      ? new Date(deploymentFacts.deployedAt).toLocaleString()
      : null].filter(Boolean).join(" · ");
    deployment.detail = facts ? `${facts}. ${deployment.detail}` : deployment.detail;
  }
  if (ownerContext?.value) {
    const label = ownerContext.provenance === "project"
      ? `Project context owner: ${ownerContext.value} (inherited; not ownership evidence)`
      : `Service owner: ${ownerContext.value}`;
    ownership.detail = `${label}. ${ownership.detail}`;
  }
  const recoveryPriority: Record<RecoveryState, number> = {
    missing: 6,
    unknown: 5,
    stale: 4,
    declared: 3,
    registered: 2,
    "not-applicable": 1,
    verified: 0,
  };
  const dataRecoveryState = [backup.state, restore.state].sort(
    (left, right) => recoveryPriority[right] - recoveryPriority[left],
  )[0];

  return [
    {
      id: "logs",
      title: "Logs",
      state: logsLink || logsCommand ? "registered" : "unknown",
      label: logsLabel,
      detail: logsLink || logsCommand
        ? `${logsLink ? "A reviewed logs link" : "No logs link"}; ${logsCommand ? "a host command" : "no host command"}.`
        : "No logs link or host command is registered.",
    },
    deployment,
    rollback,
    {
      id: "data-recovery",
      title: "Backup + restore",
      state: dataRecoveryState,
      label: `Backup ${backup.label.toLowerCase()} · restore ${restore.label.toLowerCase()}`,
      detail: `Backup: ${backup.detail} Restore: ${restore.detail}`,
    },
    ownership,
  ];
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
  const { state, label } = statusBridgePresentation(status);
  const age = status.source === "probe" ? observationAge(status.ageMs) : null;
  return (
    <span className={`status status-${state}`} title={[status.note, age ? `Checked ${age}` : null].filter(Boolean).join(" · ") || undefined}>
      <i aria-hidden="true" />
      {label}
    </span>
  );
}

function ServiceRow({ project, service, status, hostName, currentHostId, reviewMatchLabel, onSelect }: {
  project: Project;
  service: Service;
  status: LiveServiceStatus;
  hostName: string;
  currentHostId: string | null;
  reviewMatchLabel?: string;
  onSelect: (selection: SelectedService) => void;
}) {
  const placement = servicePlacement(service, currentHostId);
  const action = nextAction(service, status, currentHostId);

  return (
    <button
      className={`service-row ${isAttention(service, status) ? "service-row-alert" : ""}${reviewMatchLabel ? " service-row-review-match" : ""}`}
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
        {reviewMatchLabel ? <em className="service-review-signal">{reviewMatchLabel}</em> : null}
      </span>
      <StatusPill status={status} />
      <span className={`service-next ${action === "Recover" ? "service-next-alert" : ""}`}>{action}</span>
    </button>
  );
}

function ProjectCard({ project, statuses, hostNames, currentHostId, serviceFilterKeys, reviewServiceKeys, reviewMatchLabel, showFullProject, onToggleFullProject, onSelect }: {
  project: Project;
  statuses: Map<string, LiveServiceStatus>;
  hostNames: Map<string, string>;
  currentHostId: string | null;
  serviceFilterKeys: Set<string> | null;
  reviewServiceKeys: Set<string> | null;
  reviewMatchLabel?: string;
  showFullProject: boolean;
  onToggleFullProject: () => void;
  onSelect: (selection: SelectedService) => void;
}) {
  const filterMatchedServices = serviceFilterKeys
    ? project.services.filter((service) => serviceFilterKeys.has(serviceKey(project.id, service.id)))
    : project.services;
  const matchingServices = reviewServiceKeys
    ? filterMatchedServices.filter((service) => reviewServiceKeys.has(serviceKey(project.id, service.id)))
    : filterMatchedServices;
  const visibleServices = reviewServiceKeys && !showFullProject ? matchingServices : filterMatchedServices;
  const hiddenServiceCount = filterMatchedServices.length - matchingServices.length;
  const attentionCount = visibleServices.filter((service) => {
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
        {visibleServices.length ? visibleServices.map((service) => (
          <ServiceRow
            key={service.id}
            project={project}
            service={service}
            status={statuses.get(serviceKey(project.id, service.id)) ?? getInitialStatus(project.id, service)}
            hostName={hostNames.get(service.host) ?? service.host}
            currentHostId={currentHostId}
            reviewMatchLabel={reviewServiceKeys?.has(serviceKey(project.id, service.id)) ? reviewMatchLabel : undefined}
            onSelect={onSelect}
          />
        )) : (
          <div className="no-runtime">
            <span>◇</span>
            <p><strong>No runtime</strong><small>Tracked as a project, not an always-on service.</small></p>
          </div>
        )}
        {reviewServiceKeys && hiddenServiceCount > 0 ? (
          <button className="project-review-expand" type="button" aria-expanded={showFullProject} onClick={onToggleFullProject}>
            {showFullProject ? "Show matching services" : `View full project · ${hiddenServiceCount} ${plural(hiddenServiceCount, "related service")}`}
          </button>
        ) : null}
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
  if (status.source === "probe" && status.freshness === "stale") return "The last probe result is stale. Refresh canonical DevHub before treating this service as live.";
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

function observationAge(ageMs: number | undefined) {
  if (ageMs === undefined || !Number.isFinite(ageMs) || ageMs < 0) return null;
  if (ageMs < 60_000) return "just now";
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes === 1) return "1 minute ago";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
}

function statusEvidence(status: LiveServiceStatus) {
  if (status.source === "probe") {
    const age = observationAge(status.ageMs);
    if (age) return `${status.freshness === "stale" ? "Stale probe" : "Live probe"} · checked ${age}`;
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

export function ServicePanel({ selection, status, hosts, currentHostId, onClose }: {
  selection: SelectedService;
  status: LiveServiceStatus;
  hosts: Host[];
  currentHostId: string | null;
  onClose: () => void;
}) {
  const { project, service } = selection;
  const [copied, setCopied] = useState<string | null>(null);
  const [failedCopy, setFailedCopy] = useState<{ label: string; value: string } | null>(null);
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
  const readinessContext = resolveServiceReadinessContext(project, service);
  const stewardshipContext = resolveServiceStewardshipContext(project, service);
  const effectiveReadiness = readinessContext.readiness;
  const readinessEvidence = effectiveReadiness?.evidence ?? [];
  const readinessAssessment = evaluateReadiness(effectiveReadiness);
  const recoveryAssessment = groupRecoveryReadiness(readinessAssessment);
  const recoveryItems = recoverySignals(
    service,
    { ...readinessAssessment, ...recoveryAssessment },
    readinessContext.fields.owner,
  );
  const verifiedEvidence = readinessAssessment.counts.verified;
  const staleEvidence = readinessAssessment.counts.stale;
  const unknownEvidence = readinessAssessment.counts.unknown + readinessAssessment.counts.missing;
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
    const succeeded = await copyText(value);
    if (succeeded) {
      setFailedCopy(null);
      setCopied(label);
      window.setTimeout(() => setCopied(null), 1800);
    } else {
      setCopied(null);
      setFailedCopy({ label, value });
    }
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
            <div>
              <small>App Passport{readinessContext.fields.profile.provenance === "project" ? " · profile inherited from project" : ""}</small>
              <strong>{effectiveReadiness?.profile ? profileLabels[effectiveReadiness.profile] : effectiveReadiness ? "Profile unknown" : "Not assessed"}</strong>
            </div>
            {effectiveReadiness ? <span>{verifiedEvidence} verified{staleEvidence ? ` · ${staleEvidence} stale` : ""}{unknownEvidence ? ` · ${unknownEvidence} unknown` : ""}</span> : null}
          </header>
          {effectiveReadiness ? (
            <dl className="passport-facts">
              <div><dt>Owner</dt><dd>{effectiveReadiness.owner ?? "Unknown"}{readinessContext.fields.owner.provenance === "project" ? " · inherited from project" : ""}</dd></div>
              <div><dt>Data</dt><dd>{effectiveReadiness.dataClassification ?? "Unknown"}{readinessContext.fields.dataClassification.provenance === "project" ? " · inherited from project" : ""}</dd></div>
              <div><dt>Cost</dt><dd>{effectiveReadiness.costModel ?? "Unknown"}{readinessContext.fields.costModel.provenance === "project" ? " · inherited from project" : ""}</dd></div>
              <div><dt>Deployed</dt><dd>{effectiveReadiness.deployment?.deployedAt ? new Date(effectiveReadiness.deployment.deployedAt).toLocaleDateString() : "Unknown"}</dd></div>
              <div className="passport-dependencies"><dt>Dependencies</dt><dd>{effectiveReadiness.dependencies?.length
                ? effectiveReadiness.dependencies.map((dependency) => `${dependency.name} · ${dependency.criticality}`).join("; ")
                : "None registered"}</dd></div>
            </dl>
          ) : null}
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
          {readinessAssessment.gaps.length ? (
            <p className="passport-next"><strong>Next:</strong> {readinessAssessment.gaps[0].action}</p>
          ) : null}
        </section>

        <section className="stewardship-card" aria-labelledby="service-stewardship-title">
          <header>
            <div><small>Reviewed stewardship</small><strong id="service-stewardship-title">Who keeps it running?</strong></div>
            <span>{stewardshipContext.summary.reviewed}/4 reviewed{stewardshipContext.summary.shared ? ` · ${stewardshipContext.summary.shared} shared` : ""}</span>
          </header>
          <dl>
            {STEWARDSHIP_ROLES.map((roleName) => {
              const role = stewardshipContext.roles[roleName];
              return (
                <div key={roleName}>
                  <dt>{stewardshipRoleLabels[roleName]}</dt>
                  <dd>
                    <strong>{role.steward?.name ?? "Unknown"}</strong>
                    <small>{role.state}{role.steward ? ` · ${role.steward.kind} · ${role.steward.source}` : ""}{role.provenance === "project" ? " · inherited" : role.provenance === "explicit-unknown" ? " · service override" : ""}</small>
                  </dd>
                </div>
              );
            })}
          </dl>
          {stewardshipContext.credentials.length ? (
            <div className="stewardship-credentials">
              <small>Credential inventory · references only</small>
              {stewardshipContext.credentials.map((credential) => (
                <p key={credential.id}><strong>{credential.provider}</strong> · {credential.purpose} · {credential.secretRef.kind} · owner {credential.ownerSteward?.name ?? "unknown"} ({credential.ownerState}) · payer {credential.payerSteward?.name ?? "unknown"} ({credential.payerState}) · verification {credential.verificationState}</p>
              ))}
            </div>
          ) : null}
          {stewardshipContext.access.length ? (
            <div className="stewardship-access">
              <small>Access evidence · separate from ownership</small>
              <p>{stewardshipContext.access.map((fact) => `${fact.kind}: ${fact.subject} · ${fact.access}${fact.freshnessState === "stale" ? ` · stale (recorded ${fact.recordedAccess})` : " · reviewed"}`).join("; ")}</p>
            </div>
          ) : null}
          {stewardshipContext.summary.missing || stewardshipContext.summary.stale || stewardshipContext.summary.singlePersonRisk || stewardshipContext.summary.credentialsWithUnknownPayer || stewardshipContext.summary.credentialsWithStaleOwner || stewardshipContext.summary.staleAccess ? (
            <p className="stewardship-question"><strong>Question:</strong> {stewardshipContext.summary.singlePersonRisk
              ? "Would another person or team be able to operate and recover this service?"
              : stewardshipContext.summary.stale
                ? "Who can refresh the expired stewardship evidence?"
                : stewardshipContext.summary.staleAccess
                  ? "Who can refresh the expired access evidence?"
                  : stewardshipContext.summary.credentialsWithStaleOwner
                    ? "Who currently owns the credential lifecycle?"
                    : stewardshipContext.summary.credentialsWithUnknownPayer
                      ? "Who pays for the provider usage behind this credential reference?"
                      : "Who should own the missing operating roles?"}</p>
          ) : null}
        </section>

        <section className="recovery-card" aria-labelledby="service-recovery-title">
          <header>
            <div><small>Recovery &amp; ownership</small><strong id="service-recovery-title">Can you get it back?</strong></div>
            <span>Read-only</span>
          </header>
          <dl>
            {recoveryItems.map((item) => (
              <div key={item.id}>
                <dt><span className={`recovery-state recovery-state-${item.state}`} aria-hidden="true" />{item.title}</dt>
                <dd>
                  <strong>{item.label}</strong>
                  <small>{item.detail}</small>
                </dd>
              </div>
            ))}
          </dl>
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
              <i aria-live="polite">{copied === "command" ? "Copied" : failedCopy?.label === "command" ? "Try again" : "Copy"}</i>
            </button>
          ) : null}

          <button className="panel-command panel-codex" onClick={() => void copy("codex", copyRequest(project, service, status, hostName))}>
            <span><small>Need help?</small><strong>Copy request for Codex</strong></span>
            <i aria-live="polite">{copied === "codex" ? "Copied" : failedCopy?.label === "codex" ? "Try again" : "Copy"}</i>
          </button>
          {failedCopy ? <CopyFallback value={failedCopy.value} label={failedCopy.label === "command" ? "Command to copy manually" : "Codex request to copy manually"} /> : null}
        </div>

        <footer className="panel-footer">
          <span>{statusEvidence(status)}</span>
          {project.repository ? <a href={`https://github.com/${project.repository}`} target="_blank" rel="noreferrer">Repository ↗</a> : null}
        </footer>
      </aside>
    </div>
  );
}

export function DevHubDashboard({
  catalog,
  initialCatalogInsight = "all",
  initialReviewOpen = false,
  initialHostFilter = "all",
  initialStatusFilter = "all",
  statusApiEndpoint = SAME_ORIGIN_STATUS_API_ENDPOINT,
  viewerContextEndpoint = "/api/context",
}: {
  catalog: Catalog;
  initialCatalogInsight?: CatalogInsight;
  initialReviewOpen?: boolean;
  initialHostFilter?: string;
  initialStatusFilter?: ServiceStatusFilter;
  statusApiEndpoint?: string | null;
  viewerContextEndpoint?: string | null;
}) {
  const [query, setQuery] = useState("");
  const [lifecycle, setLifecycle] = useState("all");
  const [catalogInsight, setCatalogInsight] = useState<CatalogInsight>(initialCatalogInsight);
  const [hostFilter, setHostFilter] = useState(initialHostFilter);
  const [statusFilter, setStatusFilter] = useState<ServiceStatusFilter>(initialStatusFilter);
  const [liveStatuses, setLiveStatuses] = useState<LiveServiceStatus[]>([]);
  const [viewerContext, setViewerContext] = useState<ViewerContext | null>(null);
  const [hostOverride, setHostOverride] = useState("auto");
  const [selectedService, setSelectedService] = useState<SelectedService | null>(null);
  const [registrationCopied, setRegistrationCopied] = useState(false);
  const [registrationCopyFailed, setRegistrationCopyFailed] = useState(false);
  const [installCopied, setInstallCopied] = useState(false);
  const [installCopyFailed, setInstallCopyFailed] = useState(false);
  const [openMetricHelp, setOpenMetricHelp] = useState<Exclude<CatalogInsight, "all"> | null>(null);
  const [dismissedMetricHelp, setDismissedMetricHelp] = useState<Exclude<CatalogInsight, "all"> | null>(null);
  const [reviewOpen, setReviewOpen] = useState(initialReviewOpen);
  const [expandedReviewProjects, setExpandedReviewProjects] = useState<Set<string>>(() => new Set());
  const [refreshing, setRefreshing] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const [lastRefreshMode, setLastRefreshMode] = useState<StatusResponse["freshness"]["mode"] | null>(null);
  const [statusUnavailable, setStatusUnavailable] = useState(false);
  const reviewTriggerRef = useRef<HTMLElement | null>(null);
  const reviewedServiceKeys = useMemo(() => new Set(catalog.projects.flatMap((project) =>
    project.services.map((service) => serviceKey(project.id, service.id)),
  )), [catalog.projects]);
  const usesCentralStatusBridge = statusApiEndpoint !== SAME_ORIGIN_STATUS_API_ENDPOINT;

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      if (!statusApiEndpoint) throw new Error("DevHub companion status endpoint is not configured");
      const statusResponse = await fetch(statusApiEndpoint, { cache: "no-store", credentials: "omit", mode: "cors" });
      if (!statusResponse.ok) throw new Error("DevHub status refresh failed");
      const statusResult = selectReviewedStatusSnapshot(await statusResponse.json(), reviewedServiceKeys) as StatusResponse | null;
      if (!statusResult) throw new Error("DevHub returned an invalid status snapshot");
      let contextResult: ViewerContext | null = null;
      if (viewerContextEndpoint) {
        const contextResponse = await fetch(viewerContextEndpoint, { cache: "no-store" });
        if (!contextResponse.ok) throw new Error("DevHub context refresh failed");
        contextResult = await contextResponse.json() as ViewerContext;
      }
      setLiveStatuses(statusResult.statuses);
      setLastRefresh(statusResult.freshness.newestCheckedAt ?? statusResult.observedAt);
      setLastRefreshMode(statusResult.freshness.mode);
      setViewerContext(contextResult);
      setStatusUnavailable(false);
    } catch {
      setLiveStatuses([]);
      setLastRefresh(null);
      setLastRefreshMode(null);
      setStatusUnavailable(true);
    } finally {
      setRefreshing(false);
    }
  }, [reviewedServiceKeys, statusApiEndpoint, viewerContextEndpoint]);

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
    const succeeded = await copyText(devHubAgentRequest);
    setRegistrationCopied(succeeded);
    setRegistrationCopyFailed(!succeeded);
    if (succeeded) window.setTimeout(() => setRegistrationCopied(false), 2200);
  };

  const copyInstallRequest = async () => {
    const succeeded = await copyText(devHubInstallRequest);
    setInstallCopied(succeeded);
    setInstallCopyFailed(!succeeded);
    if (succeeded) window.setTimeout(() => setInstallCopied(false), 2200);
  };

  const statusMap = useMemo(() => {
    const initial = catalog.projects.flatMap((project) =>
      project.services.map((service) => getInitialStatus(project.id, service)),
    );
    return new Map([...initial, ...liveStatuses].map((status) => [status.key, status]));
  }, [catalog.projects, liveStatuses]);

  const currentHostId = hostOverride === "auto" ? (viewerContext?.detectedHostId ?? null) : hostOverride;
  const currentHost = catalog.hosts.find((host) => host.id === currentHostId) ?? null;
  const selectableHosts = catalog.hosts.filter((host) => host.kind === "mac" || host.kind === "windows" || host.kind === "linux");
  const hostNames = useMemo(() => new Map(catalog.hosts.map((host) => [host.id, host.name])), [catalog.hosts]);
  const serviceHosts = useMemo(() => {
    const registeredHostIds = new Set(catalog.projects.flatMap((project) => project.services.map((service) => service.host)));
    return catalog.hosts.filter((host) => registeredHostIds.has(host.id));
  }, [catalog.hosts, catalog.projects]);
  const detectedHostName = viewerContext?.detectedHostId ? hostNames.get(viewerContext.detectedHostId) : null;
  const serviceStatuses = catalog.projects.flatMap((project) => project.services.map((service) => ({
    service,
    status: statusMap.get(serviceKey(project.id, service.id)) ?? getInitialStatus(project.id, service),
  })));
  const upCount = serviceStatuses.filter(({ status }) => isFreshLiveStatus(status)).length;
  const attentionCount = serviceStatuses.filter(({ service, status }) => isAttention(service, status)).length;
  const serviceCount = serviceStatuses.length;
  const reviewPresentation = useMemo(() => deriveCatalogReviewPresentation(catalog.projects), [catalog.projects]);
  const activeReviewScope = catalogInsight === "all" ? null : reviewPresentation.scopes[catalogInsight];
  const reviewServiceKeys = useMemo(
    () => activeReviewScope ? new Set(activeReviewScope.serviceKeys) : null,
    [activeReviewScope],
  );
  const serviceFilterActive = hostFilter !== "all" || statusFilter !== "all";
  const serviceFilterKeys = useMemo(() => {
    if (!serviceFilterActive) return null;
    const keys = new Set<string>();
    for (const project of catalog.projects) {
      for (const service of project.services) {
        const status = statusMap.get(serviceKey(project.id, service.id)) ?? getInitialStatus(project.id, service);
        if ((hostFilter === "all" || service.host === hostFilter) && matchesServiceStatusFilter(service, status, statusFilter)) {
          keys.add(serviceKey(project.id, service.id));
        }
      }
    }
    return keys;
  }, [catalog.projects, hostFilter, serviceFilterActive, statusFilter, statusMap]);
  const matchingServiceKeys = useMemo(() => {
    if (!reviewServiceKeys) return serviceFilterKeys;
    if (!serviceFilterKeys) return reviewServiceKeys;
    return new Set([...serviceFilterKeys].filter((key) => reviewServiceKeys.has(key)));
  }, [reviewServiceKeys, serviceFilterKeys]);
  const gapServiceCount = reviewPresentation.scopes["evidence-gap"].matchingServiceCount;
  const visibleProjects = catalog.projects.filter((project) =>
    (lifecycle === "all" || project.lifecycle === lifecycle)
    && (!matchingServiceKeys || project.services.some((service) => matchingServiceKeys.has(serviceKey(project.id, service.id))))
    && matches(project, query, hostNames),
  );
  const visibleMatchingServiceCount = matchingServiceKeys
    ? visibleProjects.reduce((count, project) => count + project.services.filter((service) => matchingServiceKeys.has(serviceKey(project.id, service.id))).length, 0)
    : visibleProjects.reduce((count, project) => count + project.services.length, 0);
  const lifecycleStateCount = new Set(catalog.projects.map((project) => project.lifecycle)).size;
  const isDemo = catalog.instance.mode === "demo";

  const chooseCatalogView = (nextLifecycle: string, nextInsight: CatalogInsight = "all") => {
    setLifecycle(nextLifecycle);
    setCatalogInsight(nextInsight);
    setHostFilter("all");
    setStatusFilter("all");
    window.requestAnimationFrame(() => document.getElementById("catalog-results")?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };

  const isCatalogView = (expectedLifecycle: string, expectedInsight: CatalogInsight = "all") => (
    lifecycle === expectedLifecycle && catalogInsight === expectedInsight
  );

  const selectReviewScope = (scope: Exclude<CatalogInsight, "all">) => {
    setCatalogInsight((current) => current === scope ? "all" : scope);
    setLifecycle("all");
    setQuery("");
    setExpandedReviewProjects(new Set());
  };

  const clearCatalogView = () => {
    setCatalogInsight("all");
    setLifecycle("all");
    setHostFilter("all");
    setStatusFilter("all");
    setQuery("");
    setExpandedReviewProjects(new Set());
  };

  const serviceScopeActive = matchingServiceKeys !== null;
  const hasCatalogFilters = catalogInsight !== "all" || lifecycle !== "all" || hostFilter !== "all" || statusFilter !== "all" || Boolean(query);
  const catalogViewSummary = [
    catalogInsightLabels[catalogInsight],
    lifecycle === "all" ? "every lifecycle" : lifecycleLabels[lifecycle],
    hostFilter === "all" ? null : `runs on ${hostNames.get(hostFilter) ?? hostFilter}`,
    statusFilter === "all" ? null : serviceStatusFilterLabels[statusFilter],
  ].filter(Boolean).join(" · ");

  const toggleFullProject = (projectId: string) => {
    setExpandedReviewProjects((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  const openReviewHandoff = (trigger: HTMLElement) => {
    reviewTriggerRef.current = trigger;
    setReviewOpen(true);
  };

  const closeReviewHandoff = useCallback(() => setReviewOpen(false), []);
  const restoreReviewFocus = useCallback(() => reviewTriggerRef.current?.focus({ preventScroll: true }), []);

  return (
    <main>
      <section className="hero">
        <nav className="topbar" aria-label="DevHub navigation">
          <a className="brand" href="#top" aria-label="DevHub home"><span>DH</span> DevHub</a>
          <div className="topbar-actions">
            <span className={`instance-badge instance-${catalog.instance.mode}`}><i />{catalog.instance.label}</span>
            {!isDemo ? <span className="viewer-badge"><i />{currentHost ? `You are on ${currentHost.name}` : "Choose your device below"}</span> : null}
            <a className="topbar-link" href="#catalog-results">Catalog</a>
            <a className="topbar-link" href="#connections">Connections</a>
            <a className="topbar-link" href="#why-devhub">Why DevHub</a>
            <a href={isDemo ? "#install" : "#registration"}>{isDemo ? "Get DevHub" : "Add a project"}</a>
          </div>
        </nav>

        <div className={`hero-grid${isDemo ? " hero-grid-demo" : ""}`}>
          <div className="hero-copy">
            <p className="eyebrow">The home for what you shipped</p>
            <h1>Never lose track of what your agent shipped.</h1>
            <p>Your coding agent can build and deploy it. DevHub keeps the operational context from disappearing—what exists, where it runs, what’s current, and what to do next across your laptops, servers, and clouds.</p>
            <p className="hero-brand-line">Git remembers the code. DevHub remembers how it runs.</p>
            {isDemo ? (
              <ol className="hero-route" aria-label="Get started with DevHub">
                <li><a href="#install"><span>01</span>Get DevHub</a></li>
                <li><a href="#connections"><span>02</span>Set up connections</a></li>
                <li><a href="#demo-workspace"><span>03</span>Explore demo workspace</a></li>
              </ol>
            ) : null}
            <div className="hero-actions">
              <a className="hero-primary" href={isDemo ? "#install" : "#catalog-results"}>{isDemo ? "Get DevHub" : `Open my ${serviceCount} services`}</a>
              <a className="hero-secondary" href={isDemo ? "#demo-workspace" : "#why-devhub"}>{isDemo ? "Explore demo" : "See how it works ↓"}</a>
            </div>
          </div>
          {!isDemo ? <div className="hero-stats" aria-label="Catalog summary">
            <div><strong>{catalog.projects.length}</strong><span>projects</span></div>
            <div><strong>{serviceCount}</strong><span>services</span></div>
            <div><strong>{upCount}</strong><span>reachable</span></div>
            <div className={attentionCount ? "attention" : ""}><strong>{attentionCount}</strong><span>needs action</span></div>
          </div> : null}
        </div>

        {!isDemo ? <div className="host-strip" aria-label="Registered hosts">
          {catalog.hosts.map((host) => (
            <span key={host.id} className={currentHostId === host.id ? "current-host" : ""}>
              <i className={`host-${host.location}`} />{host.name}
              <small>{currentHostId === host.id ? "this device" : host.tailscaleName ?? host.kind}</small>
            </span>
          ))}
        </div> : null}
      </section>

      <section className="workspace" id="catalog">
        {isDemo ? (
          <section className="install-path" id="install" aria-labelledby="install-title">
            <header className="install-path-heading">
              <div>
                <p className="eyebrow">Get DevHub</p>
                <h2 id="install-title">From install to your dashboard in three steps.</h2>
              </div>
              <p>Start with one coding-agent request, then choose the accounts and computers that belong in your map.</p>
            </header>
            <ol className="install-steps">
              <li>
                <span className="install-step-number">01</span>
                <div>
                  <small>First</small>
                  <h3>Install with your coding agent</h3>
                  <p>Give Codex, Claude Code, or Cursor one request to install the current alpha and prepare this computer.</p>
                  <button className="install-primary" type="button" onClick={() => void copyInstallRequest()}>
                    {installCopied ? "Copied — open an agent task" : installCopyFailed ? "Try copying again" : "Copy install request"}
                  </button>
                  <span className="install-copy-status" aria-live="polite">{installCopied ? "Ready to paste" : "Current DevHub alpha"}</span>
                  {installCopyFailed ? <CopyFallback value={devHubInstallRequest} label="Install request to copy manually" /> : null}
                </div>
              </li>
              <li>
                <span className="install-step-number">02</span>
                <div>
                  <small>Then</small>
                  <h3>Start DevHub</h3>
                  <p>Your agent verifies the project requirements, installs the locked dependencies, and starts the local dashboard.</p>
                  <div className="install-commands" aria-label="Commands run after DevHub source is available">
                    <code>npm ci</code>
                    <code>npm run dev</code>
                  </div>
                </div>
              </li>
              <li>
                <span className="install-step-number">03</span>
                <div>
                  <small>Next</small>
                  <h3>Connect sources</h3>
                  <p>Choose GitHub, hosting providers, and this computer. Your agent builds one bounded setup request from that selection.</p>
                  <a href="#connections">Set up connections <span aria-hidden="true">↓</span></a>
                </div>
              </li>
            </ol>
          </section>
        ) : null}

        <ConnectedSetup existingCatalog={catalog.projects.length > 0} instanceMode={catalog.instance.mode} connections={catalog.connections} />

        {!isDemo ? (
          <div className="catalog-context-bar" aria-label="Catalog context">
            <label className="device-context">
              <span>Device context</span>
              <select value={hostOverride} onChange={(event) => changeHost(event.target.value)} aria-label="Device context">
                <option value="auto">{detectedHostName ? `Detected · ${detectedHostName}` : "Not selected"}</option>
                {selectableHosts.map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}
              </select>
            </label>
            <div className="catalog-observation">
              <div>
                <span>{statusUnavailable
                  ? usesCentralStatusBridge ? "Central LIVE unavailable · connect this device to the private network and allow local network access" : "Service status unavailable"
                  : lastRefresh ? `Latest observation ${new Date(lastRefresh).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${lastRefreshMode === "cache" ? "cached" : lastRefreshMode === "shared" ? "shared refresh" : "updated"}`
                    : usesCentralStatusBridge ? "Connecting to central LIVE through this device" : "Checking service status"}</span>
                <small>View updates every 30s · backend probes stay bounded to 5 min, or 15 min for on-demand workstation/server services</small>
              </div>
              <button className="refresh" title="Reads the central status cache; reviewed probes refresh only after their safe interval." onClick={() => void refresh()} disabled={refreshing}>{refreshing ? "Checking…" : "Refresh view"}</button>
            </div>
          </div>
        ) : null}

        {isDemo ? (
          <section className="demo-workspace-intro" id="demo-workspace" aria-labelledby="demo-workspace-title">
            <header className="demo-workspace-copy">
              <p className="eyebrow">Explore the product</p>
              <h2 id="demo-workspace-title">Demo workspace</h2>
              <p>Open a catalog view to see how DevHub organizes production, discovery, paused, local, healthy, degraded, and unknown services.</p>
            </header>
            <div className="demo-scenario-buttons" aria-label="Demo workspace views">
              <button className={isCatalogView("all") ? "selected" : ""} aria-pressed={isCatalogView("all")} onClick={() => chooseCatalogView("all")}>All examples</button>
              <button className={isCatalogView("production") ? "selected" : ""} aria-pressed={isCatalogView("production")} onClick={() => chooseCatalogView("production")}>Production</button>
              <button className={isCatalogView("all", "evidence-gap") ? "selected" : ""} aria-pressed={isCatalogView("all", "evidence-gap")} onClick={() => chooseCatalogView("all", "evidence-gap")}>Needs review</button>
              <button className={isCatalogView("discovery") ? "selected" : ""} aria-pressed={isCatalogView("discovery")} onClick={() => chooseCatalogView("discovery")}>Discovery</button>
              <button className={isCatalogView("paused") ? "selected" : ""} aria-pressed={isCatalogView("paused")} onClick={() => chooseCatalogView("paused")}>Paused</button>
            </div>
            <div className="demo-workspace-summary" aria-label="Demo workspace summary">
              <div><strong>{catalog.projects.length}</strong><span>projects</span></div>
              <div><strong>{serviceCount}</strong><span>services</span></div>
              <div><strong>{lifecycleStateCount}</strong><span>lifecycle states</span></div>
              <div className={gapServiceCount ? "attention" : ""}><strong>{gapServiceCount}</strong><span>need review</span></div>
            </div>
            <section className="demo-runtime-map" aria-labelledby="demo-runtime-map-title">
              <p id="demo-runtime-map-title">Runtime map</p>
              <div className="host-strip demo-host-strip" aria-label="Runtime locations">
                {catalog.hosts.map((host) => (
                  <span key={host.id}>
                    <i className={`host-${host.location}`} />{host.name}
                    <small>{host.tailscaleName ?? host.kind}</small>
                  </span>
                ))}
              </div>
            </section>
          </section>
        ) : null}

        <section className="catalog-browser" id="catalog-results" aria-labelledby="catalog-results-title">
          <div className="section-heading">
            <div><p className="eyebrow">{isDemo ? "Project catalog" : "Operational catalog"}</p><h2 id="catalog-results-title">{serviceScopeActive ? `${visibleMatchingServiceCount} matching ${plural(visibleMatchingServiceCount, "service")} in ${visibleProjects.length} ${plural(visibleProjects.length, "project")}` : `${visibleProjects.length} visible ${plural(visibleProjects.length, "project")}`}</h2></div>
            <p>{serviceCount} total {isDemo ? "services" : "registered services"}</p>
          </div>
          <div className="control-row">
            <label className="search">
              <span aria-hidden="true">⌕</span>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search projects, services, hosts, runtimes…" aria-label="Search catalog" />
            </label>
            <div className="service-filters" role="group" aria-label="Service filters">
              <label className="catalog-filter-select">
                <span>Runs on</span>
                <select value={hostFilter} onChange={(event) => setHostFilter(event.target.value)} aria-label="Runs on">
                  <option value="all">All locations</option>
                  {serviceHosts.map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}
                </select>
              </label>
              <label className="catalog-filter-select">
                <span>Status</span>
                <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as ServiceStatusFilter)} aria-label="Service status">
                  {serviceStatusFilterValues.map((value) => <option key={value} value={value}>{serviceStatusFilterLabels[value]}</option>)}
                </select>
              </label>
            </div>
            <div className="filters" aria-label="Lifecycle filter">
              {(isDemo ? ["all", "production", "active", "discovery", "paused"] : ["all", "production", "active", "discovery"]).map((value) => (
                <button key={value} className={lifecycle === value ? "selected" : ""} onClick={() => setLifecycle(value)}>
                  {value === "all" ? "All" : lifecycleLabels[value]}
                </button>
              ))}
            </div>
          </div>
          <div className="catalog-view-summary" aria-live="polite">
            <span>{serviceScopeActive ? `Showing ${visibleMatchingServiceCount} matching ${plural(visibleMatchingServiceCount, "service")} in ${visibleProjects.length} ${plural(visibleProjects.length, "project")} · ${catalogViewSummary}` : catalogViewSummary}</span>
            {hasCatalogFilters ? <button onClick={clearCatalogView}>Clear view</button> : null}
          </div>
        </section>

        <section className="portfolio-review" aria-label="Portfolio review">
          <div>
            <p className="eyebrow">Portfolio guardian</p>
            <h3>What needs a decision before it becomes a surprise?</h3>
            <p>Review service ownership, monitoring, and recovery evidence, then open the exact projects behind each signal.</p>
          </div>
          <div className="portfolio-metrics" role="group" aria-label="Filter catalog by review signal">
            <article className="portfolio-metric" data-help-open={openMetricHelp === "passport"} data-help-dismissed={dismissedMetricHelp === "passport"}>
              <button className="portfolio-metric-filter" aria-pressed={catalogInsight === "passport"} onClick={() => selectReviewScope("passport")}>
                <strong>{reviewPresentation.scopes.passport.matchingServiceCount}</strong><span>{plural(reviewPresentation.scopes.passport.matchingServiceCount, "service")} {reviewPresentation.scopes.passport.matchingServiceCount === 1 ? "has" : "have"} App Passport</span><small>{reviewPresentation.scopes.passport.matchingProjectCount} {plural(reviewPresentation.scopes.passport.matchingProjectCount, "project")}</small>
              </button>
              <button className="portfolio-metric-help" type="button" aria-label="About services with context" aria-expanded={openMetricHelp === "passport"} aria-controls="portfolio-help-passport" aria-describedby="portfolio-help-passport" onClick={() => { const closing = openMetricHelp === "passport"; setOpenMetricHelp(closing ? null : "passport"); setDismissedMetricHelp(closing ? "passport" : null); }} onBlur={() => setDismissedMetricHelp((current) => current === "passport" ? null : current)} onKeyDown={(event) => { if (event.key === "Escape") { setOpenMetricHelp(null); setDismissedMetricHelp("passport"); } }}>?</button>
              <div className="portfolio-metric-popover" id="portfolio-help-passport" role="tooltip">{portfolioMetricHelp.passport}</div>
            </article>
            <article className="portfolio-metric" data-help-open={openMetricHelp === "evidence-gap"} data-help-dismissed={dismissedMetricHelp === "evidence-gap"}>
              <button className="portfolio-metric-filter" aria-pressed={catalogInsight === "evidence-gap"} onClick={() => selectReviewScope("evidence-gap")}>
                <strong>{reviewPresentation.scopes["evidence-gap"].matchingServiceCount}</strong><span>{plural(reviewPresentation.scopes["evidence-gap"].matchingServiceCount, "service")} {reviewPresentation.scopes["evidence-gap"].matchingServiceCount === 1 ? "has" : "have"} evidence gaps</span><small>{reviewPresentation.scopes["evidence-gap"].questionItemCount} {plural(reviewPresentation.scopes["evidence-gap"].questionItemCount, "check")} {reviewPresentation.scopes["evidence-gap"].questionItemCount === 1 ? "needs" : "need"} evidence</small>
              </button>
              <button className="portfolio-metric-help" type="button" aria-label="About services to review" aria-expanded={openMetricHelp === "evidence-gap"} aria-controls="portfolio-help-evidence-gap" aria-describedby="portfolio-help-evidence-gap" onClick={() => { const closing = openMetricHelp === "evidence-gap"; setOpenMetricHelp(closing ? null : "evidence-gap"); setDismissedMetricHelp(closing ? "evidence-gap" : null); }} onBlur={() => setDismissedMetricHelp((current) => current === "evidence-gap" ? null : current)} onKeyDown={(event) => { if (event.key === "Escape") { setOpenMetricHelp(null); setDismissedMetricHelp("evidence-gap"); } }}>?</button>
              <div className="portfolio-metric-popover" id="portfolio-help-evidence-gap" role="tooltip">{portfolioMetricHelp["evidence-gap"]}</div>
            </article>
            <article className="portfolio-metric" data-help-open={openMetricHelp === "stewardship"} data-help-dismissed={dismissedMetricHelp === "stewardship"}>
              <button className="portfolio-metric-filter" aria-pressed={catalogInsight === "stewardship"} onClick={() => selectReviewScope("stewardship")}>
                <strong>{reviewPresentation.scopes.stewardship.matchingServiceCount}</strong><span>{plural(reviewPresentation.scopes.stewardship.matchingServiceCount, "service")} {reviewPresentation.scopes.stewardship.matchingServiceCount === 1 ? "needs" : "need"} ownership review</span><small>{reviewPresentation.scopes.stewardship.matchingProjectCount} {plural(reviewPresentation.scopes.stewardship.matchingProjectCount, "project")} · {reviewPresentation.scopes.stewardship.questionItemCount} {plural(reviewPresentation.scopes.stewardship.questionItemCount, "ownership item")}</small>
              </button>
              <button className="portfolio-metric-help" type="button" aria-label="About ownership questions" aria-expanded={openMetricHelp === "stewardship"} aria-controls="portfolio-help-stewardship" aria-describedby="portfolio-help-stewardship" onClick={() => { const closing = openMetricHelp === "stewardship"; setOpenMetricHelp(closing ? null : "stewardship"); setDismissedMetricHelp(closing ? "stewardship" : null); }} onBlur={() => setDismissedMetricHelp((current) => current === "stewardship" ? null : current)} onKeyDown={(event) => { if (event.key === "Escape") { setOpenMetricHelp(null); setDismissedMetricHelp("stewardship"); } }}>?</button>
              <div className="portfolio-metric-popover" id="portfolio-help-stewardship" role="tooltip">{portfolioMetricHelp.stewardship}</div>
            </article>
          </div>
          <button className="portfolio-review-agent" type="button" onClick={(event) => openReviewHandoff(event.currentTarget)}>{catalogInsight === "all" ? "Review open items with your agent" : `Review these ${activeReviewScope?.matchingServiceCount ?? 0} ${plural(activeReviewScope?.matchingServiceCount ?? 0, "service")} with your agent`} <span aria-hidden="true">→</span></button>
          <p className="portfolio-review-status" aria-live="polite">{serviceScopeActive ? `Showing ${visibleMatchingServiceCount} matching ${plural(visibleMatchingServiceCount, "service")} in ${visibleProjects.length} ${plural(visibleProjects.length, "project")}` : `${serviceCount} services across ${catalog.projects.length} ${plural(catalog.projects.length, "project")}`}</p>
        </section>

        <div className="project-grid">
          {visibleProjects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              statuses={statusMap}
              hostNames={hostNames}
              currentHostId={currentHostId}
              serviceFilterKeys={serviceFilterKeys}
              reviewServiceKeys={reviewServiceKeys}
              reviewMatchLabel={catalogInsight === "all" ? undefined : portfolioScopeCopy[catalogInsight].match}
              showFullProject={expandedReviewProjects.has(project.id)}
              onToggleFullProject={() => toggleFullProject(project.id)}
              onSelect={setSelectedService}
            />
          ))}
          {!visibleProjects.length ? (
            <div className="empty-state"><strong>Nothing matches this view.</strong><span>Try another location or status, or clear the filters.</span></div>
          ) : null}
        </div>

        <section className="product-story" id="why-devhub">
          <header className="product-story-heading">
            <div>
              <p className="eyebrow">Operational context after deploy</p>
              <h2>The context disappears before the code does.</h2>
            </div>
            <p>A deploy link lands in a chat, a local tool stays on another laptop, and the details drift. DevHub gives every project one reviewed place for what exists, where it runs, what’s current, and what to do next.</p>
          </header>

          <div className="value-grid">
            <article>
              <span>01</span>
              <h3>Find it again</h3>
              <p>Bring applications, APIs, workers, bots, databases, and private tools back into one reviewed catalog.</p>
            </article>
            <article>
              <span>02</span>
              <h3>Know what’s true</h3>
              <p>Live, reported, stale, or unknown. DevHub shows where each state came from instead of pretending everything is green.</p>
            </article>
            <article>
              <span>03</span>
              <h3>Continue safely</h3>
              <p>Open the right entry point, move to the right device, follow reviewed recovery guidance, or hand the exact context back to your agent.</p>
            </article>
            <article>
              <span>04</span>
              <h3>Keep it reviewable</h3>
              <p>Read-only by default. Every change reviewable. DevHub keeps evidence and guidance together without becoming a hidden control plane.</p>
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
            <p className="eyebrow">Agent-assisted catalog update</p>
            <h2>Add or update one project.</h2>
            <p className="registration-lead">Open a coding-agent task beside the project. DevHub reconciles what already exists and returns the smallest reviewable catalog update.</p>
            <div className="agent-clients" aria-label="Supported coding agents"><span>Codex</span><span>Claude Code</span><span>Cursor</span></div>
          </div>
          <ol>
            <li><span>01</span><p><strong>Open the project task</strong><small>Any supported agent task that can inspect the project files and runtime.</small></p></li>
            <li><span>02</span><p><strong>Describe the project</strong><small>Say what appeared or changed. The agent checks the reviewed catalog before proposing anything.</small></p></li>
            <li><span>03</span><p><strong>Review the proposal</strong><small>Your agent shows the minimal catalog diff and validation results for approval.</small></p></li>
          </ol>
          <div className="handoff-card handoff-card-clean" aria-label="Project catalog request for coding agents">
            <header><span>Ready for your coding agent</span><i>One project</i></header>
            <div className="handoff-card-summary">
              <strong>Add or update this project</strong>
              <p>The copied request asks your agent to reconcile the existing record, inspect safe local evidence, and show a reviewed proposal.</p>
              <span>Codex · Claude Code · Cursor</span>
            </div>
            <button onClick={() => void copyRegistrationRequest()}>
              <span><small>Use beside the project</small><strong aria-live="polite">{registrationCopied ? "Copied — paste it into your agent" : registrationCopyFailed ? "Try copying again" : "Copy project request"}</strong></span>
              <i>{registrationCopied ? "✓" : registrationCopyFailed ? "Retry" : "Copy"}</i>
            </button>
            {registrationCopyFailed ? <CopyFallback value={devHubAgentRequest} label="Project request to copy manually" /> : null}
          </div>
        </section>
      </section>

      <footer className="site-footer"><span>DevHub · The home for what you shipped</span><span>Find it again · Know what’s true · Continue safely</span></footer>

      {reviewOpen ? (
        <CatalogReviewHandoff
          scope={catalogInsight}
          presentation={reviewPresentation}
          restoreFocus={restoreReviewFocus}
          onClose={closeReviewHandoff}
        />
      ) : null}

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
