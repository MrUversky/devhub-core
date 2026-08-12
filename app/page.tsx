import { DevHubDashboard } from "./DevHubDashboard";
import { catalog } from "@/lib/catalog";

export default function Home() {
  return <DevHubDashboard catalog={catalog} />;
}
