import { getCatalogStatusSnapshot } from "@/lib/status";
import { isAllowedStatusCorsOrigin, parseStatusCorsOrigins } from "@/lib/status-bridge.mjs";

export const dynamic = "force-dynamic";

function statusCorsHeaders(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  if (origin === new URL(request.url).origin) return null;
  const allowedOrigins = parseStatusCorsOrigins(process.env.DEVHUB_STATUS_CORS_ORIGINS);
  if (!isAllowedStatusCorsOrigin(origin, allowedOrigins)) return false;
  return {
    "access-control-allow-origin": origin,
    "vary": "Origin",
  };
}

export async function GET(request: Request) {
  const corsHeaders = statusCorsHeaders(request);
  if (corsHeaders === false) {
    return Response.json({ error: "Origin is not allowed." }, {
      status: 403,
      headers: { "cache-control": "no-store, max-age=0", "vary": "Origin" },
    });
  }
  const snapshot = await getCatalogStatusSnapshot();

  return Response.json(
    snapshot,
    { headers: { "cache-control": "no-store, max-age=0", ...(corsHeaders ?? {}) } },
  );
}

export async function OPTIONS(request: Request) {
  const corsHeaders = statusCorsHeaders(request);
  const requestedMethod = request.headers.get("access-control-request-method");
  if (corsHeaders === false) {
    return new Response(null, { status: 403, headers: { "cache-control": "no-store, max-age=0", "vary": "Origin" } });
  }
  if (!corsHeaders) {
    return new Response(null, { status: 204, headers: { "allow": "GET, HEAD, OPTIONS" } });
  }
  if (requestedMethod !== "GET") {
    return new Response(null, { status: 403, headers: { "cache-control": "no-store, max-age=0", "vary": "Origin" } });
  }
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders,
      "access-control-allow-methods": "GET",
      "access-control-max-age": "600",
    },
  });
}
