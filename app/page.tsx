import { DevHubDashboard } from "./DevHubDashboard";
import { catalog } from "@/lib/catalog";
import { resolveStatusApiEndpoint } from "@/lib/status-bridge.mjs";

export const dynamic = "force-dynamic";

export default function Home() {
  const statusApiEndpoint = resolveStatusApiEndpoint(process.env.DEVHUB_STATUS_API_BASE_URL);
  return <DevHubDashboard catalog={catalog} statusApiEndpoint={statusApiEndpoint} />;
}
