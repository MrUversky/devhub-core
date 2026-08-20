export type CatalogReviewProject = Readonly<{
  id: string;
  services: readonly Readonly<{ id: string }>[];
}>;

export type CatalogReviewScope = Readonly<{
  matchingServiceCount: number;
  totalServiceCount: number;
  matchingProjectCount: number;
  serviceKeys: readonly string[];
  questionGroupCount: number;
  questionItemCount: number;
}>;

export type CatalogReviewPresentation = Readonly<{
  version: 1;
  universe: Readonly<{ projectCount: number; serviceCount: number }>;
  scopes: Readonly<{
    passport: CatalogReviewScope;
    "evidence-gap": CatalogReviewScope;
    stewardship: CatalogReviewScope;
  }>;
}>;

export function deriveCatalogReviewPresentation(
  projects: readonly CatalogReviewProject[],
  options?: Readonly<{ now?: string | number | Date }>,
): CatalogReviewPresentation;
