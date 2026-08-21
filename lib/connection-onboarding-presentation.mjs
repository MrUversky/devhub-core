const cardFields = new Set(["version", "title", "description", "actions"]);
const actionFields = new Set(["id", "label", "description", "approval"]);
const stableId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const unsafePresentation = /(?:\b(?:locator|token|password|secret|api[-_ ]?key)\b|\b(?:op|https?):\/\/|generic-password:|\{\s*"|\}\s*$)/i;

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requiredString(value, label, maximum = 240) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new TypeError(`${label} must be a non-empty bounded string`);
  return value.trim();
}

function exactFields(value, fields, label) {
  if (!plainObject(value)) throw new TypeError(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!fields.has(key)) throw new TypeError(`${label}.${key} is not supported`);
}

function safeString(value, label) {
  const normalized = requiredString(value, label);
  if (unsafePresentation.test(normalized)) throw new TypeError(`${label} must contain browser-safe human copy only`);
  return normalized;
}

export function validateGuidedConnectionCard(value, connectorId = "connector") {
  exactFields(value, cardFields, `${connectorId}.guidedCard`);
  if (value.version !== 1) throw new TypeError(`${connectorId}.guidedCard.version must be 1`);
  if (!Array.isArray(value.actions) || value.actions.length < 2 || value.actions.length > 3) {
    throw new TypeError(`${connectorId}.guidedCard.actions must contain 2 or 3 implemented actions`);
  }
  const ids = new Set();
  const actions = value.actions.map((action, index) => {
    const label = `${connectorId}.guidedCard.actions[${index}]`;
    exactFields(action, actionFields, label);
    const id = requiredString(action.id, `${label}.id`, 80);
    if (!stableId.test(id) || ids.has(id)) throw new TypeError(`${label}.id must be unique lowercase kebab-case`);
    ids.add(id);
    if (action.approval !== "required") throw new TypeError(`${label}.approval must be required`);
    return Object.freeze({ id, label: safeString(action.label, `${label}.label`), description: safeString(action.description, `${label}.description`), approval: "required" });
  });
  return Object.freeze({
    version: 1,
    title: safeString(value.title, `${connectorId}.guidedCard.title`),
    description: safeString(value.description, `${connectorId}.guidedCard.description`),
    actions: Object.freeze(actions),
  });
}

function card(title, description, actions) {
  return validateGuidedConnectionCard({
    version: 1,
    title,
    description,
    actions: actions.map((action) => ({ ...action, approval: "required" })),
  });
}

function presentation(connectorId, acquisition, guidedCard) {
  return Object.freeze({ formatVersion: 1, connectorId, acquisition, guidedCard });
}

/** Static browser-safe copy only. Runtime schemas, validators and provider collectors live elsewhere. */
export const CONNECTION_ONBOARDING_PRESENTATIONS = Object.freeze([
  presentation("github", "existing-session", card(
    "Connect GitHub",
    "Choose the GitHub account or organization you recognize.",
    [
      { id: "use-current-sign-in", label: "Use current sign-in", description: "Use the GitHub account already available to this task." },
      { id: "help-me-sign-in", label: "Help me sign in", description: "Open the supported sign-in setup when available, or explain it, then pause while I sign in." },
      { id: "not-now", label: "Not now", description: "Leave GitHub unconnected and continue later." },
    ],
  )),
  presentation("local-host", "local-session", card(
    "Connect this computer",
    "Choose the computer you want DevHub to inspect.",
    [
      { id: "inspect-this-computer", label: "Inspect this computer", description: "Run the bounded read-only checks on this computer." },
      { id: "use-another-computer", label: "Use another computer", description: "Pause so I can continue this task on another computer." },
      { id: "not-now", label: "Not now", description: "Skip this computer for now." },
    ],
  )),
  presentation("vercel", "secure-stored-access", card(
    "Connect Vercel",
    "Choose the Vercel account or team you recognize.",
    [
      { id: "use-saved-connection", label: "Use a saved connection", description: "Check a reusable Vercel connection already configured for DevHub." },
      { id: "help-me-connect", label: "Help me connect", description: "Open the supported setup when available, or explain it, then pause while I sign in." },
      { id: "not-now", label: "Not now", description: "Leave Vercel unconnected and continue later." },
    ],
  )),
  presentation("railway", "secure-stored-access", card(
    "Connect Railway",
    "Choose the Railway workspace or project you recognize.",
    [
      { id: "use-saved-connection", label: "Use a saved connection", description: "Check a reusable Railway connection already configured for DevHub." },
      { id: "help-me-connect", label: "Help me connect", description: "Open the supported setup when available, or explain it, then pause while I sign in." },
      { id: "not-now", label: "Not now", description: "Leave Railway unconnected and continue later." },
    ],
  )),
  presentation("openai", "secure-stored-access", card(
    "Connect OpenAI",
    "Choose the OpenAI workspace and project you recognize.",
    [
      { id: "use-saved-connection", label: "Use a saved connection", description: "Check a reusable OpenAI connection already configured for DevHub." },
      { id: "help-me-connect", label: "Help me connect", description: "Open the supported setup when available, or explain it, then pause while I sign in." },
      { id: "not-now", label: "Not now", description: "Leave OpenAI unconnected and continue later." },
    ],
  )),
]);

const presentationByConnector = new Map(CONNECTION_ONBOARDING_PRESENTATIONS.map((entry) => [entry.connectorId, entry]));

export function getConnectionOnboardingPresentation(connectorId) {
  return presentationByConnector.get(connectorId) ?? null;
}
