export const WORKFLOW_CONTRACT_VERSION: 2;
export const WORKFLOW_CAPABILITIES: Readonly<{
  setupRun: 1;
  connectionReview: 1;
  guidedConfirmation: 1;
  taskObservation: 1;
}>;

export type WorkflowContract = Readonly<{
  contractVersion: 2;
  runtimeVersion: string;
  capabilities: typeof WORKFLOW_CAPABILITIES;
}>;

export function createWorkflowContract(runtimeVersion: string): WorkflowContract;
export function isWorkflowContract(value: unknown): value is WorkflowContract;
