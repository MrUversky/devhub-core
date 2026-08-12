import path from "node:path";

export function resolveDevHubPaths(root = process.cwd(), environment = {}) {
  const resolvedRoot = path.resolve(root);
  const catalogDirectory = path.resolve(environment.DEVHUB_CATALOG_DIR || path.join(resolvedRoot, "catalog"));
  return {
    root: resolvedRoot,
    catalogDirectory,
    hostsPath: path.join(catalogDirectory, "hosts.yaml"),
    projectDirectory: path.join(catalogDirectory, "projects"),
    generatedOutputs: [
      path.join(resolvedRoot, "app/generated/catalog.json"),
      path.join(resolvedRoot, "public/catalog.json"),
    ],
  };
}

export function runtimeHostId(environment = process.env) {
  const value = environment.DEVHUB_HOST_ID?.trim();
  return value || null;
}

export function registryRepository(environment = process.env) {
  const value = environment.DEVHUB_REGISTRY_REPOSITORY?.trim();
  return value || null;
}
