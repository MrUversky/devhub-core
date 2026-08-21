# Railway inventory adapter

`railway-inventory-v1` reads a reviewed Railway workspace, or one reviewed
project within a workspace, and returns transient inventory candidates for
review. It never changes Railway or the DevHub catalog.

The adapter uses Railway's official Public GraphQL API at the fixed origin
`https://backboard.railway.com/graphql/v2`. A binding cannot supply another
origin or arbitrary URL.

## Binding and authentication

Use a Railway account or workspace token stored only in an environment
variable. The binding names that variable; it does not contain the credential:

```json
{
  "adapterId": "railway-inventory-v1",
  "provider": "railway",
  "scope": {
    "kind": "workspace",
    "id": "11111111-1111-4111-8111-111111111111"
  },
  "credentialEnv": "DEVHUB_RAILWAY_INVENTORY_TOKEN",
  "freshForSeconds": 3600,
  "maxResources": 250,
  "maxPages": 100,
  "deadlineMs": 8000
}
```

A project binding includes its reviewed parent workspace, allowing the adapter
to verify that the project belongs to the expected scope:

```json
{
  "adapterId": "railway-inventory-v1",
  "provider": "railway",
  "scope": {
    "kind": "project",
    "id": "22222222-2222-4222-8222-222222222222",
    "parent": {
      "kind": "workspace",
      "id": "11111111-1111-4111-8111-111111111111"
    }
  },
  "credentialEnv": "DEVHUB_RAILWAY_INVENTORY_TOKEN",
  "freshForSeconds": 3600
}
```

The adapter deliberately does not support account-wide discovery. Railway
account tokens are accepted as credentials, but the binding must still narrow
the read to an exact workspace or workspace-parented project. Railway project
tokens use a different single-environment authentication model and are not
supported by this inventory adapter.

Use a least-privilege workspace token when possible. A missing credential,
access denial, timeout, invalid response or exceeded bound produces `unknown`
with no candidates; provider error messages are not copied into results.

## Read boundary

The fixed GraphQL queries request only:

- project IDs and names;
- service IDs, names and an optional `owner/repository` GitHub source;
- environment IDs and names;
- the latest deployment ID, status and creation time for each
  service/environment pair;
- custom and Railway-provided domain names.

The adapter does not query or return rendered variables, variable names,
secrets, connection strings, logs, metrics, deployment bodies, raw provider
responses, members, billing data or provider error details. Unknown response
fields are discarded by allowlist extraction. A service with no valid GitHub
source stays repository-unknown rather than receiving an invented link.

Every request is read-only, uses an injected network client for tests, and is
bounded by a total deadline, JSON byte limit, resource limit and request/page
limit. Pagination stops closed: if the reviewed bounds cannot cover the full
observation, the run returns `unknown` instead of a partial inventory.

## Freshness and review

The provider observation time is the collection time supplied by the trusted
runner. The generic runner computes `validUntil` from `freshForSeconds`; after
that time, the observation is stale. This is not an HTTP cache, and the adapter
does not persist tokens or raw responses.

Candidates are not catalog facts. Review matching and the proposed YAML diff,
then merge and validate the catalog before expecting the dashboard, MCP or App
Passport to show a resource. A Railway deployment status is provider metadata,
not proof of application health or safe recoverability.

Railway references:

- [Public API, endpoint and token scopes](https://docs.railway.com/integrations/api)
- [API cookbook](https://docs.railway.com/integrations/api/api-cookbook)
- [Managing projects with the Public API](https://docs.railway.com/integrations/api/manage-projects)
