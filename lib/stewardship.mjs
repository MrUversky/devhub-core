export const STEWARDSHIP_ROLES = Object.freeze([
  "accountableOwner",
  "operator",
  "billingOwner",
  "credentialOwner",
]);

function asNow(value) {
  const now = value === undefined ? new Date() : new Date(value);
  if (Number.isNaN(now.getTime())) throw new TypeError("stewardship resolution requires a valid now value");
  return now;
}

function isStale(fact, now) {
  if (!fact?.validUntil) return false;
  const deadline = Date.parse(fact.validUntil);
  return Number.isFinite(deadline) && deadline < now.getTime();
}

function resolveSteward(stewards, id) {
  return id ? stewards.get(id) ?? null : null;
}

function stewardState(steward, now) {
  return !steward ? "missing" : isStale(steward, now) ? "stale" : "reviewed";
}

export function resolveAccessFacts(project, options = {}) {
  const now = asNow(options.now);
  return (project?.access ?? []).map((fact) => {
    const freshnessState = isStale(fact, now) ? "stale" : "reviewed";
    return {
      ...fact,
      recordedAccess: fact.access,
      access: freshnessState === "stale" ? "unknown" : fact.access,
      freshnessState,
    };
  });
}

export function resolveCredentialInventory(project, options = {}) {
  const now = asNow(options.now);
  const stewardDirectory = new Map((project?.stewards ?? []).map((steward) => [steward.id, steward]));
  return (project?.credentials ?? []).map((credential) => {
    const ownerSteward = resolveSteward(stewardDirectory, credential.owner);
    const payerSteward = resolveSteward(stewardDirectory, credential.payer);
    return {
      ...credential,
      ownerSteward,
      payerSteward,
      ownerState: stewardState(ownerSteward, now),
      payerState: credential.payer ? stewardState(payerSteward, now) : "missing",
      verificationState: credential.rotationDueAt && Date.parse(credential.rotationDueAt) < now.getTime()
        ? "rotation-due"
        : !credential.lastVerifiedAt
          ? "unknown"
          : "reviewed",
    };
  });
}

export function resolveServiceStewardshipContext(project, service, options = {}) {
  const now = asNow(options.now);
  const stewardDirectory = new Map((project?.stewards ?? []).map((steward) => [steward.id, steward]));
  const defaults = project?.stewardshipDefaults ?? {};
  const overrides = service?.stewardship ?? {};
  const roles = {};

  for (const role of STEWARDSHIP_ROLES) {
    const hasOverride = Object.hasOwn(overrides, role);
    const provenance = hasOverride
      ? overrides[role] === null ? "explicit-unknown" : "service"
      : defaults[role] !== undefined
        ? "project"
        : "absent";
    const stewardId = hasOverride ? overrides[role] : defaults[role] ?? null;
    const steward = resolveSteward(stewardDirectory, stewardId);
    roles[role] = {
      stewardId,
      steward,
      provenance,
      state: stewardState(steward, now),
    };
  }

  const credentials = resolveCredentialInventory(project, { now })
    .filter((credential) => credential.consumers.includes(service?.id));
  const access = resolveAccessFacts(project, { now });

  const reviewedPeople = new Set(
    Object.values(roles)
      .filter((role) => role.state === "reviewed" && role.steward?.kind === "person")
      .map((role) => role.stewardId),
  );
  const reviewedRoleCount = Object.values(roles).filter((role) => role.state === "reviewed").length;
  const sharedRoleCount = Object.values(roles).filter((role) => role.state === "reviewed" && role.steward?.kind === "team").length;

  return {
    evaluatedAt: now.toISOString(),
    roles,
    credentials,
    access,
    summary: {
      reviewed: reviewedRoleCount,
      missing: Object.values(roles).filter((role) => role.state === "missing").length,
      stale: Object.values(roles).filter((role) => role.state === "stale").length,
      shared: sharedRoleCount,
      singlePersonRisk: reviewedRoleCount >= 2 && sharedRoleCount === 0 && reviewedPeople.size === 1,
      credentials: credentials.length,
      credentialsWithUnknownPayer: credentials.filter((credential) => credential.payerState !== "reviewed").length,
      credentialsWithStaleOwner: credentials.filter((credential) => credential.ownerState === "stale").length,
      staleAccess: access.filter((fact) => fact.freshnessState === "stale").length,
    },
  };
}

export function stewardshipSearchTerms(project, service) {
  const context = resolveServiceStewardshipContext(project, service);
  return [
    ...Object.values(context.roles).flatMap((role) => [role.stewardId, role.steward?.name, role.steward?.kind, role.state]),
    ...context.credentials.flatMap((credential) => [
      credential.id,
      credential.provider,
      credential.purpose,
      credential.secretRef.kind,
      credential.ownerSteward?.name,
      credential.ownerState,
      credential.payerSteward?.name,
      credential.payerState,
      credential.verificationState,
    ]),
    ...context.access.flatMap((fact) => [fact.id, fact.kind, fact.subject, fact.access, fact.freshnessState, fact.note]),
  ].filter(Boolean);
}
