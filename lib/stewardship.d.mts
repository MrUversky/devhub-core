import type { AccessFact, CredentialInventoryItem, Project, Service, Steward, StewardshipRole } from "./catalog";

export type StewardshipProvenance = "service" | "project" | "explicit-unknown" | "absent";
export type EffectiveStewardshipRole = {
  stewardId: string | null;
  steward: Steward | null;
  provenance: StewardshipProvenance;
  state: "reviewed" | "stale" | "missing";
};
export type EffectiveCredentialInventoryItem = CredentialInventoryItem & {
  ownerSteward: Steward | null;
  payerSteward: Steward | null;
  ownerState: "reviewed" | "stale" | "missing";
  payerState: "reviewed" | "stale" | "missing";
  verificationState: "reviewed" | "rotation-due" | "unknown";
};
export type EffectiveAccessFact = Omit<AccessFact, "access"> & {
  access: AccessFact["access"];
  recordedAccess: AccessFact["access"];
  freshnessState: "reviewed" | "stale";
};
export type ServiceStewardshipContext = {
  evaluatedAt: string;
  roles: Record<StewardshipRole, EffectiveStewardshipRole>;
  credentials: EffectiveCredentialInventoryItem[];
  access: EffectiveAccessFact[];
  summary: {
    reviewed: number;
    missing: number;
    stale: number;
    shared: number;
    singlePersonRisk: boolean;
    credentials: number;
    credentialsWithUnknownPayer: number;
    credentialsWithStaleOwner: number;
    staleAccess: number;
  };
};

export const STEWARDSHIP_ROLES: readonly StewardshipRole[];
export function resolveAccessFacts(project: Project | null | undefined, options?: { now?: Date | string | number }): EffectiveAccessFact[];
export function resolveCredentialInventory(project: Project | null | undefined, options?: { now?: Date | string | number }): EffectiveCredentialInventoryItem[];
export function resolveServiceStewardshipContext(
  project: Project | null | undefined,
  service: Service | null | undefined,
  options?: { now?: Date | string | number },
): ServiceStewardshipContext;
export function stewardshipSearchTerms(project: Project, service: Service): string[];
