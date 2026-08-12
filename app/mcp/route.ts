import { handleMcpRequest } from "@/lib/mcp-server";
import { authorizeConfiguredMcpRequest } from "@/lib/mcp-auth";

export const dynamic = "force-dynamic";

function methodNotAllowed() {
  return Response.json(
    { error: "DevHub MCP is a stateless Streamable HTTP endpoint; send MCP JSON-RPC with POST." },
    { status: 405, headers: { allow: "POST, OPTIONS", "cache-control": "private, no-store, max-age=0" } },
  );
}

export async function POST(request: Request) {
  const denied = authorizeConfiguredMcpRequest(request);
  if (denied) return denied;
  return handleMcpRequest(request);
}

export async function GET() {
  return methodNotAllowed();
}

export async function DELETE() {
  return methodNotAllowed();
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      allow: "POST, OPTIONS",
      "cache-control": "private, no-store, max-age=0",
    },
  });
}
