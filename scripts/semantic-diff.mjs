function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function sortSemantic(value) {
  if (Array.isArray(value)) return value.map(sortSemantic);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortSemantic(value[key])]));
}

export function semanticEqual(left, right) {
  return JSON.stringify(sortSemantic(left)) === JSON.stringify(sortSemantic(right));
}

function childPath(parent, key, array = false) {
  if (array) return `${parent}[${key}]`;
  return parent ? `${parent}.${key}` : String(key);
}

export function semanticDiff(catalogValue, projectValue, fieldPath = "") {
  if (semanticEqual(catalogValue, projectValue)) return [];

  if (Array.isArray(catalogValue) && Array.isArray(projectValue)) {
    const changes = [];
    const length = Math.max(catalogValue.length, projectValue.length);
    for (let index = 0; index < length; index += 1) {
      const path = childPath(fieldPath, index, true);
      if (index >= catalogValue.length) {
        changes.push({ path, state: "added", project: projectValue[index] });
      } else if (index >= projectValue.length) {
        changes.push({ path, state: "removed", catalog: catalogValue[index] });
      } else {
        changes.push(...semanticDiff(catalogValue[index], projectValue[index], path));
      }
    }
    return changes;
  }

  if (isObject(catalogValue) && isObject(projectValue)) {
    const changes = [];
    const keys = [...new Set([...Object.keys(catalogValue), ...Object.keys(projectValue)])].sort();
    for (const key of keys) {
      const path = childPath(fieldPath, key);
      if (!Object.hasOwn(catalogValue, key)) {
        changes.push({ path, state: "added", project: projectValue[key] });
      } else if (!Object.hasOwn(projectValue, key)) {
        changes.push({ path, state: "removed", catalog: catalogValue[key] });
      } else {
        changes.push(...semanticDiff(catalogValue[key], projectValue[key], path));
      }
    }
    return changes;
  }

  return [{ path: fieldPath || "$root", state: "changed", catalog: catalogValue, project: projectValue }];
}
