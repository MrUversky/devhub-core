import { DevHubDashboard } from "./DevHubDashboard";
import { catalog } from "@/lib/catalog";
import { resolveStatusApiEndpoint } from "@/lib/status-bridge.mjs";

export const dynamic = "force-dynamic";

export default function Home() {
  const sitesCompanion = process.env.DEVHUB_SITES_COMPANION === "owner-only";
  const configuredStatusOrigin = process.env.DEVHUB_STATUS_API_BASE_URL?.trim();
  const statusApiEndpoint = sitesCompanion && !configuredStatusOrigin
    ? null
    : resolveStatusApiEndpoint(configuredStatusOrigin);
  return <DevHubDashboard
    catalog={catalog}
    statusApiEndpoint={statusApiEndpoint}
    viewerContextEndpoint={sitesCompanion ? null : "/api/context"}
  />;
}
