export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(
    { status: "ok" },
    { headers: { "cache-control": "no-store, max-age=0" } },
  );
}
