import type { ConnectionProfile, CredentialReference, SetupState } from "./setup-session.mjs";

export type AvailabilityReviewDecision = Readonly<{
  profileId: string;
  disposition: "accepted-unavailable";
  sessionId: string;
  connectorId: string;
  profileFingerprint: string;
  reviewedAt: string;
  reviewedBy: string;
  reason: string;
}>;

export type SetupConnectionState = Readonly<{
  profileId: string;
  connectorId: string;
  reviewedScope: Readonly<Record<string, unknown>>;
  owner: string;
  authorization: Readonly<{ method: string; credentialRef?: CredentialReference }>;
  state: Exclude<SetupState, "detected">;
  lastSync: string | null;
  freshness: "fresh" | "stale" | "unknown";
  resultSummary: { observations: number; kinds: Record<string, number> };
  acceptedUnavailable: AvailabilityReviewDecision | null;
  qualifiesForCompletion: boolean;
}>;

export type SetupRefreshKind = "new" | "changed" | "stale" | "unclear";
export type SetupRefreshIdentity = Readonly<{ profileId: string; provider: string; resourceType: string; resourceId: string }>;
export type ValidatedSetupSessionResult = Readonly<{
  profile: ConnectionProfile;
  profileId: string;
  connectorId: string;
  state: Exclude<SetupState, "detected">;
  observedAt: string | null;
  freshUntil: string | null;
  observations: readonly Readonly<Record<string, unknown>>[];
  message: string | null;
}>;
export type ValidatedSetupSessionArtifact = Readonly<{
  sessionId: string;
  startedAt: string;
  completedAt: string;
  status: "complete" | "review-required";
  results: readonly ValidatedSetupSessionResult[];
}>;

export class SetupStateError extends Error { code: string; }
export function validateSetupSessionArtifact(session: unknown, profileDocument: unknown, options?: { now?: string | number | Date }): ValidatedSetupSessionArtifact;
export function createUnavailableAcceptance(profile: unknown, session: unknown, options: { reviewedAt: string; reviewedBy: string; reason: string }): AvailabilityReviewDecision;
export function evaluateSetupState(profileDocument: unknown, session: unknown, options?: { now?: string | number | Date; availabilityReview?: unknown; discoveryInbox?: unknown }): Readonly<Record<string, unknown>>;
export function createSetupRefreshPlan(profileDocument: unknown): Readonly<Record<string, unknown>>;
export function compareSetupRefresh(profileDocument: unknown, previousSession: unknown, currentSession: unknown, options?: { now?: string | number | Date }): Readonly<Record<string, unknown>>;
export function proposeConnectionDisconnect(profile: ConnectionProfile | unknown, options: { action?: "remove" | "disable"; requestedAt: string; requestedBy: string; reason: string }): Readonly<Record<string, unknown>>;
