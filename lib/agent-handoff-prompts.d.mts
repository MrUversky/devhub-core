export type PortfolioReviewScope = "all" | "passport" | "evidence-gap" | "stewardship";

export function buildPortfolioReviewAgentPrompt(options: Readonly<{
  scope: PortfolioReviewScope;
}>): string;

export function buildProjectRegistrationAgentPrompt(): string;
