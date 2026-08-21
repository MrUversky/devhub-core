import type { Project, ReadinessCheck, ReadinessEvidence, Service, ServiceReadiness } from "./catalog";

export type ReadinessProfile = NonNullable<ServiceReadiness["profile"]>;
export type ReadinessFieldProvenance = "service" | "project" | "absent";
export type EffectiveServiceReadiness = ServiceReadiness & { profile?: ReadinessProfile };
export type ServiceReadinessContext = {
  readiness: EffectiveServiceReadiness | null;
  fields: {
    profile: { value: ReadinessProfile | null; provenance: ReadinessFieldProvenance };
    owner: { value: string | null; provenance: ReadinessFieldProvenance };
    dataClassification: { value: NonNullable<ServiceReadiness["dataClassification"]> | null; provenance: ReadinessFieldProvenance };
    costModel: { value: NonNullable<ServiceReadiness["costModel"]> | null; provenance: ReadinessFieldProvenance };
  };
  evidenceProvenance: "service" | "absent";
};
export type EffectiveReadinessState = ReadinessEvidence["state"] | "stale";
export type ReadinessAssessmentItem = {
  check: ReadinessCheck;
  expected: boolean;
  state: EffectiveReadinessState;
  evidence: ReadinessEvidence | null;
  provenance: Pick<ReadinessEvidence, "source" | "observedAt" | "validUntil" | "url"> | null;
  actionable: boolean;
  action: string | null;
};
export type ReadinessGap = ReadinessAssessmentItem & { actionable: true; action: string };
export type ReadinessAssessment = {
  profile: ReadinessProfile | null;
  evaluatedAt: string;
  checks: ReadinessAssessmentItem[];
  gaps: ReadinessGap[];
  counts: Record<EffectiveReadinessState, number>;
};
export const READINESS_CHECKS: readonly ReadinessCheck[];
export const PROFILE_EXPECTATIONS: Record<ReadinessProfile, readonly ReadinessCheck[]>;
export const RECOVERY_CHECKS: readonly ReadinessCheck[];
export function resolveServiceReadinessContext(project: Project | null | undefined, service: Service | null | undefined): ServiceReadinessContext;
export function evaluateReadiness(
  readiness: ServiceReadiness | null | undefined,
  options?: { now?: Date | string | number },
): ReadinessAssessment;
export function groupRecoveryReadiness(assessment: ReadinessAssessment): {
  checks: ReadinessAssessmentItem[];
  gaps: ReadinessGap[];
};
