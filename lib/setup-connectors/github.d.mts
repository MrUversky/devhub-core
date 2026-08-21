import type { ConnectionProfile, SetupConnector, SetupConnectorResult } from "../setup-session.mjs";
import type { ConnectionOnboarding } from "../connection-onboarding.mjs";

export type GitHubSetupScope = Readonly<{
  kind: "user" | "organization";
  login: string;
}>;

export type GitHubSetupAuthorization = Readonly<{
  method: "cli-session" | "github-app" | "browser-session";
  reference: string;
  state: "reviewed";
}>;

export type GitHubSetupLimits = Readonly<{
  maxRepositories: number;
  maxPages: number;
  deadlineMs: number;
  maxResponseBytes: number;
}>;

export type GitHubTransportResult =
  | Readonly<{ status: "success"; body: string }>
  | Readonly<{ status: "unavailable"; reason: string }>;

export type GitHubSetupTransport = Readonly<{
  method: GitHubSetupAuthorization["method"];
  maxResponseBytes: number;
  request(path: string, options: {
    signal: AbortSignal;
    maxResponseBytes: number;
  }): Promise<GitHubTransportResult>;
}>;

export type GitHubSetupRepository = Readonly<{
  id: string;
  owner: string;
  name: string;
  fullName: string;
  url: string;
  visibility: "public" | "private" | "internal";
  archived: boolean;
  disabled: boolean;
  access: "admin" | "write" | "read" | "unknown";
  ownership: "unknown";
  candidateIdentity: Readonly<{ provider: "github"; owner: string; name: string }>;
}>;

export type GitHubSetupObservation = Readonly<{
  status: "success";
  state: "connected";
  observedAt: string;
  pagesRead: number;
  authorization: GitHubSetupAuthorization;
  identity: Readonly<{ providerId: string; login: string; kind: "user" | "bot" }>;
  scope: Readonly<{ kind: "user" | "organization"; login: string; providerId: string }>;
  repositories: readonly GitHubSetupRepository[];
  limitations: readonly Readonly<{ code: string; state: "observed" | "unknown"; summary: string }>[];
  exactEvidence: readonly Readonly<{ adapterId: string; check: "deployment" | "monitoring"; state: "requires-reviewed-identity" }>[];
  safety: Readonly<{
    readOnly: true;
    credentialsStored: false;
    rawPayloadsRetained: false;
    catalogWrites: false;
    ownershipInferred: false;
  }>;
}> | Readonly<{
  status: "unavailable";
  state: "authorization-required" | "unknown";
  reason: string;
  repositories: readonly [];
  nextAction: Readonly<{ id: string; label: string; safe: true }>;
}>;

export type GitHubSetupConnector = Readonly<{
  id: "github-connected-setup-v1";
  provider: "github";
  validateScope(scope: unknown): scope is GitHubSetupScope;
  collect(request: Readonly<{
    provider: "github";
    scope: GitHubSetupScope;
    authorization: GitHubSetupAuthorization;
    now: string | number | Date;
    limits: GitHubSetupLimits;
    signal?: AbortSignal;
  }>): Promise<GitHubSetupObservation>;
}>;

export const GITHUB_SETUP_CONNECTOR_ID: "github-connected-setup-v1";
export const GITHUB_SETUP_CONNECTOR: "github";
export function validateGitHubSetupScope(scope: unknown): scope is GitHubSetupScope;
export function createGitHubConnectionOnboarding(authorizationMethod?: "cli-session" | "github-app"): ConnectionOnboarding;
export const githubConnectionOnboarding: ConnectionOnboarding;
export function createGitHubGhSessionTransport(options: {
  runGh(args: readonly string[], options: { signal: AbortSignal; maxBuffer: number }): Promise<{ stdout: string } | string>;
  maxResponseBytes?: number;
}): GitHubSetupTransport;
export function createGitHubAuthorizedTransport(options: {
  method: "github-app" | "browser-session";
  request: GitHubSetupTransport["request"];
  maxResponseBytes?: number;
}): GitHubSetupTransport;
export function createGitHubSetupConnector(options: { transport: GitHubSetupTransport }): GitHubSetupConnector;
export function createGitHubSetupSessionConnector(options: {
  transport: GitHubSetupTransport;
  limits?: GitHubSetupLimits;
}): SetupConnector & {
  connectorId: "github";
  validateProfile(profile: ConnectionProfile): void;
  collect(input: { profile: ConnectionProfile; now: string }): Promise<SetupConnectorResult>;
};
