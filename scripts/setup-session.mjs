import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";

import {
  createGitHubGhSessionTransport,
  createGitHubSetupSessionConnector,
} from "../lib/setup-connectors/github.mjs";
import { railwaySetupConnector } from "../lib/setup-connectors/railway.mjs";
import { vercelSetupConnector } from "../lib/setup-connectors/vercel.mjs";
import { openAISetupConnector } from "../lib/setup-connectors/openai.mjs";
import { localHostConnectionOnboarding, validateLocalHostSetupScope } from "../lib/setup-connectors/local-host.mjs";
import { parseConnectionProfileDocument, runSetupSession, SetupSessionError } from "../lib/setup-session.mjs";
import { runIsolatedHostInspection } from "./host-inspection-process.mjs";

const execFileAsync = promisify(execFile);
const MAX_PROFILE_BYTES = 256 * 1024;
const CREDENTIAL_MAX_BYTES = 64 * 1024;
const CREDENTIAL_COMMAND_TIMEOUT_MS = 5_000;
const KEYCHAIN_CREDENTIAL_TIMEOUT_MS = 15_000;
const keychainLocator = /^generic-password:([A-Za-z0-9._@+-]{1,100}):([A-Za-z0-9._@+-]{1,100})$/;
const onePasswordLocator = /^op:\/\/[A-Za-z0-9._ -]{1,100}\/[A-Za-z0-9._ -]{1,100}\/[A-Za-z0-9._ -]{1,100}$/;
const root = path.resolve(import.meta.dirname, "..");

export async function readConnectionProfileDocument(filename) {
  const details = await stat(filename);
  if (!details.isFile()) throw new SetupSessionError("invalid-connection-profile", `${filename} must be a file`);
  if (details.size > MAX_PROFILE_BYTES) {
    throw new SetupSessionError("invalid-connection-profile", `${filename} exceeds the ${MAX_PROFILE_BYTES}-byte limit`);
  }
  let document;
  try {
    document = JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new SetupSessionError("invalid-connection-profile", `${filename} must contain valid JSON`);
    throw error;
  }
  parseConnectionProfileDocument(document);
  return document;
}

function defaultGhRunner(args, { signal, maxBuffer }) {
  return execFileAsync("gh", args, {
    encoding: "utf8",
    signal,
    maxBuffer,
    windowsHide: true,
  });
}

export function createDefaultSetupConnectors(options = {}) {
  const githubTransport = createGitHubGhSessionTransport({
    runGh: options.runGh ?? defaultGhRunner,
    maxResponseBytes: options.githubMaxResponseBytes,
  });
  return Object.freeze([
    createGitHubSetupSessionConnector({ transport: githubTransport }),
    options.openAIConnector ?? openAISetupConnector,
    options.vercelConnector ?? vercelSetupConnector,
    options.railwayConnector ?? railwaySetupConnector,
    options.localHostConnector ?? createLocalHostSetupConnector({
      root: options.root ?? root,
      paths: options.paths,
      inspect: options.inspectHost,
      childPath: options.hostInspectionChildPath,
      timeoutMs: options.hostInspectionTimeoutMs,
    }),
  ]);
}

export function createLocalHostSetupConnector({ root: registryRoot, paths, inspect, childPath, timeoutMs } = {}) {
  if (typeof registryRoot !== "string" || !path.isAbsolute(registryRoot) || (inspect !== undefined && typeof inspect !== "function")) {
    throw new TypeError("local-host setup connector requires an absolute registry root and optional inspect function");
  }
  return Object.freeze({
    connectorId: "local-host",
    onboarding: localHostConnectionOnboarding,
    awaitAbortCleanup: inspect === undefined,
    validateProfile(profile) {
      const scope = profile?.scope;
      if (!validateLocalHostSetupScope(scope)) {
        throw new TypeError("local-host profile requires exact scope { hostId }");
      }
      if (profile.authorization?.method !== "local-session") throw new TypeError("local-host profile requires local-session authorization");
    },
    async collect({ profile, now, signal }) {
      let inspection;
      if (inspect) {
        inspection = await inspect(registryRoot, profile.scope.hostId, {
          ...(paths ? { paths } : {}),
          now: new Date(now),
          identitySource: "reviewed-connection-profile",
          ...(signal ? { signal } : {}),
        });
      } else {
        const isolated = await runIsolatedHostInspection(registryRoot, profile.scope.hostId, {
          ...(paths ? { paths } : {}),
          now: new Date(now),
          identitySource: "reviewed-connection-profile",
          ...(signal ? { signal } : {}),
          ...(childPath ? { childPath } : {}),
          ...(timeoutMs ? { timeoutMs } : {}),
        });
        if (isolated.state !== "completed") {
          return {
            state: "unknown",
            observedAt: isolated.observedAt,
            message: "The isolated read-only local-host inspection did not return a bounded reviewed observation.",
            observations: [],
          };
        }
        inspection = isolated.inspection;
      }
      return {
        state: "connected",
        observedAt: inspection.observedAt,
        message: `${inspection.serviceMatches.length} reviewed local services matched; ${(inspection.projectRepositories ?? []).length} project repository identities observed; ${inspection.unknowns.length} remain unknown.`,
        observations: [
          {
            kind: "host-identity",
            id: inspection.host.id,
            name: inspection.host.name,
            hostKind: inspection.host.kind,
            location: inspection.host.location,
            identitySource: inspection.identity.source,
            identityVerified: inspection.identity.verified,
          },
          ...(inspection.projectRepositories ?? []).map((match) => ({ kind: "project-repository", ...match })),
          ...inspection.serviceMatches.map((match) => ({ kind: "service-runtime", ...match })),
          ...inspection.unknowns.map((unknown) => ({ kind: "service-runtime-unknown", ...unknown })),
          ...inspection.sources.map((source) => ({ kind: "inspection-source", ...source })),
        ],
      };
    },
  });
}

function defaultCredentialCommand(command, args, options) {
  return execFileAsync(command, args, options);
}

export function createCredentialResolver({ environment = process.env, run = defaultCredentialCommand } = {}) {
  return async function resolveCredential(reference, context = {}) {
    if (reference.kind === "environment") return environment[reference.locator];
    let command;
    let args;
    let timeout = CREDENTIAL_COMMAND_TIMEOUT_MS;
    if (reference.kind === "keychain") {
      const match = reference.locator.match(keychainLocator);
      if (!match) return undefined;
      command = "security";
      args = ["find-generic-password", "-w", "-s", match[1], "-a", match[2]];
      timeout = KEYCHAIN_CREDENTIAL_TIMEOUT_MS;
    } else if (reference.kind === "secret-manager") {
      if (!onePasswordLocator.test(reference.locator)) return undefined;
      command = "op";
      args = ["read", "--no-newline", reference.locator];
    } else {
      return undefined;
    }
    try {
      const result = await run(command, args, {
        encoding: "utf8",
        timeout,
        maxBuffer: CREDENTIAL_MAX_BYTES,
        windowsHide: true,
        shell: false,
        ...(context.signal ? { signal: context.signal } : {}),
      });
      const value = typeof result === "string" ? result : result?.stdout;
      return typeof value === "string" && value.length && Buffer.byteLength(value, "utf8") <= CREDENTIAL_MAX_BYTES
        ? value.replace(/\r?\n$/, "")
        : undefined;
    } catch {
      return undefined;
    }
  };
}

export const createEnvironmentCredentialResolver = (environment = process.env) => createCredentialResolver({ environment });

export async function runConnectedSetupSession(document, options = {}) {
  return runSetupSession(document, {
    now: options.now,
    sessionId: options.sessionId,
    signal: options.signal,
    connectors: options.connectors ?? createDefaultSetupConnectors(options),
    resolveCredential: options.resolveCredential ?? createCredentialResolver({
      environment: options.environment,
      run: options.runCredentialCommand,
    }),
  });
}

export function formatSetupSession(session) {
  const lines = [
    `DevHub setup session: ${session.status}`,
    "Read-only, on-demand and non-persistent. Credential values are never returned.",
  ];
  for (const result of session.results) {
    lines.push(`${result.profileId} (${result.connectorId}): ${result.state}`);
    if (result.message) lines.push(`  ${result.message}`);
    lines.push(`  Scope: ${JSON.stringify(result.reviewedConnection.scope)}`);
    lines.push(`  Observations: ${result.evidence.observations.length}`);
  }
  return lines.join("\n");
}
