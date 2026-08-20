const clients = new Set(["codex", "claude-code", "cursor"]);
const authModes = new Set(["network", "bearer"]);
const scopes = {
  codex: new Set(["user"]),
  "claude-code": new Set(["user", "project", "local"]),
  cursor: new Set(["user", "project"]),
};

const sharedWorkflow = `## DevHub workflow

When the user asks to find, understand, register, sync, recover, or review a project or service:

1. For “set up my DevHub”, “connect everything I can access”, “Build my map”, or “refresh my DevHub”, start with \`devhub setup --json\`. It detects only local CLI and config markers; never treat detection as authorization, account access, or a catalog fact.
2. Use the configured read-only DevHub MCP tools to search for an existing project and service before proposing a new record.
3. Inspect only the current workspace and explicitly reviewed runtime evidence. Do not scan arbitrary ports, accounts, or networks.
4. Keep project-owned native manifests separate from private DevHub overlays. Never modify a shared or external repository to add private operational metadata.
5. Treat missing or stale evidence as unknown. Never claim a service is monitored, secure, recoverable, or inexpensive without reviewed evidence.
6. Never put tokens, passwords, cookies, connection strings, private keys, or credential-bearing URLs in DevHub manifests, prompts, logs, or Git.
7. MCP is read-only. Connected setup is also read-only. Prepare a minimal catalog diff through the DevHub CLI or registry checkout, validate it, and wait for explicit review before apply, commit, publish, restart, rollback, or any production action.
8. Finish by explaining what is known, what remains unknown, and the next safe action.
`;

export class AgentSetupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AgentSetupError";
    this.code = code;
  }
}

function optionValue(args, name) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument.startsWith(`${name}=`)) return argument.slice(name.length + 1);
    if (argument === name) return args[index + 1];
  }
  return null;
}

function validateEndpoint(value) {
  if (!value) throw new AgentSetupError("endpoint-required", "agent-setup needs --url <DevHub MCP URL>");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new AgentSetupError("endpoint-invalid", "--url must be a valid absolute HTTP(S) URL");
  }
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new AgentSetupError("endpoint-insecure", "--url must use HTTPS, except for loopback development");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new AgentSetupError("endpoint-sensitive", "--url cannot contain credentials, query parameters, or fragments");
  }
  if (parsed.pathname !== "/mcp") {
    throw new AgentSetupError("endpoint-path", "--url must point to the DevHub /mcp endpoint");
  }
  return parsed.toString().replace(/\/$/, "");
}

function validateTokenEnvironment(value) {
  if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(value)) {
    throw new AgentSetupError("token-env-invalid", "--token-env must be an uppercase environment variable name");
  }
  return value;
}

function mcpEntry(client, endpoint, auth, tokenEnvironment) {
  const entry = client === "claude-code" ? { type: "http", url: endpoint } : { url: endpoint };
  if (auth === "bearer") {
    entry.headers = {
      Authorization: client === "cursor"
        ? `Bearer \${env:${tokenEnvironment}}`
        : `Bearer \${${tokenEnvironment}}`,
    };
  }
  return entry;
}

function prettyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function codexPlan(endpoint, auth, tokenEnvironment) {
  const command = auth === "bearer"
    ? `codex mcp add devhub --url ${endpoint} --bearer-token-env-var ${tokenEnvironment}`
    : `codex mcp add devhub --url ${endpoint}`;
  return {
    files: [],
    commands: [command, "codex mcp list", "codex mcp get devhub --json"],
    instruction: "Install the portable DevHub plugin for the full workflow; its MCP connection remains instance-specific and read-only.",
  };
}

function claudePlan(endpoint, auth, tokenEnvironment, scope) {
  const entry = mcpEntry("claude-code", endpoint, auth, tokenEnvironment);
  const command = auth === "network"
    ? `claude mcp add --transport http --scope ${scope} devhub ${endpoint}`
    : `claude mcp add-json devhub '${JSON.stringify(entry)}' --scope ${scope}`;
  return {
    files: scope === "project" ? [{
      path: ".mcp.json",
      merge: true,
      content: prettyJson({ mcpServers: { devhub: entry } }),
    }] : [],
    commands: [command, "claude mcp list"],
    instruction: {
      path: scope === "user" ? "~/.claude/CLAUDE.md" : "CLAUDE.md",
      merge: true,
      content: sharedWorkflow,
    },
  };
}

function cursorPlan(endpoint, auth, tokenEnvironment, scope) {
  const configPath = scope === "user" ? "~/.cursor/mcp.json" : ".cursor/mcp.json";
  const rulePath = scope === "user" ? "Cursor Settings → Rules → User Rules" : ".cursor/rules/devhub.mdc";
  const rule = `---
description: Use DevHub's reviewed operational context when a project or service must be found, synced, understood, or recovered.
alwaysApply: false
---

${sharedWorkflow}`;
  return {
    files: [{
      path: configPath,
      merge: true,
      content: prettyJson({ mcpServers: { devhub: mcpEntry("cursor", endpoint, auth, tokenEnvironment) } }),
    }],
    commands: ["cursor-agent mcp list", "cursor-agent mcp list-tools devhub"],
    instruction: {
      path: rulePath,
      merge: true,
      content: rule,
    },
  };
}

export function createAgentSetup(args) {
  const client = args.find((argument) => !argument.startsWith("--") && ![optionValue(args, "--url"), optionValue(args, "--auth"), optionValue(args, "--token-env"), optionValue(args, "--scope")].includes(argument));
  if (!clients.has(client)) {
    throw new AgentSetupError("client-invalid", "agent-setup client must be codex, claude-code, or cursor");
  }
  const endpoint = validateEndpoint(optionValue(args, "--url"));
  const auth = optionValue(args, "--auth") ?? "network";
  if (!authModes.has(auth)) throw new AgentSetupError("auth-invalid", "--auth must be network or bearer");
  const scope = optionValue(args, "--scope") ?? "user";
  if (!scopes[client].has(scope)) {
    throw new AgentSetupError("scope-invalid", `--scope ${scope} is not supported for ${client}`);
  }
  const tokenEnvironment = validateTokenEnvironment(optionValue(args, "--token-env") ?? "DEVHUB_MCP_TOKEN");
  const clientPlan = client === "codex"
    ? codexPlan(endpoint, auth, tokenEnvironment)
    : client === "claude-code"
      ? claudePlan(endpoint, auth, tokenEnvironment, scope)
      : cursorPlan(endpoint, auth, tokenEnvironment, scope);

  return {
    version: 1,
    command: "agent-setup",
    readOnly: true,
    client,
    scope,
    auth,
    endpoint,
    secretHandling: auth === "bearer"
      ? `Set ${tokenEnvironment} only in the environment or secret manager that launches ${client}; never commit its value.`
      : "No application credential is configured; keep the endpoint behind a reviewed private-network boundary.",
    ...clientPlan,
    verifyPrompt: "Use DevHub to find this project, explain what is current, and tell me the next safe action. Do not change anything.",
  };
}

export function formatAgentSetup(setup) {
  const lines = [
    `DevHub agent setup: ${setup.client} (${setup.scope}, ${setup.auth})`,
    `Endpoint: ${setup.endpoint}`,
    setup.secretHandling,
  ];
  for (const file of setup.files) {
    lines.push("", `Merge into ${file.path}:`, file.content.trimEnd());
  }
  if (setup.instruction && typeof setup.instruction === "object") {
    lines.push("", `Merge workflow guidance into ${setup.instruction.path}:`, setup.instruction.content.trimEnd());
  } else if (setup.instruction) {
    lines.push("", setup.instruction);
  }
  if (setup.commands.length) lines.push("", "Commands:", ...setup.commands.map((command) => `  ${command}`));
  lines.push("", `Verify with: ${setup.verifyPrompt}`);
  return lines.join("\n");
}
