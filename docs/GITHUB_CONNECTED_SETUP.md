# GitHub Connected Setup

GitHub Connected Setup discovers accessible repositories inside one explicit
personal or organization scope. It is a bounded read-only observation for
**Build my map**, not a GitHub control plane and not proof of ownership.

## Authorization choices

The same provider connector supports two reviewed execution paths:

- **Existing `gh` session** (`cli-session`) uses an injected runner that calls
  only `gh api --method GET` for allowlisted identity and repository paths.
  DevHub never asks `gh` for its token, copies a token or reads CLI config.
- **GitHub App** (`github-app`) uses an injected authorized request transport.
  Browser authorization is the ceremony that produces or reviews the App
  installation; the dashboard never receives the installation credential.

The stored connection profile contains only the method and explicit scope. An
authorization or transport descriptor is metadata, not a credential. The
transport is injected into the on-demand Setup Runner and disappears when the
session ends. DevHub does not begin OAuth or GitHub App installation
automatically.

## Explicit scope

A profile selects exactly one scope:

```json
{
  "kind": "user",
  "login": "octo-builder"
}
```

or:

```json
{
  "kind": "organization",
  "login": "acme-example"
}
```

For a personal scope the authenticated `/user` identity must match the
reviewed login. For an organization scope DevHub separately verifies the
organization identity and requires every returned repository owner to match
it. Personal and organization access are never silently combined. A user who
needs both adds two reviewed profiles.

## Normalized observation

The provider payload is reduced immediately to:

- authenticated GitHub account ID, login and account kind;
- reviewed scope ID, login and kind;
- repository ID, owner, name, safe canonical URL, visibility, archived and
  disabled state;
- coarse observed repository access: `admin`, `write`, `read` or `unknown`;
- explicit limitations and the IDs of existing exact GitHub evidence
  adapters that can be used after a workflow, release or deployment identity
  is reviewed.

Descriptions, topics, emails, commit messages, Actions logs, issues, raw
provider errors and all other response fields are discarded. Repository
access never becomes a claim about human, business or billing ownership.
Repository identity is only a candidate for exact, possible or new-project
reconciliation handled by the review layer.

The existing adapters remain the only path to verified GitHub evidence:

- `github-actions-deployment-v1` for an exact reviewed deployment;
- `github-release-deployment-v1` for exact immutable released source;
- `github-actions-workflow-monitoring-v1` for one exact workflow and branch.

Repository enumeration does not weaken their identity requirements or turn a
repository into verified deployment or monitoring evidence.

## Bounds and failure behavior

Every collection has reviewed repository, page, response-byte and deadline
limits. It uses GitHub's fixed API through the transport, page size 100 and
read-only calls. If a limit is reached before enumeration is complete, the
entire result is `unknown`; DevHub never presents a partial list as complete.

Missing or revoked CLI authorization is classified separately from provider
permission denial, rate limiting and network/DNS/TLS failure. Each returns no
repository candidates and a narrow safe next step: reconnect for authentication
or access, retry after the provider window for rate limiting, or retry from a
network-enabled environment for transport failure. Raw CLI errors are never
returned. Timeouts, malformed responses, scope mismatches and repositories
whose owner falls outside the reviewed scope also fail closed. Absence from an
inaccessible or partial observation never means deleted, unused or safe to
clean up.

The connector performs no repository, workflow, deployment or catalog
mutation. A discovered repository becomes durable DevHub context only through
a separately reviewed, validated catalog proposal.

## Agent and dashboard parity

Codex, Claude Code, Cursor, CLI and the dashboard all delegate to the same
`github` Setup Runner connector. The current dashboard does not initiate a
GitHub authorization or provider request. It can show the last redacted
reviewed status and include GitHub in a bounded request that the user pastes
into a coding-agent task. The agent reviews the exact user or organization
scope before the on-demand runner acts. Every surface ultimately receives the
same normalized setup-session observations and limitations; none receives
credentials or raw provider payloads.

The preferred agent entry point is `devhub setup-run --sources github --json`.
It contacts GitHub only when an exact reviewed GitHub profile exists. A stale
or authorization-required profile is rechecked within the same bounded run;
success clears generic reconnect attention, while failure yields one specific
connector question. Candidate questions bind to the actual Discovery Inbox artifact.

See [Connected Setup](CONNECTED_SETUP.md),
[GitHub evidence adapters](GITHUB_EVIDENCE_ADAPTERS.md) and
[Coding-agent integrations](INTEGRATIONS_AGENTS.md).
