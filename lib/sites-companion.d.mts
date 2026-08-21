export class SitesCompanionError extends Error {
  code: string;
  constructor(code: string, message: string);
}

export type SitesCompanionBinding = Readonly<{
  version: 1;
  kind: "devhub-sites-companion";
  projectId: string;
  siteOrigin: string;
  currentVersionId: string;
  previousVersionId: string | null;
}>;

export function sanitizeSitesCompanionCatalog(sourceCatalog: {
  hosts: readonly Record<string, unknown>[];
  projects: readonly Record<string, unknown>[];
}): Readonly<Record<string, unknown>>;

export function parseSitesCompanionBinding(document?: unknown): SitesCompanionBinding | null;

export function createSitesCompanionPlan(input: {
  apply?: boolean;
  source: { releaseTag: string; sourceCommit: string; manifestSha256: string };
  catalog: { revision: string; fingerprint: string };
  statusApiOrigin: string;
  binding?: unknown;
}): Readonly<Record<string, unknown>>;
