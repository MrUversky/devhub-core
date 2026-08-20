import { readFile, stat } from "node:fs/promises";

import { buildDiscoveryInbox, DiscoveryInboxError } from "../lib/discovery-inbox.mjs";
import { readSourceCatalog } from "./catalog-tools.mjs";
import { resolveDevHubPaths } from "./devhub-config.mjs";

const maximumDocumentBytes = 1024 * 1024;

async function readJsonDocument(filename, label) {
  const details = await stat(filename);
  if (!details.isFile() || details.size > maximumDocumentBytes) throw new DiscoveryInboxError("invalid-discovery-input", `${label} must be a JSON file no larger than ${maximumDocumentBytes} bytes`);
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new DiscoveryInboxError("invalid-discovery-input", `${label} must contain valid JSON`);
    throw error;
  }
}

export async function runDiscoveryInbox(root, profileFilename, sessionFilename, reviewFilename = null, options = {}) {
  const paths = options.paths ?? resolveDevHubPaths(root);
  const [sourceCatalog, profiles, session, review] = await Promise.all([
    readSourceCatalog(paths.root, { paths }),
    readJsonDocument(profileFilename, "connection profiles"),
    readJsonDocument(sessionFilename, "setup session artifact"),
    reviewFilename ? readJsonDocument(reviewFilename, "discovery review") : null,
  ]);
  return buildDiscoveryInbox(sourceCatalog, session, profiles, review, { projectDirectory: paths.projectDirectory, now: options.now });
}

export function formatDiscoveryInbox(result) {
  const counts = Object.entries(result.summary.states).map(([state, count]) => `${count} ${state}`).join(", ");
  const lines = [
    `DevHub Discovery Inbox: ${counts}.`,
    `Artifact: ${result.artifactId}`,
    `Review prompts: ${result.summary.unansweredRequiredQuestions} grouped; ${result.summary.unansweredRequiredCandidateQuestions} candidates need a decision; proposals: ${result.summary.proposals}.`,
    "Read-only: no catalog or dashboard data was changed.",
  ];
  for (const group of result.questionGroups) {
    lines.push(`QUESTION ${group.id}: ${group.prompt}`);
    for (const candidate of group.candidates) lines.push(`  ${candidate.candidateId}: ${candidate.label}`);
  }
  for (const item of result.items) lines.push(`${item.state.toUpperCase()} ${item.candidateId}: ${item.reason}`);
  for (const proposal of result.proposals) {
    lines.push(`Candidate YAML for ${proposal.candidateId} (stdout only):`);
    lines.push(proposal.yaml.trimEnd());
  }
  return lines.join("\n");
}
