import { catalog, type ViewerContext } from "@/lib/catalog";

export const dynamic = "force-dynamic";

function firstAddress(value: string | null) {
  return value?.split(",")[0]?.trim() || null;
}

export async function GET(request: Request) {
  const runtimeHostId = process.env.DEVHUB_HOST_ID?.trim() || "unknown";
  const reviewedRuntimeHostId = catalog.hosts.some((host) => host.id === runtimeHostId) ? runtimeHostId : null;
  const forwardedAddress = firstAddress(request.headers.get("x-forwarded-for"));
  const detectedHost = forwardedAddress
    ? catalog.hosts.find((host) => host.tailscaleIPv4 === forwardedAddress)
    : null;

  const context: ViewerContext = {
    runtimeHostId,
    detectedHostId: detectedHost?.id ?? (forwardedAddress ? null : reviewedRuntimeHostId),
    source: detectedHost ? "tailscale" : forwardedAddress ? "unknown" : "local",
  };

  return Response.json(context, {
    headers: { "cache-control": "private, no-store, max-age=0" },
  });
}
