import type { EvidenceAdapter, EvidenceAdapterObservation, EvidenceAdapterRequest } from "../../evidence-adapters.mjs";
import type { OpenAIAdminFetch } from "../../openai-admin-api.mjs";

export type OpenAIProjectEvidenceIdentity = {
  organizationId: string;
  projectId: string;
  projectName: string;
  keyId: string;
  access: { project: "yes"; billing: "yes" | "no" | "unknown" };
  stewardship: {
    credentialOwner: string;
    billingOwner: string | null;
    purpose: string;
    lastVerifiedAt: string | null;
    rotationDueAt: string | null;
  };
  window: { startTime: string; endTime: string };
};

export type OpenAIProjectEvidenceAdapter = EvidenceAdapter & {
  collect(request: Readonly<EvidenceAdapterRequest>): Promise<EvidenceAdapterObservation>;
};

export const OPENAI_PROJECT_EVIDENCE_ADAPTER_ID: "openai-project-evidence-v1";
export function validateOpenAIProjectEvidenceIdentity(identity: unknown): identity is OpenAIProjectEvidenceIdentity;
export function createOpenAIProjectEvidenceAdapter(options?: {
  fetch?: OpenAIAdminFetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}): OpenAIProjectEvidenceAdapter;
export const openAIProjectEvidenceAdapter: OpenAIProjectEvidenceAdapter;
