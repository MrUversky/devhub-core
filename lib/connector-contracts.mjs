import { defineConnectorContract, createConnectorContractRegistry } from "./connector-conformance.mjs";
import { githubDeploymentAdapter } from "./evidence-adapters/providers/github-deployment.mjs";
import { githubReleaseDeploymentAdapter } from "./evidence-adapters/providers/github-release-deployment.mjs";
import { githubWorkflowMonitoringAdapter } from "./evidence-adapters/providers/github-workflow-monitoring.mjs";
import { OPENAI_PROJECT_EVIDENCE_ADAPTER_ID } from "./evidence-adapters/providers/openai-project.mjs";
import { SENTRY_MONITORING_ADAPTER_ID } from "./evidence-adapters/providers/sentry-monitoring.mjs";
import { VERCEL_DEPLOYMENT_ADAPTER_ID } from "./evidence-adapters/providers/vercel-deployment.mjs";
import { RAILWAY_INVENTORY_ADAPTER_ID } from "./inventory-adapters/providers/railway.mjs";
import { OPENAI_PROJECT_INVENTORY_ADAPTER_ID } from "./inventory-adapters/providers/openai.mjs";
import { VERCEL_INVENTORY_ADAPTER_ID } from "./inventory-adapters/providers/vercel.mjs";

const REQUIRED_BOUNDARIES = Object.freeze({
  exactScope: true,
  credentialIsolation: true,
  readOnly: true,
  hardDeadline: true,
  boundedPagination: true,
  boundedResponses: true,
  boundedCandidates: true,
  freshnessRequired: true,
  secretsRejected: true,
  normalizedOnly: true,
  providerMutations: false,
  catalogWrites: false,
  catalogMatching: false,
  ownershipDecisions: false,
});

function experimentalContract({ connectorId, provider = connectorId, capabilities, limits }) {
  return defineConnectorContract({
    formatVersion: 1,
    connectorId,
    provider,
    compatibility: {
      status: "experimental",
      since: "0.10.0",
      deprecatedSince: null,
      replacementConnectorId: null,
    },
    capabilities,
    limits,
    boundaries: REQUIRED_BOUNDARIES,
  });
}

export const GITHUB_CONNECTOR_CONTRACT = experimentalContract({
  connectorId: "github",
  capabilities: {
    profiles: [{ id: "github", formatVersion: 1 }],
    setup: [{ id: "github", formatVersion: 1 }],
    inventory: [],
    evidence: [
      { id: githubDeploymentAdapter.id, formatVersion: 1 },
      { id: githubReleaseDeploymentAdapter.id, formatVersion: 1 },
      { id: githubWorkflowMonitoringAdapter.id, formatVersion: 1 },
    ],
  },
  limits: { deadlineMs: 30_000, maxPages: 12, maxResponseBytes: 2 * 1024 * 1024, maxCandidates: 1 },
});

export const LOCAL_HOST_CONNECTOR_CONTRACT = experimentalContract({
  connectorId: "local-host",
  provider: "local-host",
  capabilities: {
    profiles: [{ id: "local-host", formatVersion: 1 }],
    setup: [{ id: "local-host", formatVersion: 1 }],
    inventory: [],
    evidence: [],
  },
  limits: { deadlineMs: 30_000, maxPages: 1, maxResponseBytes: 1024 * 1024, maxCandidates: 500 },
});

export const OPENAI_CONNECTOR_CONTRACT = experimentalContract({
  connectorId: "openai",
  capabilities: {
    profiles: [{ id: "openai", formatVersion: 1 }],
    setup: [{ id: "openai", formatVersion: 1 }],
    inventory: [{ id: OPENAI_PROJECT_INVENTORY_ADAPTER_ID, formatVersion: 1 }],
    evidence: [{ id: OPENAI_PROJECT_EVIDENCE_ADAPTER_ID, formatVersion: 1 }],
  },
  limits: { deadlineMs: 10_000, maxPages: 20, maxResponseBytes: 1024 * 1024, maxCandidates: 50 },
});

export const RAILWAY_CONNECTOR_CONTRACT = experimentalContract({
  connectorId: "railway",
  capabilities: {
    profiles: [{ id: "railway", formatVersion: 1 }],
    setup: [{ id: "railway", formatVersion: 1 }],
    inventory: [{ id: RAILWAY_INVENTORY_ADAPTER_ID, formatVersion: 1 }],
    evidence: [],
  },
  limits: { deadlineMs: 30_000, maxPages: 100, maxResponseBytes: 2 * 1024 * 1024, maxCandidates: 1_000 },
});

export const SENTRY_CONNECTOR_CONTRACT = experimentalContract({
  connectorId: "sentry",
  capabilities: {
    profiles: [],
    setup: [],
    inventory: [],
    evidence: [{ id: SENTRY_MONITORING_ADAPTER_ID, formatVersion: 1 }],
  },
  limits: { deadlineMs: 30_000, maxPages: 3, maxResponseBytes: 2 * 1024 * 1024, maxCandidates: 2 },
});

export const VERCEL_CONNECTOR_CONTRACT = experimentalContract({
  connectorId: "vercel",
  capabilities: {
    profiles: [{ id: "vercel", formatVersion: 1 }],
    setup: [{ id: "vercel", formatVersion: 1 }],
    inventory: [{ id: VERCEL_INVENTORY_ADAPTER_ID, formatVersion: 1 }],
    evidence: [{ id: VERCEL_DEPLOYMENT_ADAPTER_ID, formatVersion: 1 }],
  },
  limits: { deadlineMs: 10_000, maxPages: 20, maxResponseBytes: 1024 * 1024, maxCandidates: 200 },
});

export const CONNECTOR_CONTRACTS = Object.freeze([
  GITHUB_CONNECTOR_CONTRACT,
  LOCAL_HOST_CONNECTOR_CONTRACT,
  OPENAI_CONNECTOR_CONTRACT,
  VERCEL_CONNECTOR_CONTRACT,
  RAILWAY_CONNECTOR_CONTRACT,
  SENTRY_CONNECTOR_CONTRACT,
]);

export const connectorContractRegistry = createConnectorContractRegistry({
  contracts: CONNECTOR_CONTRACTS,
});
