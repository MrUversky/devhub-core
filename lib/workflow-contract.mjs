const contractFields = new Set(["contractVersion", "runtimeVersion", "capabilities"]);
const capabilityFields = new Set(["setupRun", "connectionReview", "guidedConfirmation", "taskObservation"]);
const runtimeVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export const WORKFLOW_CONTRACT_VERSION = 2;
export const WORKFLOW_CAPABILITIES = Object.freeze({
  setupRun: 1,
  connectionReview: 1,
  guidedConfirmation: 1,
  taskObservation: 1,
});

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactFields(value, expected) {
  return plainObject(value)
    && Object.keys(value).length === expected.size
    && Object.keys(value).every((key) => expected.has(key));
}

export function createWorkflowContract(runtimeVersion) {
  if (typeof runtimeVersion !== "string" || !runtimeVersionPattern.test(runtimeVersion)) {
    throw new TypeError("runtimeVersion must be a semantic package version");
  }
  return Object.freeze({
    contractVersion: WORKFLOW_CONTRACT_VERSION,
    runtimeVersion,
    capabilities: WORKFLOW_CAPABILITIES,
  });
}

export function isWorkflowContract(value) {
  return hasExactFields(value, contractFields)
    && value.contractVersion === WORKFLOW_CONTRACT_VERSION
    && typeof value.runtimeVersion === "string"
    && runtimeVersionPattern.test(value.runtimeVersion)
    && hasExactFields(value.capabilities, capabilityFields)
    && Object.entries(WORKFLOW_CAPABILITIES).every(([capability, version]) => value.capabilities[capability] === version);
}
