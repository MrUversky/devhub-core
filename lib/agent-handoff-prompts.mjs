const PORTFOLIO_SCOPE_LINES = Object.freeze({
  all: "Review the whole portfolio.",
  passport: "Focus on services with reviewed App Passport context.",
  "evidence-gap": "Focus on services with readiness evidence to review.",
  stewardship: "Focus on services with stewardship questions.",
});

function portfolioScopeLine(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Portfolio review options must contain exactly one scope.");
  }

  const keys = Object.keys(options);
  if (keys.length !== 1 || keys[0] !== "scope") {
    throw new TypeError("Portfolio review options must contain exactly one scope.");
  }

  if (typeof options.scope !== "string" || !Object.hasOwn(PORTFOLIO_SCOPE_LINES, options.scope)) {
    throw new TypeError(`Unsupported portfolio review scope: ${String(options.scope)}`);
  }
  return PORTFOLIO_SCOPE_LINES[options.scope];
}

export function buildPortfolioReviewAgentPrompt(options) {
  const scopeLine = portfolioScopeLine(options);
  return `Use the configured DevHub workflow to review this portfolio and choose its highest-priority reversible improvement.

${scopeLine} Read only the reviewed catalog and available fresh evidence. Summarize findings by state and check type; treat unknown as missing evidence, not a defect. Show one affected project or service, explain why it matters, give one safe next action, and ask at most one focused question if its answer cannot be discovered safely.

Prepare a minimal reviewed catalog diff or draft pull request only when reviewable evidence supports a change. Never include secrets, mutate providers, use hidden control actions, merge, or deploy automatically.`;
}

export function buildProjectRegistrationAgentPrompt() {
  return `Use the configured DevHub workflow to register or update the project in this task and its independently operated services.

Search the reviewed catalog first and reconcile the existing record instead of creating a duplicate. Inspect only safe local evidence. Keep unverified facts unknown; never invent URLs, hosts, health checks, commands, or operating guidance. Choose native or overlay registration from the actual ownership boundary. Ask at most one focused question if identity or ownership remains unclear.

Present the smallest reviewed catalog diff or draft pull request with validation results. Never include secrets, use hidden control actions, merge, or deploy automatically.`;
}
