export function redactCredentialLocators(value) {
  if (Array.isArray(value)) return value.map(redactCredentialLocators);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (key === "secretRef" && child && typeof child === "object" && !Array.isArray(child)) {
      return [key, { kind: child.kind, configured: true }];
    }
    return [key, redactCredentialLocators(child)];
  }));
}

export function catalogForPresentation(catalog) {
  return redactCredentialLocators(catalog);
}
