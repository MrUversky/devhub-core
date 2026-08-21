# App Passport

## Purpose

An App Passport is the evidence-backed operating record for one runnable
service. It helps a builder avoid losing the context behind what an agent
shipped. Git remembers its code; the passport helps DevHub remember the
reviewed context for how it runs. It shows whether monitoring, safety, cost and
recovery claims have evidence—and keeps them `unknown` when they do not. It
does not turn DevHub into a deployment, monitoring or security platform.

The existing catalog remains the source of reviewed intent. An App Passport is
made from that intent, current runtime status and optional reviewed readiness
evidence. Missing evidence is `unknown`; it never becomes a passing score.

## Questions the passport answers

1. What is this service for and where does it run?
2. Which entry points, runtime and data boundaries does it use?
3. Which operational safeguards have evidence, and how fresh is it?
4. What is missing before the service can meet its declared operating profile?
5. Where are the recovery instructions and who must act?

## Operating profiles

The profile sets context, not a universal compliance claim:

- `personal`: private software used by its owner.
- `internal`: software used inside a small team or business.
- `customer-facing`: software used by external customers.
- `sensitive`: software handling regulated, financial, health or similarly
  sensitive data.

DevHub does not infer a higher profile from a public URL. The owner or a
reviewed agent proposal selects it explicitly.

Projects with several services may declare `readinessDefaults` for `profile`,
`owner`, `dataClassification` and `costModel`. A service inherits only a field
it does not set itself, and the resolved passport exposes whether each value is
explicit on the service or inherited from the project. A service override
always wins. Defaults do not contain or inherit evidence, deployment facts or
dependencies.

Operational stewardship is modeled separately from the legacy free-text
`owner` context. Reviewed accountable, operator, billing and credential roles
use stable steward IDs, project defaults and explicit service overrides. See
[Stewardship](STEWARDSHIP.md). Existing owner fields remain backward
compatible and are never silently promoted into reviewed role evidence.

## Readiness evidence

Evidence is a typed list attached to a service. The first supported checks are:

- `monitoring`
- `alerting`
- `backup`
- `restore`
- `rollback`
- `security-review`
- `privacy`
- `ownership`
- `cost`
- `deployment`

Each item records:

- a state: `verified`, `declared`, `missing`, `not-applicable` or `unknown`;
- a provenance: `operator`, `agent`, `integration` or `catalog`;
- a concise human-readable note;
- optional observation and expiry timestamps;
- an optional reviewed HTTP(S) evidence link.

A `verified` item whose `validUntil` is in the past is displayed as stale. A
declaration is useful context but is never presented as verification. Unknown
is an honest first-class result.

An operator attestation uses the same evidence ledger, normally with
`source: operator`, `observedAt` and `validUntil`. A project-level owner default
does not become verified ownership evidence: each service that needs a current
ownership attestation records reviewed service evidence. This avoids a second
truth mechanism and keeps expiry visible. The inherited owner resolves the
accountability field, while the profile's `ownership` readiness check remains
`unknown` until service-specific evidence is recorded.

## Operating facts

The passport may also carry a small non-secret operating inventory:

- a human owner or accountable role;
- data classification: `none`, `internal`, `personal`, `sensitive`,
  `regulated` or `unknown`;
- a cost model: `free`, `fixed`, `metered` or `unknown`;
- deployment provider, reviewed revision, deployment time and evidence link;
- required, degraded-mode and optional dependencies such as data stores,
  authentication, payments, messaging, storage, AI models and external APIs.

These are reviewed facts, not credentials or provider configuration. A
dependency URL points to safe documentation, status or console context and
must never contain tokens or connection strings.

Credential inventory stores only typed external references and stewardship
metadata. Generated dashboard catalogs and MCP responses redact the reference
locator and show only its kind and configured state.

## Profile expectations

Profiles select explicit expected checks. They do not produce a percentage or
certification. Personal services focus on recovery, ownership, cost and
deployment. Internal services add monitoring. Customer-facing and sensitive
services expect the full first set of checks. An expected check with no
evidence is `unknown`; only reviewed evidence may call it `missing`, `verified`
or `not-applicable`.

The policy is versioned in `config/readiness-policy.json` so the dashboard,
MCP, CLI and portfolio review share one interpretation.

## User experience

The service detail panel shows a compact passport only after a service is
opened. Project cards remain lightweight.

The passport leads with the operating profile and a plain summary such as:

- `4 verified · 2 unknown`
- `Restore evidence is stale`
- `No readiness evidence registered`

Every item exposes its state, provenance, freshness and note. There is no
percentage score, green shield or "production ready" certification.

The same panel shows a compact recovery card for logs, deployment, rollback,
backup and restore, and ownership. It remains guidance: DevHub does not execute
recovery actions.

The next agent workflow is:

> Inspect this project and propose its DevHub registration and App Passport.

The agent may collect local evidence and propose a reviewed diff. It must not
invent integrations, claim a backup was restored, claim a security review
passed or write secrets into the manifest.

## Integration boundary

DevHub may ingest results from tools such as Sentry, Uptime Kuma, Better Stack,
GitHub security features, Codex Security and hosting providers. Those systems
remain responsible for scanning, monitoring, logs, billing and deployment.
DevHub stores only the reviewed result, source and freshness needed to explain
the overall operating picture.

All provider modules must pass through the shared
[read-only evidence adapter contract](EVIDENCE_ADAPTERS.md). That boundary
requires an exact reviewed project/service identity, resolves credentials only
from external environment configuration, normalizes uncached provider failures
to `unknown` and keeps stale last-known evidence visibly stale.

Exact-resource evidence is distinct from bounded provider inventory. Inventory
may discover an unregistered remote deployment or dependency; it produces a
review candidate rather than verified passport evidence. Only after the
candidate is matched, reviewed and merged may an exact binding refresh its
passport evidence. See [Provider inventory](PROVIDER_INVENTORY.md).

## Explicit non-goals

- No universal readiness score or certification.
- No secret values, provider tokens or connection strings.
- No arbitrary scanner or probe supplied by the browser.
- No logs, metrics, billing ledger or backup payload storage.
- No automatic production fix, restart, rollback or deployment.
- No claim that static analysis proves a service safe.
- No industry-specific compliance verdict.

## Definition of done for the first vertical slice

- The manifest schema and strict validator accept typed readiness evidence and
  reject unsafe URLs, invalid timestamps, duplicate evidence IDs and secrets.
- Dashboard, MCP and search expose the same normalized passport data.
- The detail panel explains missing, declared, verified and stale evidence
  without adding noise to project cards.
- The public demo and project template show realistic, fictional evidence.
- Reconciliation remains idempotent and does not invent readiness evidence.
- Documentation explains how an agent proposes evidence and how an operator
  reviews it.
