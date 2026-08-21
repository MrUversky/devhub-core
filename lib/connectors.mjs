export const CONNECTOR_CAPABILITIES = Object.freeze([
  "repositories",
  "inventory",
  "runtimes",
  "deployments",
  "environments",
  "domains",
  "data",
  "monitoring",
  "ownership",
  "costs",
  "key-metadata",
  "recovery",
]);

const freezeItems = (items) => Object.freeze(items.map((item) => Object.freeze({ ...item })));
const connectorStages = new Set(["available", "planned"]);
const connectorCategories = new Set(["source", "runtime", "deployment", "infrastructure", "data", "observability", "ai", "business", "builder"]);
const connectorAuthMethods = new Set(["anonymous", "github-app", "oauth", "cli-session", "local-session", "secret-reference", "cloud-iam"]);
const safeCommand = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function safeMarker(value) {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.startsWith("~/")) return false;
  const parts = value.replaceAll("\\", "/").split("/");
  return parts.every((part) => part && part !== "." && part !== "..") && !/(?:token|secret|credential|password|private[-_.]?key|\.env)/i.test(value);
}

export const CONNECTED_SETUP = Object.freeze({
  title: "Set up my DevHub",
  description: "Prepare one read-only request for your coding agent to find what you build, where it runs, and what still needs review.",
});

export const CONNECTED_SETUP_ENTRY_POINTS = freezeItems([
  { id: "setup-my-devhub", label: "Set up my DevHub", prompt: "Set up my DevHub and build a reviewed map of everything I can safely discover." },
  { id: "connect-my-tools", label: "Connect my tools", prompt: "Connect the tools DevHub can use without collecting secret values." },
  { id: "build-my-map", label: "Build my map", prompt: "Build my DevHub map from reviewed local and provider evidence, then ask only what remains unclear." },
  { id: "refresh-my-devhub", label: "Refresh my DevHub", prompt: "Refresh my DevHub, show what changed, and prepare only reviewable proposals." },
]);

export const CONNECTED_SETUP_STEPS = freezeItems([
  { id: "choose-sources", title: "Choose sources", description: "Choose which sources the agent may check read-only. Nothing runs on this page." },
  { id: "run-with-agent", title: "Run with your coding agent", description: "Copy one bounded request into Codex, Claude Code or Cursor. The agent starts with safe checks and asks only when needed." },
]);

export const CONNECTED_SETUP_RUN_STAGES = freezeItems([
  { id: "connect-tools", title: "Connect tools", description: "Use supported authorization or an existing local session without putting credentials in the catalog." },
  { id: "build-my-map", title: "Build my map", description: "Discover bounded resources and propose projects, services, environments and ownership links." },
  { id: "review-unclear", title: "Review only what is unclear", description: "Confirm ambiguous matches, owners, payers and resources that may no longer be used." },
  { id: "done", title: "Handoff ready", description: "Prepare one reviewed catalog update; it becomes current only after validation and merge." },
]);

export const CONNECTED_SETUP_NEXT_ACTIONS = freezeItems([
  { id: "refresh-my-devhub", label: "Refresh my DevHub", prompt: "Refresh my DevHub and show only new, changed, stale or unclear resources." },
  { id: "connect-another-source", label: "Connect another source", prompt: "Connect another account, provider or computer to my DevHub without exposing secret values." },
]);

export function buildConnectedSetupAgentPrompt(connectorIds) {
  if (!Array.isArray(connectorIds) || connectorIds.length === 0) {
    throw new TypeError("Connected Setup requires at least one selected source");
  }
  const requested = new Set(connectorIds);
  if (requested.size !== connectorIds.length || connectorIds.some((id) => typeof id !== "string")) {
    throw new TypeError("Connected Setup source IDs must be unique strings");
  }
  const selected = CONNECTOR_CATALOG.filter((item) => requested.has(item.id));
  if (selected.length !== requested.size || selected.some((item) => item.stage !== "available")) {
    throw new TypeError("Connected Setup accepts only available canonical sources");
  }
  const localInstruction = requested.has("local-host")
    ? " Run this task on the computer you want DevHub to inspect."
    : "";
  const sources = selected.map((item) => item.name).join(", ");
  return `Use the configured DevHub workflow to prepare a reviewed Connected Setup update for these selected sources: ${sources}.

Selection authorizes safe read-only checks through callable plugins, existing sign-ins, and this computer. Run them before asking how to connect. Stay within the selected sources and scopes. Report a recognizable scope and item count. With one scope, continue; with several, ask one plain-language choice. Saving is optional and comes only after results. Never request or expose secrets, MFA codes, or setup internals.${localInstruction}

Present the minimal reviewed connection-profile and catalog diff, or a draft pull request, with validation results. Do not mutate providers, make hidden catalog changes, merge, or deploy. The dashboard changes only after the reviewed change is merged and deployed.`;
}

const connector = (value) => Object.freeze({
  ...value,
  ...(value.roadmap ? { roadmap: Object.freeze({ ...value.roadmap }) } : {}),
  capabilities: Object.freeze([...value.capabilities]),
  auth: Object.freeze([...value.auth]),
  detection: Object.freeze({
    commands: Object.freeze([...(value.detection?.commands ?? [])]),
    markers: Object.freeze([...(value.detection?.markers ?? [])]),
  }),
});

export const CONNECTOR_CATALOG = Object.freeze([
  connector({
    id: "github",
    name: "GitHub",
    priority: 1,
    category: "source",
    stage: "available",
    summary: "Repositories, owners, Actions, releases and deployment evidence.",
    capabilities: ["repositories", "deployments", "monitoring", "ownership"],
    auth: ["secret-reference", "github-app", "cli-session", "anonymous"],
    detection: { commands: ["gh"], markers: [".git/config"] },
  }),
  connector({
    id: "local-host",
    name: "This computer",
    priority: 2,
    category: "runtime",
    stage: "available",
    summary: "Reviewed workspaces, local runtimes and recovery guidance on this device.",
    capabilities: ["inventory", "runtimes", "deployments", "monitoring", "recovery"],
    auth: ["local-session"],
    detection: { commands: ["docker", "tailscale", "launchctl", "systemctl"], markers: ["package.json", "compose.yaml", "docker-compose.yml"] },
  }),
  connector({
    id: "vercel",
    name: "Vercel",
    priority: 3,
    category: "deployment",
    stage: "available",
    summary: "Projects, preview and production deployments, environments and domains.",
    capabilities: ["inventory", "deployments", "environments", "domains"],
    auth: ["secret-reference", "oauth", "cli-session"],
    detection: { commands: ["vercel"], markers: [".vercel/project.json"] },
  }),
  connector({
    id: "railway",
    name: "Railway",
    priority: 4,
    category: "deployment",
    stage: "available",
    summary: "Workspaces, projects, environments, services, deployments and domains.",
    capabilities: ["inventory", "runtimes", "deployments", "environments", "domains", "ownership", "costs"],
    auth: ["secret-reference"],
    detection: { commands: ["railway"], markers: ["railway.json", "railway.toml"] },
  }),
  connector({
    id: "cloudflare",
    name: "Cloudflare",
    priority: 5,
    category: "infrastructure",
    stage: "planned",
    roadmap: { milestone: "v0.11", theme: "Deployment and data connectors" },
    summary: "Accounts, Workers, Pages, DNS, domains, storage and Access boundaries.",
    capabilities: ["inventory", "runtimes", "deployments", "environments", "domains", "data", "ownership", "costs"],
    auth: ["oauth", "cli-session"],
    detection: { commands: ["wrangler"], markers: ["wrangler.json", "wrangler.jsonc", "wrangler.toml"] },
  }),
  connector({
    id: "supabase",
    name: "Supabase",
    priority: 6,
    category: "data",
    stage: "planned",
    roadmap: { milestone: "v0.11", theme: "Deployment and data connectors" },
    summary: "Organizations, projects, databases, Auth, Storage and Functions.",
    capabilities: ["inventory", "runtimes", "environments", "data", "ownership", "costs", "recovery"],
    auth: ["oauth", "cli-session"],
    detection: { commands: ["supabase"], markers: ["supabase/config.toml"] },
  }),
  connector({
    id: "sentry",
    name: "Sentry",
    priority: 7,
    category: "observability",
    stage: "available",
    summary: "Exact project monitoring and deployment-linked release evidence.",
    capabilities: ["deployments", "monitoring"],
    auth: ["oauth", "secret-reference", "cli-session"],
    detection: { commands: ["sentry-cli"], markers: [".sentryclirc", "sentry.properties"] },
  }),
  connector({
    id: "openai",
    name: "OpenAI",
    priority: 8,
    category: "ai",
    stage: "available",
    summary: "Exact organization/project identity, usage, cost and redacted key metadata through a reviewed Admin credential reference.",
    capabilities: ["inventory", "ownership", "costs", "key-metadata"],
    auth: ["secret-reference"],
    detection: { commands: [], markers: [] },
  }),
  connector({
    id: "render",
    name: "Render",
    priority: 9,
    category: "deployment",
    stage: "planned",
    roadmap: { milestone: "v0.11", theme: "Deployment and data connectors" },
    summary: "Workspaces, services, workers, databases and deploys.",
    capabilities: ["inventory", "runtimes", "deployments", "environments", "domains", "data", "ownership", "costs"],
    auth: ["secret-reference"],
    detection: { commands: [], markers: ["render.yaml"] },
  }),
  connector({
    id: "netlify",
    name: "Netlify",
    priority: 10,
    category: "deployment",
    stage: "planned",
    roadmap: { milestone: "v0.11", theme: "Deployment and data connectors" },
    summary: "Teams, sites, deploys, domains and serverless functions.",
    capabilities: ["inventory", "runtimes", "deployments", "environments", "domains", "ownership", "costs"],
    auth: ["oauth", "cli-session"],
    detection: { commands: ["netlify"], markers: ["netlify.toml", ".netlify/state.json"] },
  }),
  connector({
    id: "stripe",
    name: "Stripe",
    priority: 11,
    category: "business",
    stage: "planned",
    roadmap: { milestone: "v0.12", theme: "Cloud and business context" },
    summary: "Account ownership, test and live modes, webhooks, balances and billing responsibility.",
    capabilities: ["inventory", "environments", "monitoring", "ownership", "costs", "key-metadata"],
    auth: ["secret-reference", "cli-session"],
    detection: { commands: ["stripe"], markers: [] },
  }),
  connector({
    id: "neon",
    name: "Neon",
    priority: 12,
    category: "data",
    stage: "planned",
    roadmap: { milestone: "v0.11", theme: "Deployment and data connectors" },
    summary: "Organizations, projects, branches, databases, regions and usage.",
    capabilities: ["inventory", "environments", "data", "ownership", "costs", "recovery"],
    auth: ["oauth", "secret-reference", "cli-session"],
    detection: { commands: ["neonctl"], markers: [] },
  }),
  connector({
    id: "google-cloud",
    name: "Google Cloud + Firebase",
    priority: 13,
    category: "infrastructure",
    stage: "planned",
    roadmap: { milestone: "v0.12", theme: "Cloud and business context" },
    summary: "Projects, Cloud Run, Functions, Firebase Hosting and billing accounts.",
    capabilities: ["inventory", "runtimes", "deployments", "environments", "domains", "data", "ownership", "costs"],
    auth: ["oauth", "cloud-iam", "cli-session"],
    detection: { commands: ["gcloud", "firebase"], markers: ["firebase.json", ".firebaserc"] },
  }),
  connector({
    id: "aws",
    name: "AWS",
    priority: 14,
    category: "infrastructure",
    stage: "planned",
    roadmap: { milestone: "v0.12", theme: "Cloud and business context" },
    summary: "Accounts, Lambda, ECS, Amplify, RDS, S3, CloudFront and spend context.",
    capabilities: ["inventory", "runtimes", "deployments", "environments", "domains", "data", "monitoring", "ownership", "costs", "recovery"],
    auth: ["cloud-iam", "cli-session"],
    detection: { commands: ["aws"], markers: ["template.yaml", "serverless.yml"] },
  }),
  connector({
    id: "replit",
    name: "Replit",
    priority: 15,
    category: "builder",
    stage: "planned",
    roadmap: { milestone: "v0.11", theme: "Deployment and data connectors" },
    summary: "Builder-hosted apps, deployments and resources that may have no local checkout.",
    capabilities: ["inventory", "runtimes", "deployments", "environments", "domains", "data", "ownership", "costs"],
    auth: ["oauth", "secret-reference"],
    detection: { commands: [], markers: [".replit", "replit.nix"] },
  }),
]);

export function getConnector(id) {
  return CONNECTOR_CATALOG.find((item) => item.id === id) ?? null;
}

export function listConnectors() {
  return CONNECTOR_CATALOG;
}

export function recommendedConnectors(limit = 6) {
  if (!Number.isInteger(limit) || limit < 0) throw new TypeError("connector recommendation limit must be a non-negative integer");
  return CONNECTOR_CATALOG.filter((item) => item.stage === "available").slice(0, limit);
}

export function validateConnectorCatalog(connectors = CONNECTOR_CATALOG) {
  const ids = new Set();
  const priorities = new Set();
  for (const item of connectors) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id)) throw new Error(`invalid connector id: ${item.id}`);
    if (ids.has(item.id)) throw new Error(`duplicate connector id: ${item.id}`);
    if (priorities.has(item.priority)) throw new Error(`duplicate connector priority: ${item.priority}`);
    if (!item.name || !item.summary) throw new Error(`connector ${item.id} needs a name and summary`);
    if (!connectorStages.has(item.stage)) throw new Error(`connector ${item.id} has an invalid stage`);
    if (item.stage === "planned") {
      if (!item.roadmap || !/^v\d+\.\d+$/.test(item.roadmap.milestone) || typeof item.roadmap.theme !== "string" || !item.roadmap.theme.trim() || item.roadmap.theme.length > 100) {
        throw new Error(`planned connector ${item.id} needs a valid roadmap milestone and theme`);
      }
    } else if (item.roadmap !== undefined) {
      throw new Error(`available connector ${item.id} cannot declare a future roadmap milestone`);
    }
    if (!connectorCategories.has(item.category)) throw new Error(`connector ${item.id} has an invalid category`);
    if (!item.capabilities.length) throw new Error(`connector ${item.id} needs capabilities`);
    if (item.capabilities.some((capability) => !CONNECTOR_CAPABILITIES.includes(capability))) {
      throw new Error(`connector ${item.id} has an unknown capability`);
    }
    if (!item.auth.length || item.auth.some((method) => !connectorAuthMethods.has(method))) {
      throw new Error(`connector ${item.id} has an invalid authorization method`);
    }
    if (item.detection.commands.some((command) => !safeCommand.test(command))) {
      throw new Error(`connector ${item.id} has an unsafe command marker`);
    }
    if (item.detection.markers.some((marker) => !safeMarker(marker))) {
      throw new Error(`connector ${item.id} has an unsafe filesystem marker`);
    }
    ids.add(item.id);
    priorities.add(item.priority);
  }
  const ordered = [...connectors].sort((left, right) => left.priority - right.priority);
  if (ordered.some((item, index) => item !== connectors[index])) throw new Error("connector catalog must be sorted by priority");
  return true;
}

validateConnectorCatalog();
