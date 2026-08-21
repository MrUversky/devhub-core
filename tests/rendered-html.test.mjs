import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { buildConnectedSetupAgentPrompt } from "../lib/connectors.mjs";
import { deriveCatalogReviewPresentation } from "../lib/catalog-review-presentation.mjs";
import { buildPortfolioReviewAgentPrompt, buildProjectRegistrationAgentPrompt } from "../lib/agent-handoff-prompts.mjs";

const catalog = JSON.parse(await readFile(new URL("../app/generated/catalog.json", import.meta.url), "utf8"));

function dataModule(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

async function loadDashboardModule() {
  const source = await readFile(new URL("../app/DevHubDashboard.tsx", import.meta.url), "utf8");
  let output = transpileModule(source, {
    compilerOptions: { jsx: JsxEmit.ReactJSX, module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
  }).outputText;
  const catalogModule = dataModule(`
    export const serviceKey = (projectId, serviceId) => \`${"${projectId}"}/${"${serviceId}"}\`;
    export const resolveServiceEndpoint = (service) => service.url
      ? { url: service.url, source: "legacy-url", reason: "Fictional test endpoint." }
      : null;
  `);
  output = output
    .replace(/(["'])react\1/g, JSON.stringify(import.meta.resolve("react")))
    .replace(/(["'])react\/jsx-runtime\1/g, JSON.stringify(import.meta.resolve("react/jsx-runtime")))
    .replace(/(["'])@\/lib\/catalog\1/g, JSON.stringify(catalogModule))
    .replace(/(["'])@\/lib\/connection-status\.mjs\1/g, JSON.stringify(new URL("../lib/connection-status.mjs", import.meta.url).href))
    .replace(/(["'])@\/lib\/connectors\.mjs\1/g, JSON.stringify(new URL("../lib/connectors.mjs", import.meta.url).href))
    .replace(/(["'])@\/lib\/readiness\.mjs\1/g, JSON.stringify(new URL("../lib/readiness.mjs", import.meta.url).href))
    .replace(/(["'])@\/lib\/stewardship\.mjs\1/g, JSON.stringify(new URL("../lib/stewardship.mjs", import.meta.url).href))
    .replace(/(["'])@\/lib\/setup-run-presentation\.mjs\1/g, JSON.stringify(new URL("../lib/setup-run-presentation.mjs", import.meta.url).href))
    .replace(/(["'])@\/lib\/catalog-review-presentation\.mjs\1/g, JSON.stringify(new URL("../lib/catalog-review-presentation.mjs", import.meta.url).href))
    .replace(/(["'])@\/lib\/catalog-service-filters\.mjs\1/g, JSON.stringify(new URL("../lib/catalog-service-filters.mjs", import.meta.url).href))
    .replace(/(["'])@\/lib\/agent-handoff-prompts\.mjs\1/g, JSON.stringify(new URL("../lib/agent-handoff-prompts.mjs", import.meta.url).href))
    .replace(/(["'])@\/lib\/status-bridge\.mjs\1/g, JSON.stringify(new URL("../lib/status-bridge.mjs", import.meta.url).href));
  output += "\nexport { copyText as __testCopyText, CopyFallback as __testCopyFallback };\n";
  return import(dataModule(output));
}

async function loadStatusRouteModule() {
  const source = await readFile(new URL("../app/api/status/route.ts", import.meta.url), "utf8");
  let output = transpileModule(source, {
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
  }).outputText;
  const statusModule = dataModule(`
    export async function getCatalogStatusSnapshot() {
      return { observedAt: "2026-08-20T00:00:00.000Z", statuses: [], freshness: { mode: "cache", newestCheckedAt: null, maxAgeMs: 0 } };
    }
  `);
  output = output
    .replace(/(["'])@\/lib\/status\1/g, JSON.stringify(statusModule))
    .replace(/(["'])@\/lib\/status-bridge\.mjs\1/g, JSON.stringify(new URL("../lib/status-bridge.mjs", import.meta.url).href));
  return import(dataModule(output));
}

async function render(pathname = "/", headers = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${pathname}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: pathname === "/" ? "text/html" : "application/json", ...headers },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the operational catalog", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>DevHub — Never lose track of what your agent shipped\.<\/title>/i);
  assert.match(html, /favicon\.svg/i);
  assert.match(html, /The home for what you shipped/);
  assert.match(html, new RegExp(catalog.instance.label));
  assert.match(html, /<a[^>]+href="#catalog-results"[^>]*>Catalog<\/a>/i);
  assert.match(html, catalog.instance.mode === "demo" ? /Get DevHub/i : /Open my \d+ services/i);
  assert.match(html, /Never lose track of what your agent shipped\./);
  assert.match(html, /Git remembers the code\./);
  assert.match(html, /DevHub remembers how it runs\./);
  assert.match(html, /Your coding agent can build and deploy it\. DevHub keeps the operational context from disappearing—what exists, where it runs, what’s current, and what to do next across your laptops, servers, and clouds\./);
  assert.match(html, /Find it again/);
  assert.match(html, /Know what’s true/);
  assert.match(html, /Continue safely/);
  assert.match(html, /Live, reported, stale, or unknown/);
  assert.match(html, /Read-only by default/);
  assert.match(html, /Every change reviewable/);
  assert.match(html, /Portfolio guardian/i);
  assert.match(html, /The context disappears before the code does/);
  for (const project of catalog.projects.slice(0, 3)) assert.match(html, new RegExp(project.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  if (catalog.instance.mode === "demo") {
    assert.ok(catalog.projects.length >= 6, "the public demo should show a meaningful finished workspace");
    assert.match(html, /href="#install"[^>]*>Get DevHub</i);
    assert.match(html, /href="#demo-workspace"[^>]*>Explore demo</i);
    assert.match(html, /From install to your dashboard in three steps\./i);
    assert.match(html, /Install with your coding agent/i);
    assert.match(html, /Copy install request/i);
    assert.match(html, /Start DevHub/i);
    assert.match(html, /Connect sources/i);
    assert.match(html, /Demo workspace/i);
    assert.match(html, /Project catalog/i);
    assert.match(html, /aria-label="About services with context"/i);
    assert.match(html, /aria-label="About services to review"/i);
    assert.match(html, /aria-label="About ownership questions"/i);
    assert.doesNotMatch(html, /<button class="portfolio-metric-filter"[^>]*aria-describedby=/i);
    assert.match(html, /<button class="portfolio-metric-help"[^>]*aria-label="About services with context"[^>]*aria-expanded="false"[^>]*aria-controls="portfolio-help-passport"[^>]*aria-describedby="portfolio-help-passport"/i);
    assert.match(html, /<button class="portfolio-metric-help"[^>]*aria-label="About services to review"[^>]*aria-expanded="false"[^>]*aria-controls="portfolio-help-evidence-gap"[^>]*aria-describedby="portfolio-help-evidence-gap"/i);
    assert.match(html, /<button class="portfolio-metric-help"[^>]*aria-label="About ownership questions"[^>]*aria-expanded="false"[^>]*aria-controls="portfolio-help-stewardship"[^>]*aria-describedby="portfolio-help-stewardship"/i);
    assert.match(html, /role="tooltip"/i);
    const readableHtml = html.replaceAll("<!-- -->", "");
    assert.match(readableHtml, /services? (?:has|have) App Passport/i);
    assert.match(readableHtml, /services? (?:has|have) evidence gaps/i);
    assert.match(readableHtml, /services? (?:needs|need) ownership review/i);
    assert.doesNotMatch(html, />Show projects</i);
    const dashboardSource = await readFile(new URL("../app/DevHubDashboard.tsx", import.meta.url), "utf8");
    assert.match(dashboardSource, /View full project ·/i, "hidden sibling services should use the explicit full-project path");
    assert.match(html, /Paused/i);
    const scenarioGroup = html.match(/<div class="demo-scenario-buttons"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? "";
    const scenarioButtons = [...scenarioGroup.matchAll(/<button([^>]*)>([^<]+)<\/button>/gi)].map(([, attributes, label]) => ({ attributes, label }));
    assert.deepEqual(scenarioButtons.map(({ label }) => label), ["All examples", "Production", "Needs review", "Discovery", "Paused"]);
    assert.ok(scenarioButtons.every(({ attributes }) => /aria-pressed="(?:true|false)"/i.test(attributes)), "every demo scenario should expose pressed state");
    assert.match(scenarioButtons[0].attributes, /aria-pressed="true"/i);
    for (const scenario of scenarioButtons.slice(1)) assert.match(scenario.attributes, /aria-pressed="false"/i);
    const installStart = html.indexOf('id="install"');
    const connectionsStart = html.indexOf('id="connections"');
    const demoStart = html.indexOf('id="demo-workspace"');
    const demoSummary = html.indexOf('aria-label="Demo workspace summary"');
    const runtimeMap = html.indexOf('aria-label="Runtime locations"');
    const projectCatalog = html.indexOf("Project catalog");
    assert.ok(installStart >= 0 && installStart < connectionsStart && connectionsStart < demoStart, "public journey should render install, setup, then demo workspace");
    assert.ok(demoStart < demoSummary && demoSummary < runtimeMap && runtimeMap < projectCatalog, "workspace totals and runtime hosts should sit beside the demo catalog, not in the hero");
    assert.doesNotMatch(html.slice(0, installStart), /Catalog summary|Demo workspace summary|Runtime locations/i);
    assert.doesNotMatch(html, /\bfictional\b/i);
    assert.doesNotMatch(html, /Interactive sample|Fictional data|nothing here belongs to you|This fictional workspace|Fictional examples|What these signals mean|no magic score/i);
    assert.doesNotMatch(html, /Open release|releases\/download|npm (?:install|i) (?:-g )?devhub|npx devhub/i);
    assert.doesNotMatch(html, /Device context/);
  } else assert.match(html, /Device context/);
  assert.match(html, /aria-label="Runs on"/i);
  assert.match(html, /All locations/i);
  assert.match(html, /aria-label="Service status"/i);
  assert.match(html, /All statuses/i);
  assert.doesNotMatch(html, /Viewing from/);
  assert.match(html, /Device unknown · runs on/);
  assert.match(html, /Agent-assisted catalog update/);
  assert.match(html, /Add or update one project/);
  assert.match(html, /Codex/);
  assert.match(html, /Claude Code/);
  assert.match(html, /Cursor/);
  assert.match(html, /Copy project request/);
  assert.doesNotMatch(html, /devhub-agent-request\.txt|universal|<pre>/i);
  assert.doesNotMatch(html, /npm --prefix/);
  assert.doesNotMatch(html, /react-loading-skeleton|Your site is taking shape/);
});

test("health endpoint is minimal and non-cacheable", async () => {
  const response = await render("/api/health");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("catalog filters exact service rows by runtime host and reported status", async () => {
  const { DevHubDashboard } = await loadDashboardModule();
  const renderDashboard = (props = {}) => renderToStaticMarkup(React.createElement(DevHubDashboard, { catalog, ...props }));
  const host = catalog.hosts.find((candidate) => {
    const matching = catalog.projects.flatMap((project) => project.services).filter((service) => service.host === candidate.id).length;
    return matching > 0 && matching < catalog.projects.flatMap((project) => project.services).length;
  });
  assert.ok(host, "catalog fixture should have a host-specific service subset");

  const expectedHostServices = catalog.projects.flatMap((project) => project.services).filter((service) => service.host === host.id).length;
  const byHost = renderDashboard({ initialHostFilter: host.id });
  assert.equal((byHost.match(/class="service-row(?:\s[^"]*)?"/g) ?? []).length, expectedHostServices);
  assert.match(byHost, new RegExp(`option value="${host.id}" selected="">${host.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"));
  assert.match(byHost, new RegExp(`${expectedHostServices} matching services? in`, "i"));

  const expectedReportedUp = catalog.projects.flatMap((project) => project.services).filter((service) => !service.probe && service.reported?.state === "up").length;
  assert.ok(expectedReportedUp > 0, "catalog fixture should exercise reported-up filtering");
  const byReportedStatus = renderDashboard({ initialStatusFilter: "reported" });
  assert.equal((byReportedStatus.match(/class="service-row(?:\s[^"]*)?"/g) ?? []).length, expectedReportedUp);
  assert.match(byReportedStatus, /option value="reported" selected="">Reported up/i);
});

test("central status bridge UI is explicit about device reachability and bounded backend probes", async () => {
  const { DevHubDashboard } = await loadDashboardModule();
  const privateCatalog = {
    ...catalog,
    instance: { ...catalog.instance, mode: "private", label: "Private DevHub" },
  };
  const html = renderToStaticMarkup(React.createElement(DevHubDashboard, {
    catalog: privateCatalog,
    statusApiEndpoint: "https://central.example.test/api/status",
  }));
  assert.match(html, /Connecting to central LIVE through this device/i);
  assert.match(html, /View updates every 30s/i);
  assert.match(html, /backend probes stay bounded to 5 min, or 15 min for on-demand workstation\/server services/i);

  const source = await readFile(new URL("../app/DevHubDashboard.tsx", import.meta.url), "utf8");
  assert.match(source, /fetch\(statusApiEndpoint, \{ cache: "no-store", credentials: "omit", mode: "cors" \}\)/);
  assert.match(source, /fetch\("\/api\/context", \{ cache: "no-store" \}\)/);
  assert.doesNotMatch(source, /fetch\([^\n]*(?:query|localStorage|searchParams)/i);
});

test("portfolio guardian filters exact service rows and opens a finite agent handoff", async () => {
  const presentation = deriveCatalogReviewPresentation(catalog.projects);
  const { DevHubDashboard } = await loadDashboardModule();
  const renderDashboard = (props = {}) => renderToStaticMarkup(React.createElement(DevHubDashboard, { catalog, ...props }));
  const overview = renderDashboard();
  const passport = presentation.scopes.passport;
  const evidence = presentation.scopes["evidence-gap"];
  const stewardship = presentation.scopes.stewardship;

  assert.match(overview, new RegExp(`${passport.matchingServiceCount}</strong><span>services? (?:has|have) App Passport`, "i"));
  assert.match(overview, new RegExp(`${passport.matchingProjectCount} projects?`, "i"));
  assert.match(overview, new RegExp(`${evidence.matchingServiceCount}</strong><span>services? (?:has|have) evidence gaps`, "i"));
  assert.match(overview, new RegExp(`${evidence.questionItemCount} checks? need evidence`, "i"));
  assert.match(overview, new RegExp(`${stewardship.matchingServiceCount}</strong><span>services? (?:needs|need) ownership review`, "i"));
  assert.match(overview, new RegExp(`${stewardship.matchingProjectCount} projects? · ${stewardship.questionItemCount} ownership items`, "i"));
  assert.match(overview, /Review open items with your agent/i);

  const filtered = renderDashboard({ initialCatalogInsight: "evidence-gap" });
  const renderedServiceRows = filtered.match(/class="service-row(?:\s[^"]*)?"/g) ?? [];
  assert.equal(renderedServiceRows.length, evidence.matchingServiceCount, "active Guardian scope should render matching service rows only");
  assert.match(filtered, new RegExp(`${evidence.matchingServiceCount} matching services? in ${evidence.matchingProjectCount} projects?`, "i"));
  assert.match(filtered, /Needs evidence/i);
  const hasHiddenSibling = catalog.projects.some((project) => {
    const matched = project.services.filter((service) => evidence.serviceKeys.includes(`${project.id}/${service.id}`)).length;
    return matched > 0 && matched < project.services.length;
  });
  if (hasHiddenSibling) assert.match(filtered, /View full project/i);

  const handoff = renderDashboard({ initialCatalogInsight: "stewardship", initialReviewOpen: true });
  assert.match(handoff, /role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="catalog-review-dialog-title"/i);
  assert.match(handoff, /Review this finite scope with your coding agent/i);
  assert.match(handoff, new RegExp(`${stewardship.matchingServiceCount} services?`, "i"));
  assert.match(handoff, new RegExp(`${stewardship.matchingProjectCount} projects? in this review`, "i"));
  assert.match(handoff, new RegExp(`${stewardship.questionItemCount} ownership items`, "i"));
  assert.match(handoff, /Copy review request/i);
  assert.match(handoff, /Codex/i);
  assert.match(handoff, /Claude Code/i);
  assert.match(handoff, /Cursor/i);
  assert.doesNotMatch(handoff, /Use the configured DevHub workflow to review this portfolio|<pre>/i, "review request should stay behind the copy action");
});

test("service panel labels inherited readiness context and preserves explicit overrides", async () => {
  const { ServicePanel } = await loadDashboardModule();
  const project = {
    version: 1,
    id: "inheritance-fixture",
    title: "Inheritance fixture",
    registration: "overlay",
    description: "Fictional presentation fixture.",
    lifecycle: "active",
    kind: "product",
    readinessDefaults: {
      profile: "internal",
      owner: "Inherited project owner",
      dataClassification: "internal",
      costModel: "fixed",
    },
    services: [],
  };
  const baseService = {
    id: "fixture-service",
    name: "Fixture service",
    kind: "worker",
    environment: "production",
    host: "fixture-cloud",
    runtime: "managed",
    mode: "managed",
    visibility: "internal",
  };
  const status = {
    key: "inheritance-fixture/fixture-service",
    state: "registered",
    source: "catalog",
    reason: "catalog-only",
    checkedAt: "",
  };
  const renderPanel = (service) => renderToStaticMarkup(React.createElement(ServicePanel, {
    selection: { project: { ...project, services: [service] }, service },
    status,
    hosts: [{ id: "fixture-cloud", name: "Fixture Cloud", kind: "cloud", location: "cloud" }],
    currentHostId: null,
    onClose() {},
  }));

  const inherited = renderPanel(baseService);
  assert.match(inherited, /profile inherited from project/i);
  assert.match(inherited, /Inherited project owner · inherited from project/i);
  assert.match(inherited, /Project context owner: Inherited project owner \(inherited; not ownership evidence\)/i);
  assert.match(inherited, /No readiness evidence is registered/i);
  assert.doesNotMatch(inherited, /Service owner: Inherited project owner/i);

  const overridden = renderPanel({
    ...baseService,
    readiness: {
      profile: "sensitive",
      owner: "Explicit service owner",
      evidence: [],
    },
  });
  assert.match(overridden, /Sensitive data/i);
  assert.match(overridden, /Explicit service owner/i);
  assert.match(overridden, /Service owner: Explicit service owner/i);
  assert.doesNotMatch(overridden, /profile inherited from project/i);
  assert.doesNotMatch(overridden, /Inherited project owner/i);
});

test("connected setup distinguishes a public preview from private connection state", async () => {
  const { ConnectedSetup } = await loadDashboardModule();
  const renderSetup = (props) => renderToStaticMarkup(React.createElement(ConnectedSetup, props));

  const firstRun = renderSetup({ initialOpen: true, instanceMode: "demo" });
  assert.match(firstRun, /role="dialog"/i);
  assert.match(firstRun, /aria-modal="true"/i);
  assert.match(firstRun, /Connected setup progress/i);
  assert.match(firstRun, /Choose sources/i);
  assert.match(firstRun, /Run with your coding agent/i);
  assert.match(firstRun, /GitHub/i);
  assert.match(firstRun, /This computer/i);
  assert.match(firstRun, /Railway/i);
  assert.match(firstRun, /Available now/i);
  assert.match(firstRun, /Support: Available/i);
  assert.match(firstRun, /Can inspect/i);
  assert.match(firstRun, />Select</i);
  assert.match(firstRun, /Remove GitHub/i);
  assert.match(firstRun, /Remove This computer/i);
  assert.match(firstRun, /Remove Vercel/i);
  assert.match(firstRun, /Remove Railway/i);
  assert.match(firstRun, /Remove OpenAI/i);
  assert.match(firstRun, /Select Sentry/i);
  assert.match(firstRun, /Connector roadmap/i);
  assert.match(firstRun, /View roadmap · 9 planned/i);
  assert.match(firstRun, /5 sources included/i);
  assert.match(firstRun, /Ready to prepare request/i);
  assert.match(firstRun, /Continue with 5 sources/i);
  assert.match(firstRun, /This page prepares the request.*Read-only checks start only after you paste it/i);
  assert.doesNotMatch(firstRun, /type="password"|name="token"|>Detected<|>Connected</i);
  assert.doesNotMatch(firstRun, /ready to check|need your input|Reviewed status|For this setup/i);
  assert.doesNotMatch(firstRun, /Needs setup|No reviewed connection profile|Fictional data|Queued|Running|Review process|Preview review|Continue to handoff|Nothing runs in this dashboard/i);

  const reviewedConnections = renderSetup({
    initialOpen: true,
    instanceMode: "private",
    connectionNow: "2026-08-13T16:00:00.000Z",
    connections: {
      version: 1,
      source: "reviewed-profiles",
      profiles: [
        { connectorId: "github", state: "connected", lastObservedAt: "2026-08-13T15:30:00.000Z", validUntil: "2026-08-13T16:30:00.000Z" },
        { connectorId: "openai", state: "connected", lastObservedAt: "2026-08-13T14:00:00.000Z", validUntil: "2026-08-13T15:00:00.000Z" },
        { connectorId: "cloudflare", state: "connected", lastObservedAt: "2026-08-13T15:30:00.000Z", validUntil: "2026-08-13T16:30:00.000Z" },
      ],
    },
  });
  assert.match(reviewedConnections, /Reviewed status: Last check succeeded/i);
  assert.match(reviewedConnections, /Reviewed status: Check expired/i);
  assert.match(reviewedConnections, /5 sources included/i);
  assert.doesNotMatch(reviewedConnections, /ready to check|need your input|Sign in again|For this setup/i);
  assert.match(reviewedConnections, /Selection/i);
  assert.match(reviewedConnections, />Included</i);
  assert.match(reviewedConnections, /Your sources/i);
  assert.match(reviewedConnections, /Include Sentry in this setup run/i);
  assert.doesNotMatch(reviewedConnections, /Remove Cloudflare from this setup run/i);

  const roadmap = renderSetup({ initialOpen: true, instanceMode: "demo", initialShowRoadmap: true });
  assert.match(roadmap, /Cloudflare/i);
  assert.match(roadmap, /v0\.11/i);
  assert.match(roadmap, /Stripe/i);
  assert.match(roadmap, /v0\.12/i);
  assert.ok(roadmap.indexOf("Neon") < roadmap.indexOf("Stripe"), "v0.11 connectors should precede v0.12");

  const established = renderSetup({ existingCatalog: true, instanceMode: "private" });
  assert.match(established, /Prepare a setup request for your map/i);
  assert.match(established, /Choose what belongs in this setup/i);
  assert.match(established, /Prepare setup request/i);
  assert.doesNotMatch(established, /Connect another source/i);
  assert.doesNotMatch(established, />Refresh my DevHub</i);

  const demoSummary = renderSetup({ existingCatalog: true, instanceMode: "demo" });
  assert.match(demoSummary, /Set up connections in a few clicks/i);
  assert.match(demoSummary, /Start connection setup/i);
  assert.doesNotMatch(demoSummary, /Connect another source/i);

  const handoff = renderSetup({ initialOpen: true, initialStep: 1 });
  assert.match(handoff, /Paste one request.*uses available sign-ins for safe read-only checks/i);
  assert.match(handoff, /One request, then one clear step at a time/i);
  assert.match(handoff, /Paste once/i);
  assert.match(handoff, /Check what is available/i);
  assert.match(handoff, /Review the results/i);
  assert.match(handoff, /Open a fresh Codex task/i);
  assert.match(handoff, /computer with the selected projects or sign-ins/i);
  assert.match(handoff, /DevHub verifies its installed setup workflow before it checks any selected source/i);
  assert.match(handoff, /<details class="setup-agent-details"><summary>Other agents and contributor checkout<\/summary>/i);
  assert.match(handoff, /approved DevHub checkout/i);
  assert.match(handoff, /Claude Code/i);
  assert.match(handoff, /Cursor/i);
  assert.match(handoff, /Copy setup request/i);
  assert.doesNotMatch(handoff, /JSON|schema|reviewId|credential locator|profile ID/i);
  assert.doesNotMatch(handoff, /Queued|Running|Review process|Preview review|Continue to handoff|Ready for your agent|setup complete/i);

  const fiveSourceHandoff = renderSetup({
    initialOpen: true,
    initialStep: 1,
    instanceMode: "private",
    initialSelectedConnectorIds: ["github", "local-host", "vercel", "railway", "openai"],
    connectionNow: "2026-08-13T16:00:00.000Z",
    connections: {
      version: 1,
      source: "reviewed-profiles",
      profiles: [
        { connectorId: "github", state: "connected", lastObservedAt: "2026-08-13T15:30:00.000Z", validUntil: "2026-08-13T16:30:00.000Z" },
        { connectorId: "local-host", state: "connected", lastObservedAt: "2026-08-13T15:30:00.000Z", validUntil: "2026-08-13T16:30:00.000Z" },
        { connectorId: "openai", state: "connected", lastObservedAt: "2026-08-13T15:30:00.000Z", validUntil: "2026-08-13T16:30:00.000Z" },
      ],
    },
  });
  assert.match(fiveSourceHandoff, /Selected source handoff/i);
  assert.match(fiveSourceHandoff, /<strong>GitHub<\/strong>[\s\S]*?This run[\s\S]*?Included[\s\S]*?Future refresh[\s\S]*?Saved/i);
  assert.match(fiveSourceHandoff, /<strong>This computer<\/strong>[\s\S]*?This run[\s\S]*?Included[\s\S]*?Future refresh[\s\S]*?Saved/i);
  assert.match(fiveSourceHandoff, /<strong>Vercel<\/strong>[\s\S]*?This run[\s\S]*?Included[\s\S]*?Future refresh[\s\S]*?Not saved/i);
  assert.match(fiveSourceHandoff, /<strong>Railway<\/strong>[\s\S]*?This run[\s\S]*?Included[\s\S]*?Future refresh[\s\S]*?Not saved/i);
  assert.match(fiveSourceHandoff, /Available sign-ins are checked automatically/i);
  assert.match(fiveSourceHandoff, /asks only if there is more than one account or a new sign-in is needed/i);
  assert.match(fiveSourceHandoff, /saving a connection for future refresh is optional/i);
  assert.doesNotMatch(fiveSourceHandoff, /Ready to check|can start|guided next|Needs your choice|Choose the account to use/i);
  assert.doesNotMatch(fiveSourceHandoff, /Needs exact scope|reviewed binding|Review exact scope|reviewId|credential locator|JSON schema/i);
  assert.doesNotMatch(fiveSourceHandoff, /Checked in this run|runs? the bounded checks now/i);

  const staleSavedHandoff = renderSetup({
    initialOpen: true,
    initialStep: 1,
    instanceMode: "private",
    initialSelectedConnectorIds: ["local-host", "openai"],
    connectionNow: "2026-08-13T16:00:00.000Z",
    connections: {
      version: 1,
      source: "reviewed-profiles",
      profiles: [
        { connectorId: "local-host", state: "connected", lastObservedAt: "2026-08-13T14:00:00.000Z", validUntil: "2026-08-13T15:00:00.000Z" },
        { connectorId: "openai", state: "connected", lastObservedAt: "2026-08-13T14:00:00.000Z", validUntil: "2026-08-13T15:00:00.000Z" },
      ],
    },
  });
  assert.match(staleSavedHandoff, /<strong>This computer<\/strong>[\s\S]*?Future refresh[\s\S]*?Saved · needs recheck/i);
  assert.match(staleSavedHandoff, /<strong>OpenAI<\/strong>[\s\S]*?Future refresh[\s\S]*?Saved · needs recheck/i);
  assert.doesNotMatch(staleSavedHandoff, /Sign in again/i);

  assert.throws(() => renderSetup({ initialSelectedConnectorIds: ["cloudflare"] }), /available canonical source IDs only/i);
  assert.throws(() => renderSetup({ initialSelectedConnectorIds: ["github", "github"] }), /available canonical source IDs only/i);

  const demoHandoff = renderSetup({ initialOpen: true, initialStep: 1, instanceMode: "demo", initialSelectedConnectorIds: ["github", "vercel", "railway"] });
  assert.match(demoHandoff, /GitHub/i);
  assert.match(demoHandoff, /Vercel/i);
  assert.match(demoHandoff, /Railway/i);
  assert.match(demoHandoff, /Selected source handoff/i);
  assert.match(demoHandoff, /Future refresh[\s\S]*?Not saved/i);
  assert.match(demoHandoff, /Available sign-ins are checked automatically/i);
  assert.doesNotMatch(demoHandoff, /Reviewed status|Selected source preflight|Ready for agent check|Needs reviewed binding|Needs exact scope|Review an exact binding|Review exact scope/i);

  const emptyDemoHandoff = renderSetup({ initialOpen: true, initialStep: 1, instanceMode: "demo", initialSelectedConnectorIds: [] });
  assert.match(emptyDemoHandoff, /<button class="setup-primary" disabled="">Copy setup request<\/button>/i);
  assert.doesNotMatch(emptyDemoHandoff, /Copy failed — select and copy|Setup request to copy manually|Copied — paste into your agent/i);
});

test("copy surfaces report success only after a verified shared clipboard operation", async () => {
  const source = await readFile(new URL("../app/DevHubDashboard.tsx", import.meta.url), "utf8");
  assert.equal((source.match(/navigator\.clipboard\.writeText/g) ?? []).length, 1, "only the shared helper may call the Clipboard API");
  const copyHelperSource = source.slice(source.indexOf("async function copyText"), source.indexOf("function CopyFallback"));
  assert.ok(copyHelperSource.indexOf('document.execCommand("copy")') < copyHelperSource.indexOf("navigator.clipboard.writeText"), "activation-sensitive execCommand must run before the first awaited Clipboard API call");
  assert.match(source, /const setupRequest = selectedConnectors\.length\s*\? buildConnectedSetupAgentPrompt\(selectedConnectors\.map\(\(connector\) => connector\.id\)\)\s*: null;/);
  assert.doesNotMatch(source, /guidedConnectionAgentInstructions/);
  assert.match(source, /Copied\. Continue in your coding-agent task\./);
  const setupRequest = buildConnectedSetupAgentPrompt(["github", "local-host", "vercel", "railway", "openai"]);
  assert.ok(setupRequest.length <= 900, `setup clipboard request must stay concise; received ${setupRequest.length} characters`);
  assert.match(setupRequest, /GitHub, This computer, Vercel, Railway, OpenAI/);
  assert.match(setupRequest, /Selection authorizes safe read-only checks through callable plugins, existing sign-ins, and this computer/i);
  assert.match(setupRequest, /Run them before asking how to connect/i);
  assert.match(setupRequest, /With one scope, continue; with several, ask one plain-language choice/i);
  assert.match(setupRequest, /Saving is optional and comes only after results/i);
  assert.match(setupRequest, /Never request or expose secrets, MFA codes, or setup internals/i);
  assert.match(setupRequest, /Do not mutate providers, make hidden catalog changes, merge, or deploy/i);
  assert.doesNotMatch(setupRequest, /--json|setup-run|connection-review|reviewId|questionId|credentialRef|schema|locator|connectionProfileProposals|artifact|preflight|guidedConnection|stdout/i);
  assert.equal((source.match(/startSetup\(1, event\.currentTarget\)/g) ?? []).length, 2, "public and private primary setup actions should open the five-source handoff directly");
  assert.doesNotMatch(source, /startSetup\(0, event\.currentTarget\)/);
  assert.match(source, /const copySetupPrompt = async \(\) => \{\s*if \(!setupRequest\) return;\s*const succeeded = await copyText\(setupRequest\);\s*setCopied\(succeeded \? "setup" : "failed"\)/);
  assert.match(source, /const copy = async \(label: string, value: string\) => \{\s*const succeeded = await copyText\(value\);\s*if \(succeeded\) \{[\s\S]*?setCopied\(label\);[\s\S]*?\} else \{\s*setCopied\(null\);\s*setFailedCopy\(\{ label, value \}\)/);
  assert.match(source, /const copyRegistrationRequest = async \(\) => \{\s*const succeeded = await copyText\(devHubAgentRequest\);\s*setRegistrationCopied\(succeeded\);\s*setRegistrationCopyFailed\(!succeeded\)/);
  assert.match(source, /const copyInstallRequest = async \(\) => \{\s*const succeeded = await copyText\(devHubInstallRequest\);\s*setInstallCopied\(succeeded\);\s*setInstallCopyFailed\(!succeeded\)/);
  assert.match(source, /const copyReviewRequest = async \(\) => \{\s*const succeeded = await copyText\(request\);\s*setCopyState\(succeeded \? "copied" : "failed"\)/);
  assert.equal((source.match(/<CopyFallback\b/g) ?? []).length, 5, "setup, review, service, install, and registration surfaces should expose manual copy fallback");
  assert.doesNotMatch(source, /set(?:Registration|Install)Copied\(true\)/);
  const reviewRequest = buildPortfolioReviewAgentPrompt({ scope: "evidence-gap" });
  const projectRequest = buildProjectRegistrationAgentPrompt();
  assert.match(reviewRequest, /Focus on services with readiness evidence to review/i);
  assert.match(projectRequest, /register or update the project in this task/i);
  assert.doesNotMatch(source, new RegExp(reviewRequest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "review prompt should not be duplicated or rendered as source copy");

  const { __testCopyText: copyText, __testCopyFallback: CopyFallback } = await loadDashboardModule();
  const fallbackHtml = renderToStaticMarkup(React.createElement(CopyFallback, { value: "manual value", label: "Request to copy manually" }));
  assert.match(fallbackHtml, /role="status">Copy failed — select and copy</i);
  assert.match(fallbackHtml, /<textarea[^>]*aria-label="Request to copy manually"[^>]*readonly=""/i);
  assert.doesNotMatch(fallbackHtml, />Copied</i);

  const globalNames = ["navigator", "document", "window", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement"];
  const originalDescriptors = new Map(globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const setGlobal = (name, value) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

  const events = [];
  class FakeHTMLElement {
    isConnected = true;
    focus() { events.push("focus-active"); }
  }
  class FakeHTMLInputElement extends FakeHTMLElement {
    selectionStart = 2;
    selectionEnd = 5;
    selectionDirection = "forward";
    setSelectionRange(start, end, direction) { events.push(`restore-control:${start}:${end}:${direction}`); }
  }
  class FakeHTMLTextAreaElement extends FakeHTMLElement {
    style = {};
    removed = false;
    readOnly = false;
    tabIndex = 0;
    setAttribute(name, value) { events.push(`attribute:${name}:${value}`); }
    focus() { events.push("focus-fallback"); }
    select() { events.push("select-fallback"); }
    setSelectionRange(start, end) { events.push(`select-range:${start}:${end}`); }
    remove() { this.removed = true; events.push("remove-fallback"); }
  }

  let nativeMode = "reject";
  let execMode = "success";
  let activeElement = new FakeHTMLInputElement();
  let nativeCalls = 0;
  let execCalls = 0;
  const textareas = [];
  const selection = {
    rangeCount: 1,
    getRangeAt: () => ({ cloneRange: () => ({ id: "saved-range" }) }),
    removeAllRanges: () => events.push("clear-ranges"),
    addRange: () => events.push("restore-range"),
  };
  const fakeDocument = {
    body: { appendChild: (node) => { textareas.push(node); events.push("append-fallback"); } },
    get activeElement() { return activeElement; },
    createElement: () => new FakeHTMLTextAreaElement(),
    getSelection: () => selection,
    execCommand: () => {
      execCalls += 1;
      if (execMode === "throw") throw new Error("blocked");
      return execMode === "success";
    },
  };
  const fakeWindow = { scrollX: 12, scrollY: 34, scrollTo: (x, y) => events.push(`scroll:${x}:${y}`) };
  const fakeNavigator = { clipboard: { writeText: () => {
    nativeCalls += 1;
    return Promise.resolve().then(() => {
      if (nativeMode === "reject") throw new Error("denied");
    });
  } } };

  try {
    setGlobal("HTMLElement", FakeHTMLElement);
    setGlobal("HTMLInputElement", FakeHTMLInputElement);
    setGlobal("HTMLTextAreaElement", FakeHTMLTextAreaElement);
    setGlobal("document", fakeDocument);
    setGlobal("window", fakeWindow);
    setGlobal("navigator", fakeNavigator);

    assert.equal(await copyText("activation-safe"), true);
    assert.equal(execCalls, 1);
    assert.equal(nativeCalls, 0, "a synchronous fallback success must not start a later Clipboard API request");
    assert.equal(textareas.at(-1).removed, true);
    assert.ok(events.includes("focus-active"));
    assert.ok(events.includes("restore-control:2:5:forward"));
    assert.ok(events.includes("scroll:12:34"));

    activeElement = new FakeHTMLElement();
    assert.equal(await copyText("activation-safe again"), true, "repeated copy attempts should remain usable");
    assert.equal(execCalls, 2);
    assert.equal(nativeCalls, 0);
    assert.equal(textareas.at(-1).removed, true);
    assert.ok(events.includes("clear-ranges"));
    assert.ok(events.includes("restore-range"));

    execMode = "false";
    nativeMode = "success";
    assert.equal(await copyText("native success"), true, "native Clipboard API success should be accepted after a false synchronous attempt");
    assert.equal(execCalls, 3);
    assert.equal(nativeCalls, 1);
    assert.equal(textareas.at(-1).removed, true);

    execMode = "throw";
    nativeMode = "reject";
    assert.equal(await copyText("manual"), false, "synchronous and asynchronous failure must not report Copied");
    assert.equal(execCalls, 4);
    assert.equal(nativeCalls, 2);
    assert.equal(textareas.at(-1).removed, true, "fallback textarea must be removed even when execCommand throws");
    assert.equal(textareas.every((textarea) => textarea.removed), true);
  } finally {
    for (const name of globalNames) {
      const descriptor = originalDescriptors.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

test("connected setup controls keep mobile-sized touch targets", async () => {
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(styles, /\.setup-primary,\s*\.setup-secondary\s*\{[^}]*min-height:\s*44px;/s);
  assert.match(styles, /\.setup-text-button\s*\{[^}]*min-height:\s*44px;/s);
  assert.match(styles, /\.setup-action-bar > \.setup-text-button\s*\{[^}]*min-width:\s*44px;/s);
  assert.match(styles, /\.setup-close\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px;/s);
  assert.match(styles, /\.portfolio-metric-help\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px;/s);
  assert.match(styles, /\.portfolio-review-agent\s*\{[^}]*min-height:\s*44px;/s);
  assert.match(styles, /\.project-review-expand\s*\{[^}]*min-height:\s*44px;/s);
});

test("connected setup declares modal focus management and restores its trigger", async () => {
  const source = await readFile(new URL("../app/DevHubDashboard.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /setupStageHeadingRef\.current\?\.focus/);
  assert.match(source, /event\.key !== "Tab"/);
  assert.match(source, /event\.shiftKey/);
  assert.match(source, /sibling\.inert = true/);
  assert.match(source, /trigger\?\.focus/);
  assert.match(source, /restoreReviewFocus/);
  assert.match(source, /returnFocus\?\.focus|window\.requestAnimationFrame\(restoreFocus\)/);
  assert.match(source, /aria-labelledby="catalog-review-dialog-title"/);
  assert.match(source, /<footer className="setup-action-bar">/);
  assert.match(source, /<div className="setup-dialog-scroll"[\s\S]*<\/div>\s*\n\s*<footer className="setup-action-bar">/);
  const portfolioStart = source.indexOf('<div className="portfolio-metrics"');
  const portfolioEnd = source.indexOf("</section>", portfolioStart);
  assert.ok(portfolioStart >= 0 && portfolioEnd > portfolioStart, "portfolio metric source should be present");
  const portfolioSource = source.slice(portfolioStart, portfolioEnd);
  assert.match(portfolioSource, /event\.key === "Escape"[\s\S]*setOpenMetricHelp\(null\)/);
  assert.doesNotMatch(portfolioSource, /\.blur\(\)/, "Escape dismissal should not move focus away from the help button");
  const scenarioCssStart = css.indexOf(".demo-scenario-buttons");
  const scenarioCssEnd = css.indexOf(".demo-workspace-summary", scenarioCssStart);
  assert.ok(scenarioCssStart >= 0 && scenarioCssEnd > scenarioCssStart, "demo scenario styles should be present");
  assert.doesNotMatch(css.slice(scenarioCssStart, scenarioCssEnd), /:first-child/, "the active scenario style must follow pressed state, not button position");
});

test("detects a reviewed Tailscale device without exposing identity headers", async () => {
  const reviewedHost = catalog.hosts.find((host) => host.tailscaleIPv4);
  const response = await render("/api/context", {
    "x-forwarded-for": reviewedHost?.tailscaleIPv4 ?? "203.0.113.10",
    "tailscale-user-login": "viewer@example.test",
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);

  const context = await response.json();
  assert.deepEqual(context, {
    runtimeHostId: "unknown",
    detectedHostId: reviewedHost?.id ?? null,
    source: reviewedHost ? "tailscale" : "unknown",
  });
  assert.equal(JSON.stringify(context).includes("viewer@example.test"), false);
});

test("does not present an unreviewed runtime host as the current device", async () => {
  const response = await render("/api/context");
  assert.equal(response.status, 200);

  assert.deepEqual(await response.json(), {
    runtimeHostId: "unknown",
    detectedHostId: null,
    source: "local",
  });
});

test("keeps live, reported, and undated status evidence distinct", async () => {
  const response = await render("/api/status");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  const result = await response.json();

  assert.equal(result.freshness.mode, "refresh");
  assert.equal(result.freshness.ordinaryIntervalMs, 300_000);
  assert.equal(result.freshness.onDemandIntervalMs, 900_000);
  assert.equal(result.freshness.maxConcurrency, 4);
  assert.match(result.freshness.nextRefreshAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(result.statuses.every((status) => status.freshness === "fresh"));
  assert.ok(result.statuses.every((status) => Number.isFinite(status.ageMs) && status.ageMs >= 0));
  assert.ok(result.statuses.every((status) => /^\d{4}-\d{2}-\d{2}T/.test(status.refreshAfter)));

  const reported = result.statuses.find((status) => status.source === "reported");
  assert.ok(reported);
  assert.equal(reported.source, "reported");
  assert.equal(reported.reason, "reported");
  assert.match(reported.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
  const dated = result.statuses.find((status) => status.source === "reported" && status.observedAt);
  if (dated) assert.match(dated.observedAt, /^\d{4}-\d{2}-\d{2}T/);
  const undated = result.statuses.find((status) => status.source === "reported" && !status.observedAt);
  if (undated) assert.equal(Object.hasOwn(undated, "observedAt"), false);

  const probes = result.statuses.filter((status) => status.source === "probe");
  if (probes.length) {
    assert.ok(probes.every((status) => status.observedAt === status.checkedAt));
    assert.ok(probes.every((status) => ["live-probe", "probe-timeout", "probe-failed"].includes(status.reason)));
  }

  const cachedResponse = await render("/api/status");
  assert.equal(cachedResponse.status, 200);
  const cached = await cachedResponse.json();
  assert.equal(cached.freshness.mode, "cache");
  assert.equal(cached.freshness.cacheHits, result.statuses.length);
  assert.deepEqual(cached.statuses.map((status) => status.checkedAt), result.statuses.map((status) => status.checkedAt));
  assert.ok(cached.statuses.every((status, index) => status.ageMs >= result.statuses[index].ageMs));
});

test("status route exposes snapshots only to exact configured CORS origins", async () => {
  const previous = process.env.DEVHUB_STATUS_CORS_ORIGINS;
  process.env.DEVHUB_STATUS_CORS_ORIGINS = "https://owner.example.test";
  try {
    const { GET, OPTIONS } = await loadStatusRouteModule();
    const allowed = await GET(new Request("https://central.example.test/api/status", {
      headers: { origin: "https://owner.example.test" },
    }));
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://owner.example.test");
    assert.equal(allowed.headers.get("access-control-allow-credentials"), null);
    assert.match(allowed.headers.get("vary") ?? "", /Origin/);

    const sameOrigin = await GET(new Request("https://central.example.test/api/status", {
      headers: { origin: "https://central.example.test" },
    }));
    assert.equal(sameOrigin.status, 200);
    assert.equal(sameOrigin.headers.get("access-control-allow-origin"), null);

    const denied = await GET(new Request("https://central.example.test/api/status", {
      headers: { origin: "https://attacker.example.test" },
    }));
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get("access-control-allow-origin"), null);

    const sameOriginOptions = await OPTIONS(new Request("https://central.example.test/api/status", {
      method: "OPTIONS",
    }));
    assert.equal(sameOriginOptions.status, 204);
    assert.equal(sameOriginOptions.headers.get("allow"), "GET, HEAD, OPTIONS");

    const preflight = await OPTIONS(new Request("https://central.example.test/api/status", {
      method: "OPTIONS",
      headers: {
        origin: "https://owner.example.test",
        "access-control-request-method": "GET",
      },
    }));
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "https://owner.example.test");
    assert.equal(preflight.headers.get("access-control-allow-methods"), "GET");
  } finally {
    if (previous === undefined) delete process.env.DEVHUB_STATUS_CORS_ORIGINS;
    else process.env.DEVHUB_STATUS_CORS_ORIGINS = previous;
  }
});
