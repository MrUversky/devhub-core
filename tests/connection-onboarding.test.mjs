import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateConnectionOnboarding, validateGuidedConnectionCard } from "../lib/connection-onboarding.mjs";
import { getConnectionOnboardingPresentation } from "../lib/connection-onboarding-presentation.mjs";
import { createGitHubConnectionOnboarding } from "../lib/setup-connectors/github.mjs";
import { createConnectionOnboardingRegistry } from "../lib/setup-connectors/onboarding-registry.mjs";

const secureReference = { kind: "environment", locator: "FICTIONAL_ACCESS_REFERENCE" };

const validAnswers = Object.freeze({
  github: { scope: { kind: "organization", login: "fictional-org" }, owner: "Fictional operator" },
  "local-host": { scope: { hostId: "fictional-mac" }, owner: "Fictional operator" },
  vercel: { scope: { kind: "team", id: "team_fictionalstudio" }, credentialRef: secureReference, owner: "Fictional operator" },
  railway: { scope: { kind: "workspace", id: "11111111-1111-4111-8111-111111111111" }, credentialRef: secureReference, owner: "Fictional operator" },
  openai: { scope: { kind: "project", id: "proj_fictional", parent: { kind: "workspace", id: "org-fictional" } }, credentialRef: secureReference, owner: "Fictional operator" },
});

test("all and only runnable setup connectors expose one browser-safe guided acquisition contract", () => {
  const registry = createConnectionOnboardingRegistry();
  assert.deepEqual([...registry.keys()], ["github", "local-host", "vercel", "railway", "openai"]);
  assert.deepEqual([...registry.values()].map((entry) => [entry.connectorId, entry.acquisition]), [
    ["github", "existing-session"],
    ["local-host", "local-session"],
    ["vercel", "secure-stored-access"],
    ["railway", "secure-stored-access"],
    ["openai", "secure-stored-access"],
  ]);
  assert.equal(registry.has("sentry"), false, "evidence-only connectors must remain non-runnable");
  assert.equal(registry.has("cloudflare"), false, "planned connectors must remain non-runnable");

  for (const onboarding of registry.values()) {
    assert.equal(onboarding.guidedCard.actions.length, 3);
    assert.ok(onboarding.guidedCard.actions.every((action) => action.approval === "required"));
    assert.doesNotMatch(JSON.stringify(onboarding.guidedCard), /scope|reference|stored access|locator|generic-password|op:\/\/|https?:\/\/|\{\s*\\"|FICTIONAL_ACCESS_REFERENCE/i);
    const answer = onboarding.validateAnswer(validAnswers[onboarding.connectorId]);
    const profileInput = onboarding.createProfileInput(answer);
    assert.deepEqual(profileInput.scope, validAnswers[onboarding.connectorId].scope);
    assert.equal(profileInput.owner, "Fictional operator");
    assert.equal(profileInput.authorization.method, onboarding.acquisition === "secure-stored-access" ? "secret-reference" : onboarding.connectorId === "github" ? "cli-session" : "local-session");
  }
});

test("guided actions use plain human choices without implying automatic sign-in", () => {
  const registry = createConnectionOnboardingRegistry();
  assert.deepEqual(registry.get("github").guidedCard.actions.map((action) => action.label), ["Use current sign-in", "Help me sign in", "Not now"]);
  assert.deepEqual(registry.get("local-host").guidedCard.actions.map((action) => action.label), ["Inspect this computer", "Use another computer", "Not now"]);
  for (const connectorId of ["vercel", "railway", "openai"]) {
    const actions = registry.get(connectorId).guidedCard.actions;
    assert.deepEqual(actions.map((action) => action.label), ["Use a saved connection", "Help me connect", "Not now"]);
    const saved = actions.find((action) => action.id === "use-saved-connection");
    assert.match(saved.description, /reusable[\s\S]*configured for DevHub/i);
    assert.doesNotMatch(saved.description, /available to this task|current (?:sign-in|session)|plugin|OAuth/i);
  }
  const cards = JSON.stringify([...registry.values()].map((entry) => entry.guidedCard));
  assert.match(registry.get("github").guidedCard.actions[0].description, /already available to this task/i);
  assert.match(cards, /when available, or explain it, then pause while I sign in/i);
  assert.doesNotMatch(cards, /automatic|OAuth|capture|paste|credential|scope|reference|stored access/i);
});

test("connector-owned validators reject broadened or extra answers and preserve implemented session choice", () => {
  const registry = createConnectionOnboardingRegistry();
  assert.throws(() => registry.get("github").validateAnswer({ ...validAnswers.github, unexpected: "value" }), /supported object/i);
  assert.throws(() => registry.get("local-host").validateAnswer({ scope: { hostId: "../other" }, owner: "Fictional operator" }), /exact scope/i);
  assert.throws(() => registry.get("vercel").validateAnswer({ ...validAnswers.vercel, scope: { kind: "team", id: "broad" } }), /exact scope/i);
  assert.throws(() => registry.get("railway").validateAnswer({ ...validAnswers.railway, scope: { kind: "project", id: validAnswers.railway.scope.id } }), /exact scope/i);
  assert.throws(() => registry.get("openai").validateAnswer({ ...validAnswers.openai, scope: { kind: "project", id: "proj_fictional" } }), /exact scope/i);
  const app = createGitHubConnectionOnboarding("github-app");
  assert.equal(app.createProfileInput(app.validateAnswer(validAnswers.github)).authorization.method, "github-app");
  const overridden = createConnectionOnboardingRegistry([{ connectorId: "github", onboarding: app }]);
  assert.equal(overridden.get("github").createProfileInput(overridden.get("github").validateAnswer(validAnswers.github)).authorization.method, "github-app");
  assert.throws(() => createConnectionOnboardingRegistry([{ connectorId: "vercel", onboarding: app }]), /match connectorId/i);
});

test("guided cards reject technical locators, unimplemented single actions and implicit approval", () => {
  const base = {
    version: 1,
    title: "Connect example",
    description: "Review exact access.",
    actions: [
      { id: "review-scope", label: "Review scope", description: "Confirm one exact scope.", approval: "required" },
      { id: "run-check", label: "Run check", description: "Run the implemented bounded check.", approval: "required" },
    ],
  };
  assert.throws(() => validateGuidedConnectionCard({ ...base, description: "Paste locator here." }, "example"), /browser-safe/i);
  assert.throws(() => validateGuidedConnectionCard({ ...base, actions: base.actions.slice(0, 1) }, "example"), /2 or 3/i);
  assert.throws(() => validateGuidedConnectionCard({ ...base, actions: [{ ...base.actions[0], approval: "none" }, base.actions[1]] }, "example"), /approval/i);
});

test("runtime onboarding cannot drift from its pure browser presentation", () => {
  const canonical = createGitHubConnectionOnboarding();
  assert.deepEqual(canonical.guidedCard, getConnectionOnboardingPresentation("github").guidedCard);
  assert.throws(() => validateConnectionOnboarding({
    ...canonical,
    guidedCard: { ...canonical.guidedCard, title: "Different GitHub flow" },
  }), /canonical browser-safe presentation/i);
});

test("browser connector prompt import graph cannot reach provider, setup-session or Node modules", async () => {
  const pending = [new URL("../lib/connectors.mjs", import.meta.url)];
  const seen = new Set();
  while (pending.length) {
    const url = pending.pop();
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    const source = await readFile(url, "utf8");
    const specifiers = [...source.matchAll(/(?:import|export)\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g)].map((match) => match[1]);
    for (const specifier of specifiers) {
      assert.doesNotMatch(specifier, /^node:|setup-connectors|setup-session|inventory-adapters|evidence-adapters/, `${url.pathname} must stay browser-safe`);
      if (specifier.startsWith(".")) pending.push(new URL(specifier, url));
    }
  }
  assert.deepEqual([...seen].map((href) => new URL(href).pathname.split("/").at(-1)).sort(), ["connectors.mjs"]);
});
