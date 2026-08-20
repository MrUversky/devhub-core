# Stewardship

DevHub stewardship answers four different operating questions for each
service: who is accountable, who operates it, who owns the bill and who owns
credential rotation. These are reviewed catalog facts. They are not IAM grants,
legal ownership, provider access or proof that a person can sign in.

## Model

A project may define a small `stewards` directory. Each stable ID names either
a person or a team label and records `source`, plus optional `observedAt` and
`validUntil`. Stewardship sources are limited to `operator`, `agent` and
`integration`. `catalog` is intentionally not accepted: merely typing a name
into a manifest must not masquerade as reviewed stewardship evidence.

`stewardshipDefaults` assigns any of these roles at project level:

- `accountableOwner`
- `operator`
- `billingOwner`
- `credentialOwner`

A service may set `stewardship` with an explicit override. It may also set a
role to `null` to keep that service explicitly unknown instead of inheriting a
project default. The dashboard and MCP expose `project`, `service`,
`explicit-unknown` or `absent` provenance. Existing manifests remain valid: all stewardship fields are optional,
and the legacy App Passport `readiness.owner` remains context rather than being
silently promoted to a reviewed role.

```yaml
stewards:
  - id: product-team
    name: Product team
    kind: team
    source: operator
    observedAt: 2026-08-13T00:00:00Z
    validUntil: 2027-08-13T00:00:00Z
stewardshipDefaults:
  accountableOwner: product-team
  operator: product-team
services:
  - id: api
    # ...normal service fields...
    stewardship:
      operator: on-call-team
```

## Access facts stay separate

`access` records reviewed provider, repository and billing access as separate
facts. A repository login never proves provider or billing access, and an owner
assignment never creates an access grant. Each fact has a stable ID, subject,
`yes`, `no` or `unknown` state, source, note and optional freshness dates.
Only one logical fact may exist for the same kind and normalized subject. When
`validUntil` passes, the recorded state remains historical context but its
effective state becomes `unknown` on the dashboard, MCP and Guardian.

DevHub displays these facts but does not enforce them. It is not RBAC, IAM or a
provider authorization system.

## Credential inventory

`credentials` stores metadata only:

- provider and purpose;
- a typed external `secretRef` (`environment`, `keychain` or
  `secret-manager`);
- reviewed service consumers;
- owner and optional payer steward IDs;
- source, last verification and rotation due dates.

The source manifest requires the same typed reference forms as Connected Setup:
an uppercase environment name, `generic-password:<service>:<account>` for macOS
Keychain or an `op://...` 1Password reference. Locators that themselves look
like tokens, bearer/JWT values, private keys, credential URLs or inline secret
assignments are rejected for every reference kind. It never stores the secret value.
Generated dashboard/public catalogs and MCP output remove the locator and show
only `{ kind, configured: true }`, because even a vault path or account label is
unnecessary presentation metadata.

Expired owner and payer assignments are stale rather than current identities.
A passed rotation due date is due even when `lastVerifiedAt` is absent. An
empty consumer list is allowed so an orphaned reference can remain visible
until reviewed. It is a question, not proof that the provider credential is
unused. Guardian never recommends automatic deletion or revocation.

## Guardian questions

Portfolio Guardian reports, with evidence and uncertainty:

- missing or expired role assignments;
- important roles concentrated in one reviewed person without a team boundary;
- a credential with no reviewed payer;
- a credential whose reviewed rotation date passed;
- a credential reference with no reviewed service consumers.

These findings lead to a reviewed catalog update or an external owner review.
They never change provider access, reveal a locator, rotate a secret or delete a
resource.

## Migration

No migration is required for existing catalogs. Add stewardship incrementally:

1. create stable steward IDs at project level;
2. add the smallest reviewed project defaults;
3. override only services with genuinely different responsibility;
4. record repository, provider and billing access separately;
5. add external credential references only after confirming owner, consumers
   and purpose;
6. run `npm run devhub -- validate`, `npm run devhub -- doctor`, tests and lint.

Native reconciliation writes the reviewed source manifest, while its stdout,
JSON and human semantic diffs redact locator values. Overlay proposal output
fails closed when an existing overlay contains credential references and sends
the reviewer to the private catalog source instead of emitting an invalid or
secret-bearing proposal.

Native manifests keep these fields in `.devhub/project.yaml`; shared or client
repositories use the private overlay. Reconciliation compares the fields
semantically and never invents missing roles, access or credentials.
