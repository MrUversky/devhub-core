# Provider inventory and remote projects

## Product outcome

Provider inventory helps builders avoid losing projects that exist only in a
cloud account, with no checkout on the current computer or no GitHub
repository. Git remembers the code when code exists; DevHub preserves the
reviewed context for how the project runs. Bounded inventory can surface
candidate resources from one explicit account, team, workspace or project so a
builder can review what may be missing. Provider observations do not establish
ownership, completeness, cost, access or catalog membership on their own; the
reviewed catalog remains the source of intent.

Provider inventory is an enrichment and reconciliation system. It is not a
deployment console, secret manager or billing ledger.

## Three distinct layers

DevHub keeps three kinds of information separate:

1. **Reviewed catalog** — stable project and service identity, purpose,
   ownership intent, operating profile and reviewed guidance. Git is the audit
   and review boundary.
2. **Inventory candidates** — bounded metadata observed by enumerating one
   explicitly configured provider account, team, workspace or project. A
   candidate may be matched, possibly matched or unregistered; it is not yet a
   catalog fact.
3. **Evidence observations** — fresh checks of an exact reviewed resource.
   These use the existing evidence-adapter contract and can support a passport
   check after review.

This separation prevents provider discovery from silently creating projects or
turning a temporary preview deployment into a permanent service.

## Remote-only projects

A DevHub project does not require a local folder or GitHub repository. The
current schema already makes both `repository` and `workspaces` optional. A
remote-only project uses `registration: overlay`; its reviewed record lives only
in DevHub and may be enriched from provider observations.

Examples include:

- a Railway project built from a Docker image;
- a Vercel project whose repository is inaccessible to the current operator;
- an OpenAI Sites deployment represented by reviewed deployment metadata;
- a managed database, scheduled function or bot created directly in a cloud
  console;
- a client project for which only runtime access is available.

Missing code access is an explicit access fact, not a registration error.
Repository access, runtime access and billing access are independent.

## Normalized resource graph

Provider-specific objects are normalized into a small graph before they reach
reconciliation:

```text
project / product
├── component                 web, API, worker, bot, database
│   └── deployment            production, staging, preview, local
│       └── provider resource exact provider/account/resource identity
├── repository reference      optional; access may be known or unknown
├── dependency reference      AI API, data store, auth, storage, messaging
├── credential reference      metadata only; never the secret value
├── access assignment         person/team/role and review freshness
└── cost observation          payer, model, period, amount/quota and freshness
```

The existing service remains the independently operated unit. A future
optional `componentId` may group multiple service instances that represent the
same logical component in production, staging, preview and local environments.
Stable service IDs and current manifests remain backward-compatible.

## Universal adapter boundary

Provider integrations implement capabilities rather than adding provider
fields to project YAML.

| Capability | Purpose | Typical output |
| --- | --- | --- |
| `inventory` | Enumerate a bounded account/team/workspace scope | project, service, deployment and environment candidates |
| `deployment` | Observe one exact reviewed deployment | revision, status, URL and deployment time |
| `monitoring` | Observe one exact health or workflow resource | state, incident summary and freshness |
| `access` | Read non-secret membership and roles | principal, role, scope and review time |
| `cost` | Read usage, quota or spend metadata | period, amount, currency, payer reference and freshness |
| `credential-metadata` | Read redacted key or variable metadata | provider ID, name, scope, owner, last use and rotation date |

An adapter descriptor declares its stable ID, provider, capabilities,
credential environment variable and the exact scope types it accepts. The
shared runner supplies credentials at execution time, enforces deadlines and
pagination limits, rejects raw provider objects and secret-shaped fields, and
returns only normalized candidates.

Provider URLs and API origins belong to reviewed adapter code. They are never
accepted from browser input. Provider credentials remain outside the catalog,
results and logs.

## CLI workflow

Inventory configuration lives outside project manifests. The production CLI
accepts a binding document, invokes only a registered adapter, and never
accepts a caller-supplied normalized provider result:

```bash
npm run devhub -- inventory ./config/inventory-bindings/example-railway.json --json
```

A document keeps the reviewed provider scope separate from reviewed catalog
decisions:

```json
{
  "version": 1,
  "binding": {
    "adapterId": "railway-inventory-v1",
    "provider": "railway",
    "scope": { "kind": "workspace", "id": "reviewed-workspace-id" },
    "credentialEnv": "DEVHUB_RAILWAY_TOKEN",
    "freshForSeconds": 3600,
    "maxResources": 200,
    "maxPages": 20,
    "deadlineMs": 10000
  },
  "decisions": [
    {
      "resourceType": "project",
      "resourceId": "reviewed-provider-project-id",
      "disposition": "catalog",
      "projectId": "reviewed-devhub-id"
    },
    {
      "resourceType": "project",
      "resourceId": "reviewed-client-project-id",
      "disposition": "external",
      "note": "Client-owned resource intentionally managed outside this catalog."
    }
  ]
}
```

The included document is fictional and cannot access a provider until its
scope ID and credential environment are replaced with reviewed values.

`credentialEnv` names an environment variable; its value never enters the
binding or output. Bounds are reviewed inputs, not provider suggestions. A
`catalog` or `external` decision applies only to the exact resource type and ID
inside that binding's exact provider scope. A missing reviewed resource is
reported as `unknown`; its absence does not prove deletion or non-use.

The JSON output contains provider/scope/resource identity, observation
freshness, provenance, one safe next action and one of the states below. For a
fresh unregistered provider project it may print a schema-valid overlay YAML
proposal. The proposal is stdout-only and intentionally omits services,
commands, probes and workspaces. A cloud host is mentioned as evidence only
when that provider host is already reviewed in `catalog/hosts.yaml`.

To accept a proposal, copy and edit it in a separate review, validate it, and
merge it through Git. The `inventory` command never writes or applies the YAML;
dashboard and MCP continue to show only the reviewed catalog.

Connected Setup reuses this matching and minimal-overlay implementation in the
Discovery Inbox. It adds an artifact-bound review document so a decision cannot
be replayed after a refresh changes the candidates. It does not add a second
provider matcher or allow a setup-session result to bypass strict inventory
normalization.

## Inventory reconciliation

An inventory refresh follows this sequence:

```text
explicit provider scope
  -> read-only inventory adapter
  -> normalized candidates with provenance and TTL
  -> deterministic matching against reviewed identities
  -> review queue and proposed YAML diff
  -> human or agent review
  -> validate and merge
  -> dashboard, MCP and App Passport
```

Matching uses provider account and resource IDs before names or URLs. Names and
domains are supporting evidence because they can change. Ambiguous candidates
never auto-match.

Candidate states are:

- `matched` — exact reviewed provider identity;
- `possible-match` — supporting evidence agrees but exact identity is absent;
- `unregistered` — no reviewed project or service matches;
- `reviewed-external` — intentionally known but managed outside DevHub;
- `unknown` — insufficient access, provider failure or invalid evidence.

“Orphaned” is a finding that requires review, not a provider fact. DevHub may
say that a paid resource is unregistered or has no reviewed owner; it must not
claim the resource is unused or safe to delete.

## Ownership, access and credential references

Small teams need more than one `owner` string. The additive ownership model
should distinguish:

- accountable owner;
- operators;
- billing owner;
- security or credential owner;
- provider and repository administrators.

Credential records contain references and metadata only:

- provider and redacted key/resource ID;
- environment-variable or secret-manager reference name;
- scope and consuming services;
- human/team owner and payer;
- created, last-used, last-reviewed and rotate-by timestamps;
- current state such as active, unused, expiring or unknown.

DevHub never retrieves or stores a secret value. When a provider API can return
decrypted values, the adapter must use a metadata-only endpoint or discard the
value before normalization. Secret-manager references such as a 1Password URI
may be stored only when they contain no secret material.

## Initial integration order

1. **Railway inventory pilot** — highest immediate coverage for projects,
   services, environments, deployments, domains and safe variable names. Never
   collect rendered variable values.
2. **Vercel inventory** — teams, projects, production/preview deployments,
   domains, repository links and project membership. Environment values remain
   excluded.
3. **OpenAI account context** — projects, redacted API-key metadata, last use,
   usage and cost observations. This is a dependency/cost adapter rather than a
   hosting inventory adapter.
4. **OpenAI Sites and self-hosted resources** — use reviewed deployment export
   or agent-collected metadata where no suitable bounded public inventory API
   exists. Local and tailnet services keep the existing host inspection model.
5. **1Password or another secret manager** — reference validation and ownership
   metadata, never secret retrieval.
6. **Sentry and one uptime provider** — monitoring and incident evidence after
   deployment identity is reliable.
7. **Supabase, Cloudflare and additional hosts** — add only when a real project
   needs them; they implement the same capability contracts.

The first provider proves the generic contract. A second provider with a
different object model is required before calling the interface stable.

## Coverage without a magic score

DevHub reports evidence coverage by category instead of one readiness score:

- current verified;
- current declared;
- stale;
- explicit not applicable;
- unknown.

Project-level defaults and a short attestation queue may supply reviewed owner,
profile and payer context to several services at once. Inheritance is shown
explicitly and a service override always wins. Provider evidence then focuses
on facts that actually require an integration: current deployment, access,
usage, spend and last use.

## Safety boundaries

- Read-only provider scopes and least privilege by default.
- No secret values, connection strings, cookies or raw provider payloads.
- No automatic registration, deletion, restart, rollback or remediation.
- No account-wide enumeration without an explicit reviewed scope.
- No claim that absence from one provider proves a resource does not exist.
- No match from display name alone.
- Every candidate carries provider identity, observation time, freshness and
  the exact configured scope.
- Dashboard and MCP remain projections of reviewed catalog truth.

## First vertical slice

The first implementation should be deliberately narrow:

1. define and test the generic inventory adapter and normalized candidate;
2. add project-level owner/profile inheritance and reviewed attestations;
3. support remote-only overlay registration from a reviewed candidate;
4. implement Railway as the first read-only inventory adapter;
5. show matched, possible and unregistered candidates in CLI output;
6. propose a catalog diff but never apply it automatically;
7. prove that a second fixture provider can use the same contract without
   changing the catalog schema.

The slice is complete when a Railway-only project with no local folder and no
GitHub repository can be discovered, reviewed, registered as an overlay and
shown in DevHub without exposing any variable value or granting DevHub write
access to Railway.
