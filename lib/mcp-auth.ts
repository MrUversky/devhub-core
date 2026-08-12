import { timingSafeEqual } from "node:crypto";

export type McpAuthMode = "network" | "bearer";

type McpAuthOptions = {
  mode?: string;
  token?: string;
};

const noStoreHeaders = {
  "cache-control": "private, no-store, max-age=0",
  "x-content-type-options": "nosniff",
};

function jsonError(status: number, error: string, headers: Record<string, string> = {}) {
  return Response.json({ error }, { status, headers: { ...noStoreHeaders, ...headers } });
}

function constantTimeTokenMatch(provided: string, expected: string) {
  const providedBytes = Buffer.from(provided, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  const width = Math.max(providedBytes.length, expectedBytes.length, 1);
  const left = Buffer.alloc(width);
  const right = Buffer.alloc(width);
  providedBytes.copy(left);
  expectedBytes.copy(right);
  return timingSafeEqual(left, right) && providedBytes.length === expectedBytes.length;
}

function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization) return null;
  const match = authorization.match(/^Bearer[ \t]+(.+)$/i);
  return match?.[1] ?? null;
}

export function authorizeMcpRequest(request: Request, options: McpAuthOptions = {}) {
  const mode = (options.mode ?? "network") as McpAuthMode;

  if (mode === "network") return null;

  if (mode === "bearer") {
    const expected = options.token ?? "";
    if (Buffer.byteLength(expected, "utf8") < 32) {
      return jsonError(503, "DevHub MCP bearer authentication is not configured.");
    }
    const provided = bearerToken(request);
    if (!provided || !constantTimeTokenMatch(provided, expected)) {
      return jsonError(401, "DevHub MCP authentication is required.", {
        "www-authenticate": 'Bearer realm="devhub-mcp"',
      });
    }
    return null;
  }

  return jsonError(503, "DevHub MCP authentication mode is invalid.");
}

export function authorizeConfiguredMcpRequest(request: Request) {
  return authorizeMcpRequest(request, {
    mode: process.env.DEVHUB_MCP_AUTH_MODE ?? "network",
    token: process.env.DEVHUB_MCP_TOKEN,
  });
}
