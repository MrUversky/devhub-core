#!/usr/bin/env node

const host = process.env.HOST === "0.0.0.0" || process.env.HOST === "::"
  ? "127.0.0.1"
  : process.env.HOST ?? "127.0.0.1";
const port = process.env.PORT ?? "3000";
const baseUrl = `http://${host}:${port}`;
const authMode = process.env.DEVHUB_MCP_AUTH_MODE ?? "network";
const headers = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
  "mcp-protocol-version": "2025-06-18",
};

if (authMode === "bearer") {
  const token = process.env.DEVHUB_MCP_TOKEN ?? "";
  if (Buffer.byteLength(token, "utf8") < 32) {
    throw new Error("Bearer-mode MCP health check requires DEVHUB_MCP_TOKEN with at least 32 UTF-8 bytes.");
  }
  headers.authorization = `Bearer ${token}`;
} else if (authMode !== "network") {
  throw new Error(`Unsupported DEVHUB_MCP_AUTH_MODE: ${authMode}`);
}

const dashboard = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(4_000) });
if (!dashboard.ok) throw new Error(`Dashboard health returned HTTP ${dashboard.status}.`);

const mcp = await fetch(`${baseUrl}/mcp`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: "container-health",
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "devhub-container-health", version: "1.0.0" },
    },
  }),
  signal: AbortSignal.timeout(4_000),
});
if (!mcp.ok) throw new Error(`MCP health returned HTTP ${mcp.status}.`);
const payload = await mcp.json();
if (payload?.result?.serverInfo?.name !== "devhub") {
  throw new Error("MCP health did not return DevHub serverInfo.");
}
