# App Passport

## Purpose

An App Passport is the evidence-backed operating record for one runnable
service. It extends DevHub's answer from "where is it?" to "can I understand,
trust, operate and recover it?" without turning DevHub into a deployment,
monitoring or security platform.

The product promise is:

> Your coding agent can build and deploy it. DevHub helps you understand it,
> trust it, operate it, afford it and recover it.

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
