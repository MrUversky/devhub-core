# OpenAI Admin connector

The experimental OpenAI connector answers one bounded question: what does the
OpenAI Admin API currently report for this exact reviewed organization and
project? Connected Setup collects the project plus bounded project API-key
metadata so it can propose product mappings from safe key names. Evidence
collection can then bind one reviewed key identity to one catalog service and
collect usage, cost and stewardship facts. Neither path receives a usable key
value from the metadata endpoint or returns the Admin credential.

OpenAI documents Admin APIs as organization-management and operational tooling
that require a separately created Admin API key. An ordinary project key is not
an Admin key. DevHub uses only documented GET endpoints:

- <https://developers.openai.com/api/docs/guides/admin-apis>
- `GET /v1/organization/projects/{project_id}`
- `GET /v1/organization/projects/{project_id}/api_keys`
- `GET /v1/organization/usage/completions`
- `GET /v1/organization/costs`

## Reviewed scope and credential

The scope is always one project with one organization parent:

```json
{
  "kind": "project",
  "id": "proj_fictional_pocket_ops",
  "parent": { "kind": "workspace", "id": "org_fictional_studio" }
}
```

`workspace` is DevHub's provider-neutral parent-scope name; the `org_...` value
is an OpenAI organization ID. DevHub retrieves the exact project before any
key, usage or cost observation. It does not list every project as a shortcut
and does not infer ownership from access.

Create the Admin key manually in OpenAI organization settings, outside DevHub.
DevHub does not create, rotate, revoke, delete or display it. The public example
uses this macOS Keychain locator:

```json
{
  "kind": "keychain",
  "locator": "generic-password:devhub:openai-admin"
}
```

The locator means Keychain generic-password service `devhub`, account
`openai-admin`. The value remains in Keychain. The on-demand resolver uses the
exact typed locator only after connector conformance, catalog and scope
preflight. A missing item produces `credential-unavailable` with zero provider
calls. Existing `credentialEnv` bindings remain supported; a binding must not
set both forms.

## Connected Setup and live smoke

Use the fictional templates as shapes, then keep reviewed real IDs in the
private checkout:

- `config/connection-profiles.example.json`
- `config/inventory-bindings/example-openai.json`
- `config/evidence-bindings/example-openai.json`

The same credential reference works through Connected Setup and both collectors:

```sh
npm run devhub -- setup-session config/connection-profiles.json --json
npm run devhub -- inventory config/inventory-bindings/openai.json --json
npm run devhub -- collect-evidence config/evidence-bindings/openai.json --json
```

Setup verifies the exact project through the on-demand runner. Inventory returns
one transient project candidate plus at most 49 transient key-metadata
candidates. It retains only key identity, safe display name, owner type/ID and
created/last-used dates; `redacted_value` and unknown provider fields are
discarded. A key candidate may be proposed as a possible match to an existing
catalog product from a bounded name fragment, but it can never create a DevHub
project or become an exact match without review. Evidence also requires an
exact reviewed key ID, service binding, project-versus-billing access,
stewardship and an ISO
window no longer than 31 days. The binding document is the review unit that
links one reviewed catalog project/service to the exact OpenAI
organization/project/key identity; normalized results are not accepted as a
substitute. Successful Connected Setup, inventory and evidence collection are
read-only transient observations. They do not mutate or enrich catalog YAML,
the dashboard, App Passport, UI or MCP output. Those surfaces change only after
a separate human-reviewed catalog YAML diff is merged and the catalog is
regenerated.

## Evidence semantics

- Project access and billing access are separate reviewed facts.
- Usage is explicitly Completions Usage API evidence, not total OpenAI usage and
  not proof of cost.
- Usage and cost requests filter and group by the exact project and key. Null or
  different identities cannot verify the observation.
- A Costs API observation names its period, amount and currency unit; normalized
  evidence adds source, observation time and freshness.
- A capability-specific `403` keeps that capability `unknown`. Rejected
  credentials, missing exact resources, malformed pagination and identity
  mismatch fail closed.
- Provider `redacted_value`, owner email, raw usage rows, billing rows and
  unknown fields are discarded. Retained key metadata is limited to identity,
  owner type/ID, project-access state and dates.
- Credential owner, billing owner, purpose, last verification and rotation due
  date are reviewed metadata. Provider access never verifies those assignments.

Shared-key consumers belong in the catalog credential inventory. Reusing one
reviewed key ID for two service bindings is context, not permission to rotate
or delete the key.

One connection profile still represents one exact organization/project scope.
Accounts that expose both HappyAI and Personal must use separate reviewed
profiles, and projects inside those organizations must not be collapsed into a
single ambiguous scope. Once those profiles and their Admin credential
references are available to the runtime, future refreshes can collect the same
safe key metadata and propose mappings without screenshots.

## Boundary

This connector is read-only evidence collection. It does not create budgets,
claim complete usage coverage, scan prompt content, store secrets, change
provider policy or perform remediation.
