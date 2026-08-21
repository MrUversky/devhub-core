export type ConnectorCapability =
  | "repositories"
  | "inventory"
  | "runtimes"
  | "deployments"
  | "environments"
  | "domains"
  | "data"
  | "monitoring"
  | "ownership"
  | "costs"
  | "key-metadata"
  | "recovery";

export type ConnectorAuth = "anonymous" | "github-app" | "oauth" | "cli-session" | "local-session" | "secret-reference" | "cloud-iam";
export type ConnectorStage = "available" | "planned";

export type ConnectorDefinition = Readonly<{
  id: string;
  name: string;
  priority: number;
  category: "source" | "runtime" | "deployment" | "infrastructure" | "data" | "observability" | "ai" | "business" | "builder";
  stage: ConnectorStage;
  roadmap?: Readonly<{ milestone: string; theme: string }>;
  summary: string;
  capabilities: readonly ConnectorCapability[];
  auth: readonly ConnectorAuth[];
  detection: Readonly<{ commands: readonly string[]; markers: readonly string[] }>;
}>;

export type ConnectedSetupEntryPoint = Readonly<{
  id: "setup-my-devhub" | "connect-my-tools" | "build-my-map" | "refresh-my-devhub";
  label: string;
  prompt: string;
}>;
export type ConnectedSetupStep = Readonly<{
  id: "choose-sources" | "run-with-agent";
  title: string;
  description: string;
}>;
export type ConnectedSetupRunStage = Readonly<{
  id: "connect-tools" | "build-my-map" | "review-unclear" | "done";
  title: string;
  description: string;
}>;
export type ConnectedSetupNextAction = Readonly<{
  id: "refresh-my-devhub" | "connect-another-source";
  label: string;
  prompt: string;
}>;

export const CONNECTOR_CAPABILITIES: readonly ConnectorCapability[];
export const CONNECTOR_CATALOG: readonly ConnectorDefinition[];
export const CONNECTED_SETUP: Readonly<{ title: string; description: string }>;
export const CONNECTED_SETUP_ENTRY_POINTS: readonly ConnectedSetupEntryPoint[];
export const CONNECTED_SETUP_STEPS: readonly ConnectedSetupStep[];
export const CONNECTED_SETUP_RUN_STAGES: readonly ConnectedSetupRunStage[];
export const CONNECTED_SETUP_NEXT_ACTIONS: readonly ConnectedSetupNextAction[];
export function buildConnectedSetupAgentPrompt(connectorIds: readonly string[]): string;
export function getConnector(id: string): ConnectorDefinition | null;
export function listConnectors(): readonly ConnectorDefinition[];
export function recommendedConnectors(limit?: number): readonly ConnectorDefinition[];
export function validateConnectorCatalog(connectors?: readonly ConnectorDefinition[]): true;
