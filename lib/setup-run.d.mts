import type { ConnectionProfile } from "./setup-session.mjs";
import type { GuidedConnectionCard } from "./connection-onboarding.mjs";
import type { SetupRunPresentationPreflight } from "./setup-run-presentation.mjs";
export { createSetupRunPresentationPreflight, SetupRunError } from "./setup-run-presentation.mjs";
export const SETUP_RUN_DEFAULT_DEADLINE_MS: 30000;
export const SETUP_RUN_MAX_DEADLINE_MS: 120000;
export function resolveSetupRunDeadline(value?: number): number;
export type ConnectionReviewDocument = Readonly<{
  version: 1;
  reviewId: `sha256:${string}`;
  answers: readonly [Readonly<{
    questionId: string;
    connectorId: string;
    answer: Readonly<Record<string, unknown>>;
  }>];
}>;
export function parseConnectionReviewDocument(value: unknown, onboardings?: ReadonlyMap<string, unknown>): ConnectionReviewDocument;
export type { SetupRunPresentationPreflight, SetupRunPresentationSource, SetupRunPresentationStatus } from "./setup-run-presentation.mjs";
export function createSetupRunPreflight(input: {
  selectedConnectorIds: readonly string[];
  profileDocument?: unknown;
  now?: string | number | Date;
  planning?: Readonly<Record<string, unknown>> | null;
}): Readonly<{ presentation: SetupRunPresentationPreflight; runnableProfiles: readonly ConnectionProfile[] }>;
export type SetupReviewPresentation = Readonly<{
  version: 1;
  sourcePreflight: Readonly<{
    selected: number;
    profileReadyCount: number;
    checkedCount: number;
    checkedThisTaskCount: number;
    savedForRefreshCount: number;
    taskOnlyCount: number;
    taskOnly: readonly Readonly<{
      connectorId: string;
      name: string;
      preflightStatus: string;
      checked: true;
      checkState: "checked-this-task";
      observationCount: number;
      savedForRefresh: false;
      scopeLabel: string;
    }>[];
    readyCount: number;
    ready: readonly Readonly<{
      connectorId: string;
      name: string;
      preflightStatus: string;
      checked: boolean;
      checkState: string;
      observationCount: number;
    }>[];
    notCheckedCount: number;
    notChecked: readonly Readonly<{
      connectorId: string;
      name: string;
      preflightStatus: string;
      checked: false;
      checkState: "not-checked";
      observationCount: 0;
    }>[];
    needsAttentionCount: number;
    needsAttention: readonly Readonly<{
      connectorId: string;
      name: string;
      preflightStatus: string;
      state: string;
      questionGroupId: string;
      nextAction: Readonly<{ id: string; label: string }>;
      guidedConnection?: GuidedConnectionCard;
    }>[];
  }>;
  knownExactMatches: Readonly<{
    count: number;
    hiddenFromHumanReview: true;
    byProvider: readonly Readonly<{ provider: string; count: number }>[];
  }>;
  artifactReview: Readonly<{
    artifactId: string | null;
    candidateCount: number;
    groupCount: number;
    groupIds: readonly string[];
  }>;
  delivery: Readonly<{ transport: "stdout"; writes: false }>;
}>;
export type SetupReview = Readonly<Record<string, unknown>>;
export function runSetupReview(input: {
  selectedConnectorIds: readonly string[];
  profileDocument?: unknown;
  planning?: Readonly<Record<string, unknown>> | null;
  sourceCatalog?: unknown;
  connectionReviewDocument?: unknown;
  taskObservationDocument?: unknown;
  localDiscoveryDocument?: unknown;
  now?: string | number | Date;
}, options?: {
  deadlineMs?: number;
  deadlineAt?: number;
  deadlineExpired?: boolean;
  sessionId?: string;
  connectors?: ReadonlyMap<string, unknown> | Record<string, unknown> | readonly unknown[];
  resolveCredential?: (...args: readonly unknown[]) => unknown;
  signal?: AbortSignal;
  projectDirectory?: string | null;
}): Promise<SetupReview>;
export function formatSetupReview(result: SetupReview): string;
