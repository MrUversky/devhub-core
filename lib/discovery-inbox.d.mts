export type DiscoveryState = "exact-match" | "possible-match" | "new" | "reviewed-external" | "unknown" | "ignored";
export type DiscoveryQuestionType = "product-identity" | "environment" | "owner" | "payer" | "operating-intent";
export type DiscoveryQuestionGroup = Readonly<{
  id: string;
  type: DiscoveryQuestionType;
  phase: "triage";
  prompt: string;
  required: true;
  answerMode: "per-candidate";
  profileId: string;
  provider: string;
  state: DiscoveryState;
  candidateCount: number;
  candidateIds: readonly string[];
  candidates: readonly Readonly<{ candidateId: string; label: string; state: DiscoveryState }>[];
  choices: readonly Readonly<{ id: string; label: string; followUp: readonly string[] }>[];
  evidence: Readonly<Record<string, unknown>>;
}>;
export type DiscoveryIdentity = Readonly<{
  profileId: string;
  provider: string;
  resourceType: string;
  resourceId: string;
}>;
export type DiscoveryReviewDecision = Readonly<{
  candidateId: string;
  reviewedAt: string;
  reviewedBy: string;
  disposition: "catalog" | "new" | "external" | "ignore";
  projectId?: string;
  serviceId?: string;
  reason?: string;
  answers?: Readonly<Partial<Record<"productIdentity" | "environment" | "owner" | "payer" | "operatingIntent", string>>>;
}>;
export type DiscoveryReviewDocument = Readonly<{
  version: 1;
  artifactId: string;
  decisions: readonly DiscoveryReviewDecision[];
}>;
export type DiscoveryInbox = Readonly<{
  version: 1;
  command: "discovery-inbox";
  artifactId: string;
  readOnly: true;
  persistent: false;
  catalogWrites: false;
  dashboardMutation: false;
  generatedFrom: "validated-setup-session" | "validated-task-observations" | "validated-local-discovery"
    | "validated-setup-session-and-task-observations" | "validated-setup-session-and-local-discovery"
    | "validated-task-observations-and-local-discovery" | "validated-setup-session-task-observations-and-local-discovery";
  summary: Readonly<Record<string, unknown>>;
  items: readonly Readonly<Record<string, unknown>>[];
  questions: readonly Readonly<Record<string, unknown>>[];
  questionGroups: readonly DiscoveryQuestionGroup[];
  proposals: readonly Readonly<Record<string, unknown>>[];
}>;
export class DiscoveryInboxError extends Error { code: string; }
export function parseDiscoveryReviewDocument(value: unknown, expectedArtifactId?: string | null): DiscoveryReviewDocument;
export function buildDiscoveryInbox(
  sourceCatalog: unknown,
  setupSessionInput: unknown,
  profileInput: unknown,
  reviewInput?: unknown,
  options?: { projectDirectory?: string | null; now?: string | number | Date; taskObservationDocument?: unknown; localDiscoveryDocument?: unknown },
): DiscoveryInbox;
