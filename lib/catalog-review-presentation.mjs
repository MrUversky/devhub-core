import { evaluateReadiness, resolveServiceReadinessContext } from "./readiness.mjs";
import { resolveServiceStewardshipContext } from "./stewardship.mjs";

const stableId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function canonicalId(value, label) {
  if (typeof value !== "string" || !stableId.test(value)) throw new TypeError(`${label} must be a stable kebab-case ID`);
  return value;
}

function normalizedNow(value) {
  const now = value === undefined ? new Date() : new Date(value);
  if (Number.isNaN(now.getTime())) throw new TypeError("catalog review presentation requires a valid now value");
  return now.toISOString();
}

function canonicalServiceRows(projects) {
  if (!Array.isArray(projects)) throw new TypeError("catalog review presentation requires a projects array");
  const projectIds = new Set();
  const serviceKeys = new Set();
  const rows = [];

  for (const [projectIndex, project] of projects.entries()) {
    if (!plainObject(project)) throw new TypeError(`projects[${projectIndex}] must be an object`);
    const projectId = canonicalId(project.id, `projects[${projectIndex}].id`);
    if (projectIds.has(projectId)) throw new TypeError(`duplicate catalog review project ID: ${projectId}`);
    projectIds.add(projectId);
    if (!Array.isArray(project.services)) throw new TypeError(`projects[${projectIndex}].services must be an array`);

    for (const [serviceIndex, service] of project.services.entries()) {
      if (!plainObject(service)) throw new TypeError(`projects[${projectIndex}].services[${serviceIndex}] must be an object`);
      const serviceId = canonicalId(service.id, `projects[${projectIndex}].services[${serviceIndex}].id`);
      const serviceKey = `${projectId}/${serviceId}`;
      if (serviceKeys.has(serviceKey)) throw new TypeError(`duplicate catalog review service key: ${serviceKey}`);
      serviceKeys.add(serviceKey);
      rows.push({ project, service, projectId, serviceKey });
    }
  }

  return { projectCount: projectIds.size, rows };
}

function scope(matches, totalServiceCount, { questions = true } = {}) {
  const ordered = [...matches].sort((left, right) => left.serviceKey < right.serviceKey ? -1 : left.serviceKey > right.serviceKey ? 1 : 0);
  return Object.freeze({
    matchingServiceCount: ordered.length,
    totalServiceCount,
    matchingProjectCount: new Set(ordered.map((item) => item.projectId)).size,
    serviceKeys: Object.freeze(ordered.map((item) => item.serviceKey)),
    questionGroupCount: questions ? ordered.length : 0,
    questionItemCount: questions ? ordered.reduce((total, item) => total + item.questionItemCount, 0) : 0,
  });
}

function stewardshipQuestionItemCount(context) {
  const roleItems = Object.values(context.roles).filter((role) => role.state === "missing" || role.state === "stale").length;
  const credentialOwnerItems = context.credentials.filter((credential) => credential.ownerState !== "reviewed").length;
  const credentialPayerItems = context.credentials.filter((credential) => credential.payerState !== "reviewed").length;
  const staleAccessItems = context.access.filter((fact) => fact.freshnessState === "stale").length;
  return roleItems
    + (context.summary.singlePersonRisk ? 1 : 0)
    + credentialOwnerItems
    + credentialPayerItems
    + staleAccessItems;
}

/**
 * Derive one deterministic browser-safe count and matching contract for catalog review UI.
 * Service IDs remain the navigation unit; question groups and individual issues are separate counts.
 */
export function deriveCatalogReviewPresentation(projects, options = {}) {
  if (!plainObject(options)) throw new TypeError("catalog review presentation options must be an object");
  for (const key of Object.keys(options)) if (key !== "now") throw new TypeError(`catalog review presentation option is not supported: ${key}`);
  const now = normalizedNow(options.now);
  const { projectCount, rows } = canonicalServiceRows(projects);
  const assessed = rows.map((row) => {
    const readiness = resolveServiceReadinessContext(row.project, row.service).readiness;
    const readinessAssessment = evaluateReadiness(readiness, { now });
    const stewardship = resolveServiceStewardshipContext(row.project, row.service, { now });
    return {
      ...row,
      hasPassport: Boolean(readiness),
      readinessQuestionItemCount: readinessAssessment.gaps.length,
      stewardshipQuestionItemCount: stewardshipQuestionItemCount(stewardship),
    };
  });
  const totalServiceCount = assessed.length;

  return Object.freeze({
    version: 1,
    universe: Object.freeze({ projectCount, serviceCount: totalServiceCount }),
    scopes: Object.freeze({
      passport: scope(assessed.filter((item) => item.hasPassport), totalServiceCount, { questions: false }),
      "evidence-gap": scope(assessed.filter((item) => item.readinessQuestionItemCount > 0).map((item) => ({
        ...item,
        questionItemCount: item.readinessQuestionItemCount,
      })), totalServiceCount),
      stewardship: scope(assessed.filter((item) => item.stewardshipQuestionItemCount > 0).map((item) => ({
        ...item,
        questionItemCount: item.stewardshipQuestionItemCount,
      })), totalServiceCount),
    }),
  });
}
