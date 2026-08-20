# Inventory adapter contract

Every executable provider inventory also declares its versioned capability and
hard limits in the canonical [connector conformance
registry](CONNECTOR_CONFORMANCE.md). This document defines the normalized
inventory runner beneath that registry.

Inventory adapters discover non-secret resource metadata inside one explicit,
bounded provider scope. They are separate from evidence adapters: inventory
answers “what did this provider return in this scope?”, while evidence verifies
one exact resource already reviewed for a catalog service.

An inventory result is a transient candidate set. It does not register a
project, prove ownership, establish runtime health or become visible in the
dashboard or MCP. Only a reviewed catalog diff can do that. See
[Provider inventory](PROVIDER_INVENTORY.md) and
[ADR 0002](adr/0002-provider-inventory-and-remote-projects.md) for the product
and review boundaries.

## Binding and adapter

Bindings live outside project manifests. They contain only an allowlisted
adapter and provider, an explicit scope, an environment-variable name for the
credential, a freshness lifetime and execution caps:

```json
{
  "adapterId": "example-inventory-v1",
  "provider": "example-cloud",
  "scope": {
    "kind": "project",
    "id": "provider-project-id",
    "parent": { "kind": "workspace", "id": "provider-workspace-id" }
  },
  "credentialEnv": "EXAMPLE_INVENTORY_TOKEN",
  "freshForSeconds": 3600,
  "maxResources": 200,
  "maxPages": 20,
  "deadlineMs": 10000,
  "maxResponseBytes": 1048576
}
```

The generic scope kinds are `account`, `team`, `workspace` and `project`, but
each adapter explicitly accepts only the kinds it can query precisely. Scope
IDs are provider identities, never API URLs. `credentialEnv` is a reference;
the secret value is injected at execution and is never returned. Omitting it
deliberately selects anonymous access. Naming a missing variable fails closed
without calling the provider.

An adapter exposes `{ id, provider, validateScope, collect }`. Its frozen
request contains `{ provider, scope, credential, now, limits, signal }`. The
runner enforces a hard deadline even when transport ignores `AbortSignal`.
Provider code must additionally use fixed reviewed origins and bounded response
readers, applying the smaller of its own reviewed byte ceiling and the
binding's `maxResponseBytes`. It returns either `{ status: "unavailable", reason }` or a success
observation with `observedAt`, `pagesRead` and candidates. Exceeding a reviewed
page or resource cap makes the whole observation unknown; partial inventory is
not treated as complete.

## Normalized result

`runInventoryAdapter` returns a strict versioned shape:

```js
{
  formatVersion: 1,
  source: { adapterId, provider, scope },
  execution: { state: "succeeded" | "failed", reason, pagesRead },
  freshness: { state, observedAt, validUntil, evaluatedAt },
  candidates: []
}
```

Every candidate carries provider, resource type and ID, optional parent ID,
name, optional environment/runtime, typed safe URLs, optional repository ref,
and its own observation/freshness timestamps. `metadata` is limited to safe
scalar region, plan, version, revision, deployment time and exact provider
workspace/project/service/environment/deployment IDs.

Candidate `status` is only the provider observation: `running`, `stopped`,
`deploying`, `failed` or `unknown`. Values such as `matched`, `unregistered`,
`external`, or catalog IDs are forbidden. Reconciliation owns those review
decisions and keys them by exact provider, scope, resource type and resource ID.

URLs are typed `service`, `console`, `status` or `documentation`; they must use
HTTP(S), contain no URL credentials and have no secret-bearing query field.
Repository refs are split into provider, owner, name and optional ref.

## Fail-closed behavior

Adapter exceptions, timeouts, missing named credentials, unavailable responses,
invalid pagination counts, too many resources, duplicate identities, unsafe
URLs, secret-shaped strings, extra provider fields or raw payloads produce an
unknown result with no candidates. Raw errors and provider responses are never
copied into output. A successful expired observation remains explicitly stale;
it is history, not current inventory proof.

The core exports are:

- `validateInventoryBinding(binding, adapter)`;
- `runInventoryAdapter({ binding, adapter, environment, now })`;
- `validateNormalizedInventoryResult(value)`;
- `parseNormalizedInventoryResult(json)`;
- `InventoryAdapterContractError` with a stable code.

The registry is an allowlist of reviewed implementations. Callers must select
an exact adapter ID and must not accept provider modules, origins or prebuilt
“matched” results from browser input.

The production `inventory` command additionally resolves the single canonical
connector contract that claims the adapter. Its connector-specific deadline,
page, response-byte and candidate maxima are checked before credential
resolution or provider I/O; a runtime not claimed by exactly one contract is
rejected.

Concrete provider boundaries:

- [Railway inventory](RAILWAY_INVENTORY.md)
- [Vercel inventory and deployment evidence](VERCEL_CONNECTOR.md)
- [OpenAI exact project inventory and evidence](OPENAI_ADMIN_CONNECTOR.md)
