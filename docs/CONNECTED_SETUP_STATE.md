# Connected Setup state and refresh

Connected Setup completion is an evidence conclusion, not an onboarding flag.
An existing catalog, a browser visit or a session that labels itself complete
cannot establish that setup is complete.

The dashboard presentation follows the same rule. Its generated connection
snapshot is a redacted projection of reviewed profiles: connector ID, state,
observation time and freshness deadline only. It never contains scope,
account, owner or authorization-reference metadata. The public demo ships an
explicit empty snapshot rather than private instance state.

The dashboard renders this evidence as source status—**Last check succeeded**,
**Check expired**, **Access needed**, **Unavailable**, **Unknown** or **Not
configured**—separately from **Include in this run**. The latter only adds a
source to a request for a later coding-agent task. It is not a connection or
job state, and the read-only dashboard never shows simulated Queued or Running
progress.

Generated catalogs also carry a small presentation identity: `private` or
`demo`. It controls labels and actions, never authorization. The private mode
shows real redacted profile state for the current workspace; demo mode shows a
connector preview and cannot imply that a visitor's accounts are connected.

`lib/setup-state.mjs` provides the provider-neutral state engine used after an
on-demand setup session. It does not run providers, write connection profiles,
change the catalog or schedule background work.

The CLI reads bounded JSON artifacts and exposes the same strict engine:

```bash
npm run devhub -- setup-state \
  ./connection-profiles.json \
  ./setup-session.json \
  --availability-review ./availability-review.json \
  --discovery-review ./discovery-review.json \
  --json
```

Both optional inputs are named so their meaning cannot depend on positional
guessing. They may be omitted independently or supplied in either order. A
caller cannot supply a normalized Discovery Inbox: when a discovery review is
present, the CLI rebuilds the Inbox from the current validated catalog, exact
profiles and exact setup-session artifact, then binds the review to the
resulting artifact ID. No command in this document writes any input file.

## Completion rule

The conservative v0.9 rule is:

1. at least one reviewed connection profile exists;
2. every selected profile has either a fresh `connected` observation or an
   `accepted-unavailable` decision tied to the exact profile and session;
3. when a Discovery Inbox is supplied, it has no required unanswered
   questions, no review-required or unresolved items, and no pending proposal.

This intentionally treats all selected profiles as part of one setup promise.
A stale or unknown result on any selected profile keeps the overall state
`review-required`. A builder can remove or disable an irrelevant connection
through a reviewed profile proposal rather than hiding the unresolved result.

An unavailable acceptance records reviewer, reason and review time. It is valid
only for the unavailable result in the named session, must be reviewed after
that session completed, and is bound to a fingerprint of connector, exact
scope, owner, authorization method/reference and freshness lifetime. It does
not make provider evidence fresh or prove that resources are absent.

## Canonical trust boundary

`validateSetupSessionArtifact(session, profiles, { now })` is the shared strict
validator for downstream setup workflows, including Discovery Inbox. It:

- rejects unknown fields at the session, result, reviewed-connection and
  evidence levels;
- requires read-only, non-persistent safety fields and ordered timestamps;
- requires `freshUntil` to equal `observedAt` plus the reviewed profile TTL;
- pins connector, owner, exact scope and authorization reference to the
  reviewed profile;
- validates only allowlisted GitHub, local-host and normalized provider
  inventory observation shapes;
- validates normalized inventory with the existing inventory contract and
  requires its provider and scope to match the profile;
- rejects secret-shaped content and bounds the complete input to 1 MiB, with a
  512 KiB per-result observation bound.

The normalized return preserves `sessionId`, `startedAt`, `completedAt`,
`status` and strict results. Downstream review timestamps can therefore be
checked against the actual session completion time.

## Refresh my DevHub

`createSetupRefreshPlan()` copies the reviewed profiles' exact scope and
authorization-reference metadata into a read-only one-shot plan. The caller
must run the ordinary Setup Runner with those profiles; refresh never broadens
scope or changes a credential reference.

`compareSetupRefresh()` compares strict previous and current session artifacts
by the deterministic identity tuple:

```text
profileId + provider + resourceType + resourceId
```

It emits only:

- `new` — a fresh exact identity appeared;
- `changed` — meaningful normalized metadata changed;
- `stale` — the current observation is no longer fresh;
- `unclear` — access failed, identity was insufficient, or a previous identity
  was not returned.

Observation timestamps alone do not create change noise. A missing identity is
never reported as deleted, unused or safe to clean up.

```bash
npm run devhub -- setup-refresh \
  ./connection-profiles.json \
  ./previous-setup-session.json \
  ./current-setup-session.json \
  --json
```

## Disconnect

`proposeConnectionDisconnect()` creates a reviewed `remove` or `disable`
proposal for one connection profile. It performs no write. Catalog records,
provider resources and evidence history remain preserved; disconnect never
means provider deletion.

```bash
npm run devhub -- setup-disconnect \
  ./connection-profiles.json \
  github-personal \
  ./disconnect-request.json \
  --json
```

The request document has exactly `reviewedBy`, `requestedAt`, `reason` and
`action` (`remove` or `disable`). The output is a fingerprint-bound proposal
with `apply: false`; changing the reviewed profile remains a separate Git-
reviewed operation.

There is no background synchronization or resident daemon in this slice.
Refresh remains an explicit on-demand action from the dashboard, CLI or coding
agent and uses the same reviewed profiles and trust boundary.
