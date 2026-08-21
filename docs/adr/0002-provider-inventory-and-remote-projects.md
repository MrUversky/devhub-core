# ADR 0002: Provider inventory and remote-only projects

- Status: Accepted for implementation
- Date: 2026-08-13

## Context

The v0.7 evidence adapter contract safely observes an exact resource that is
already bound to a reviewed project and service. That is insufficient when a
coding agent created a Railway, Vercel or other provider resource that is not
yet in DevHub, or when the owner has provider access but no local checkout or
repository access.

Using the exact evidence adapter for account enumeration would weaken its
identity boundary. Requiring every project to originate from a local directory
or Git repository would also misrepresent managed, client-owned and
console-created resources.

## Decision

DevHub will add a separate read-only `inventory` adapter capability.

- Inventory adapters enumerate only an explicitly configured account, team,
  workspace or project scope.
- They return normalized candidates, never catalog facts or provider objects.
- Candidates reach the catalog only through deterministic matching, a proposed
  YAML diff, review, validation and Git history.
- Remote-only projects are valid `overlay` projects. `repository` and
  `workspaces` remain optional.
- Exact evidence adapters remain responsible for fresh observations of a
  reviewed resource.
- Provider-specific identity and credentials remain in external binding
  configuration; secret values never enter manifests or normalized output.
- Access, credential and cost integrations expose metadata and evidence only.
  DevHub does not become an IAM system, secret manager or billing ledger.

The normalized model separates a logical project/component from deployment
instances and provider resources. Existing service IDs remain stable and
backward-compatible; grouping fields are additive.

## Consequences

Positive:

- DevHub can discover and enrich resources without local code or GitHub.
- Railway, Vercel and future providers share one reconciliation workflow.
- Unregistered and ambiguous resources become reviewable without unsafe
  automatic registration.
- Team ownership, access and cost context can be added without storing secrets.

Trade-offs:

- Provider inventory requires broader read access than exact-resource
  evidence, so scope and pagination must be explicit and bounded.
- Provider object models differ; at least two implementations are required
  before the generic contract is considered stable.
- A provider may report a resource that DevHub cannot confidently match. The
  correct result is a candidate requiring review, not an inferred project.
- Fresh inventory is transient. Only reviewed facts appear in dashboard and
  MCP, so enrichment is intentionally not instantaneous.

## Rejected alternatives

### Put provider payloads directly in project YAML

Rejected because payloads are unstable, provider-specific and may contain
sensitive configuration.

### Let providers automatically create or delete catalog records

Rejected because preview resources, renamed projects and access limitations can
produce destructive false conclusions.

### Require a repository or local workspace for every project

Rejected because managed services, inaccessible repositories and resources
created directly in provider consoles are legitimate operational objects.

### Turn DevHub into a secret manager or deployment control plane

Rejected because it concentrates credentials and blast radius. DevHub records
references, ownership and evidence while specialist systems retain execution
and secret custody.

## Follow-up

The implementation and provider priority are specified in
[Provider inventory and remote projects](../PROVIDER_INVENTORY.md). Any future
write capability remains governed by the separately approved typed safe action
ADR and is not implied by this decision.
