import type { Catalog, CredentialInventoryItem, Project } from "./catalog";

export type PresentedCredentialInventoryItem = Omit<CredentialInventoryItem, "secretRef"> & {
  secretRef: { kind: CredentialInventoryItem["secretRef"]["kind"]; configured: true };
};
export type PresentedProject = Omit<Project, "credentials"> & { credentials?: PresentedCredentialInventoryItem[] };
export type PresentedCatalog = Omit<Catalog, "projects"> & { projects: PresentedProject[] };

export function redactCredentialLocators<T>(value: T): T;
export function catalogForPresentation(catalog: Catalog): PresentedCatalog;
