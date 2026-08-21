import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildPortfolioReviewAgentPrompt,
  buildProjectRegistrationAgentPrompt,
} from "../lib/agent-handoff-prompts.mjs";
import { buildConnectedSetupAgentPrompt } from "../lib/connectors.mjs";

const internalProtocol = /--json|setup-run|review-portfolio|connection-review|reviewId|questionId|answerSchema|credentialRef|locator|profile proposal/i;

function assertShortHumanPrompt(prompt) {
  assert.ok(prompt.length > 300 && prompt.length < 900, `expected a short human prompt, received ${prompt.length} characters`);
  assert.doesNotMatch(prompt, internalProtocol);
  assert.doesNotMatch(prompt, /automatically (?:publish|merge|deploy)|publish automatically/i);
  assert.match(prompt, /Never include secrets/i);
  assert.match(prompt, /do not|Never/i);
}

test("portfolio review handoff keeps finite dashboard scopes human and action-first", () => {
  const scopeLines = new Map([
    ["all", "Review the whole portfolio."],
    ["passport", "Focus on services with reviewed App Passport context."],
    ["evidence-gap", "Focus on services with readiness evidence to review."],
    ["stewardship", "Focus on services with stewardship questions."],
  ]);

  for (const [scope, scopeLine] of scopeLines) {
    const prompt = buildPortfolioReviewAgentPrompt({ scope });
    assertShortHumanPrompt(prompt);
    assert.match(prompt, new RegExp(scopeLine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(prompt, /highest-priority reversible improvement/i);
    assert.match(prompt, /findings by state and check type/i);
    assert.match(prompt, /unknown as missing evidence, not a defect/i);
    assert.match(prompt, /one affected project or service/i);
    assert.match(prompt, /one safe next action/i);
    assert.match(prompt, /at most one focused question/i);
    assert.match(prompt, /minimal reviewed catalog diff or draft pull request/i);
    assert.match(prompt, /Never include secrets, mutate providers, use hidden control actions, merge, or deploy automatically/i);
    assert.doesNotMatch(prompt, /register or update the project|native or overlay|selected sources/i);
  }
});

test("portfolio review handoff rejects free-form, stale-count, and identity scope input", () => {
  for (const options of [
    undefined,
    null,
    {},
    { scope: "project" },
    { scope: "toString" },
    { scope: "__proto__" },
    { scope: "all", query: "customer" },
    { scope: "stewardship", count: 23 },
    { scope: "evidence-gap", serviceId: "example" },
  ]) {
    assert.throws(() => buildPortfolioReviewAgentPrompt(options), /scope/i);
  }
});

test("project registration handoff stays bounded to current-project reconciliation", () => {
  const prompt = buildProjectRegistrationAgentPrompt();
  assertShortHumanPrompt(prompt);
  assert.match(prompt, /project in this task and its independently operated services/i);
  assert.match(prompt, /Search the reviewed catalog first/i);
  assert.match(prompt, /reconcile the existing record instead of creating a duplicate/i);
  assert.match(prompt, /Keep unverified facts unknown/i);
  assert.match(prompt, /never invent URLs, hosts, health checks, commands, or operating guidance/i);
  assert.match(prompt, /native or overlay registration from the actual ownership boundary/i);
  assert.match(prompt, /at most one focused question/i);
  assert.match(prompt, /smallest reviewed catalog diff or draft pull request with validation results/i);
  assert.match(prompt, /Never include secrets, use hidden control actions, merge, or deploy automatically/i);
  assert.doesNotMatch(prompt, /portfolio|App Passport context|selected sources/i);
});

test("operational handoffs preserve the selected-only Connected Setup authority boundary", () => {
  const prompt = buildConnectedSetupAgentPrompt(["github", "local-host", "vercel", "railway", "openai"]);
  assert.equal(prompt.length, 899);
  assert.equal(prompt.split("\n").length, 5);
  assert.match(prompt, /these selected sources: GitHub, This computer, Vercel, Railway, OpenAI/);
  assert.match(prompt, /Selection authorizes safe read-only checks through callable plugins, existing sign-ins, and this computer/);
  assert.match(prompt, /Run them before asking how to connect/);
  assert.match(prompt, /With one scope, continue; with several, ask one plain-language choice/);
  assert.match(prompt, /Saving is optional and comes only after results/);
});

test("agent handoff prompt module stays pure and browser-safe", async () => {
  const source = await readFile(new URL("../lib/agent-handoff-prompts.mjs", import.meta.url), "utf8");
  assert.deepEqual([...source.matchAll(/from\s+["']([^"']+)["']/g)], []);
  assert.doesNotMatch(source, /node:|process\.|setup-session|provider adapter|credentialRef|locator/i);
});
