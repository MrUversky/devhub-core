# Railway in Connected Setup

Railway is the first deployment-provider slice of Connected Setup. A builder
selects one exact Railway workspace, or one project with its parent workspace,
and receives read-only project, service-instance, environment, deployment and
domain candidates for review.

This flow reuses `railway-inventory-v1`; it does not implement another Railway
client. The existing adapter fixes the Railway API origin and GraphQL queries,
and enforces the total deadline, response-size, page and resource limits
documented in [Railway inventory](RAILWAY_INVENTORY.md).

## What the user confirms

Connected Setup needs only three reviewed inputs:

1. the Railway connector;
2. an exact workspace, or a project and its parent workspace;
3. a credential reference and owner.

The connection profile records the reference, not its value. Supported setup
runner references may point to an environment variable, OS Keychain entry or
supported secret manager. The on-demand runner resolves that reference and
injects an ephemeral runtime environment only while it calls the adapter. The
profile, result, catalog, dashboard and logs never receive the token.

An account credential does not authorize account-wide enumeration. The user
must still confirm a workspace or workspace-parented project scope. A
least-privilege Railway workspace token is preferred where available. Railway
project tokens are not supported by this inventory slice because they use a
different single-environment authentication model.

## Result and review boundary

Each service/environment pair keeps a distinct `service-instance` identity.
Production, staging and other environments therefore cannot collapse into one
generic service row. Provider status is deployment metadata, not application
health, and a domain is a candidate link rather than permission to probe it.

A Railway project with no local checkout and no GitHub repository may become a
review-only overlay proposal. It does not need a fake workspace path. The
existing provider reconciliation still requires a visible YAML proposal,
catalog validation and Git review before the project can appear in the
dashboard or MCP.

## Refresh semantics

Refresh repeats the same reviewed scope and compares normalized candidates by
exact provider resource identity. It reports only:

- `added` — a fresh identity appeared;
- `changed` — meaningful normalized metadata changed;
- `stale` — the observation is too old to update reviewed facts;
- `unclear` — the provider was inaccessible, the observation was partial or a
  previously seen identity was not returned.

Unchanged timestamps do not create noise. A missing result never means that a
resource was deleted, abandoned or safe to clean up. DevHub retains the prior
identity as review context and asks for a fresh exact observation instead.

## Explicit non-goals

The Railway setup connector cannot deploy, restart, delete, read variables,
download logs, mutate billing, enumerate an entire account or write the DevHub
catalog. The browser dashboard does not execute the connector and never
receives provider credentials.
