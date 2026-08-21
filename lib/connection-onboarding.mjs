import { getConnectionOnboardingPresentation, validateGuidedConnectionCard } from "./connection-onboarding-presentation.mjs";
export { validateGuidedConnectionCard } from "./connection-onboarding-presentation.mjs";

const acquisitions = new Set(["existing-session", "local-session", "secure-stored-access"]);
const onboardingFields = new Set(["formatVersion", "connectorId", "acquisition", "guidedCard", "answerSchema", "validateAnswer", "createProfileInput"]);
const answerFields = new Set(["scope", "credentialRef", "owner"]);
const credentialRefFields = new Set(["kind", "locator"]);
const credentialKinds = new Set(["environment", "keychain", "secret-manager"]);
const stableId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const environmentName = /^[A-Z_][A-Z0-9_]{0,127}$/;
const keychainLocator = /^generic-password:[A-Za-z0-9._@+-]{1,100}:[A-Za-z0-9._@+-]{1,100}$/;
const onePasswordLocator = /^op:\/\/[A-Za-z0-9._ -]{1,100}\/[A-Za-z0-9._ -]{1,100}\/[A-Za-z0-9._ -]{1,100}$/;

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export class ConnectionOnboardingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ConnectionOnboardingError";
    this.code = code;
  }
}

function exactFields(value, fields, label) {
  if (!plainObject(value)) throw new TypeError(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!fields.has(key)) throw new TypeError(`${label}.${key} is not supported`);
}

function requiredString(value, label, maximum = 240) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new TypeError(`${label} must be a non-empty bounded string`);
  }
  return value.trim();
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

export function validateConnectionOnboarding(value) {
  exactFields(value, onboardingFields, "connection onboarding");
  if (value.formatVersion !== 1) throw new TypeError("connection onboarding.formatVersion must be 1");
  const connectorId = requiredString(value.connectorId, "connection onboarding.connectorId", 100);
  if (!stableId.test(connectorId)) throw new TypeError("connection onboarding.connectorId must use lowercase kebab-case");
  if (!acquisitions.has(value.acquisition)) throw new TypeError(`${connectorId}.acquisition is not supported`);
  if (!plainObject(value.answerSchema)) throw new TypeError(`${connectorId}.answerSchema must be an object`);
  if (typeof value.validateAnswer !== "function" || typeof value.createProfileInput !== "function") {
    throw new TypeError(`${connectorId} onboarding must validate answers and create profile input`);
  }
  const guidedCard = validateGuidedConnectionCard(value.guidedCard, connectorId);
  const canonical = getConnectionOnboardingPresentation(connectorId);
  if (canonical && (canonical.acquisition !== value.acquisition || JSON.stringify(canonical.guidedCard) !== JSON.stringify(guidedCard))) {
    throw new TypeError(`${connectorId} onboarding must match its canonical browser-safe presentation`);
  }
  return freeze({
    formatVersion: 1,
    connectorId,
    acquisition: value.acquisition,
    guidedCard,
    answerSchema: structuredClone(value.answerSchema),
    validateAnswer: value.validateAnswer,
    createProfileInput: value.createProfileInput,
  });
}

function sessionAnswerSchema(scopeSchema) {
  return freeze({
    type: "object",
    additionalProperties: false,
    required: ["scope", "owner"],
    properties: { scope: structuredClone(scopeSchema), owner: { type: "string", minLength: 1, maxLength: 200 } },
  });
}

function secureAnswerSchema(scopeSchema) {
  return freeze({
    type: "object",
    additionalProperties: false,
    required: ["scope", "credentialRef", "owner"],
    properties: {
      scope: structuredClone(scopeSchema),
      credentialRef: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "locator"],
        properties: { kind: { enum: ["environment", "keychain", "secret-manager"] }, locator: { type: "string" } },
      },
      owner: { type: "string", minLength: 1, maxLength: 200 },
    },
  });
}

/** Build a connector-owned, strict setup acquisition contract without provider-specific core branches. */
export function createScopedConnectionOnboarding({ connectorId, acquisition, authorizationMethod, scopeSchema, validateScope, guidedCard }) {
  if (typeof validateScope !== "function") throw new TypeError(`${connectorId}.validateScope must be a function`);
  const needsStoredAccess = acquisition === "secure-stored-access";
  const expectedFields = needsStoredAccess ? answerFields : new Set(["scope", "owner"]);
  return validateConnectionOnboarding({
    formatVersion: 1,
    connectorId,
    acquisition,
    guidedCard,
    answerSchema: needsStoredAccess ? secureAnswerSchema(scopeSchema) : sessionAnswerSchema(scopeSchema),
    validateAnswer(value) {
      let owner;
      try {
        exactFields(value, expectedFields, `${connectorId} connection answer`);
        owner = requiredString(value.owner, `${connectorId} connection answer.owner`, 200);
      } catch {
        throw new ConnectionOnboardingError("answer-invalid", `${connectorId} connection answer is not an exact supported object`);
      }
      if (!plainObject(value.scope) || !validateScope(value.scope)) {
        throw new ConnectionOnboardingError("scope-invalid", `${connectorId} connection answer requires one supported exact scope`);
      }
      if (needsStoredAccess) {
        try {
          exactFields(value.credentialRef, credentialRefFields, `${connectorId} connection answer.credentialRef`);
          const kind = requiredString(value.credentialRef.kind, `${connectorId} connection answer.credentialRef.kind`, 30);
          const locator = requiredString(value.credentialRef.locator, `${connectorId} connection answer.credentialRef.locator`, 300);
          const validLocator = kind === "environment" ? environmentName.test(locator)
            : kind === "keychain" ? keychainLocator.test(locator)
              : kind === "secret-manager" ? onePasswordLocator.test(locator)
                : false;
          if (!credentialKinds.has(kind) || !validLocator) throw new TypeError("unsupported stored-access reference");
        } catch {
          throw new ConnectionOnboardingError("answer-invalid", `${connectorId} connection answer requires one supported stored-access reference`);
        }
      }
      return freeze({
        scope: structuredClone(value.scope),
        ...(needsStoredAccess ? { credentialRef: structuredClone(value.credentialRef) } : {}),
        owner,
      });
    },
    createProfileInput(answer) {
      return freeze({
        authorization: {
          method: authorizationMethod,
          ...(needsStoredAccess ? { credentialRef: structuredClone(answer.credentialRef) } : {}),
        },
        scope: structuredClone(answer.scope),
        owner: answer.owner,
      });
    },
  });
}
