import { getCatalogStatuses } from "@/lib/status";

export const dynamic = "force-dynamic";

export async function GET() {
  const statuses = await getCatalogStatuses();

  return Response.json(
    { observedAt: new Date().toISOString(), statuses },
    { headers: { "cache-control": "no-store, max-age=0" } },
  );
}
