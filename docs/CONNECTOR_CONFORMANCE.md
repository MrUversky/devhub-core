# Connector registry and conformance contract

DevHub connectors use one versioned, provider-neutral boundary. A provider
module may collect bounded read-only observations; it may not extend the
catalog schema, decide which DevHub project a resource belongs to, infer
ownership, or add provider branches to the dashboard or Portfolio Guardian.

This is an adapter SDK, not an unrestricted plugin executor or marketplace.
Provider code is reviewed and shipped with DevHub. The dashboard remains
read-only, and catalog truth still changes only through a validated Git diff.

## Canonical modules

- `lib/connectors.mjs` is the only product metadata catalog used for names,
  ordering, stage, authorization choices and setup presentation.
- `lib/connector-contracts.mjs` is the only canonical list of executable
  connector contracts. Each provider exports one `*_CONNECTOR_CONTRACT` from
  this module; do not create another provider matrix.
- `lib/connector-conformance.mjs` validates contracts and binds their declared
  capabilities to setup, inventory and evidence runtimes without provider
  conditionals.
- Existing inventory, evidence and setup runners remain the normalization and
  credential-isolation boundaries. The connector registry does not replace or
  weaken them.

`connectorContractRegistry` contains metadata only. Use
`createConnectorRuntimeRegistry()` to bind explicitly injected runtime modules
for one process. A missing runtime, wrong provider ID, duplicate adapter ID or
non-canonical connector fails before collection. Every injected setup,
inventory and evidence runtime must be claimed by exactly one supplied
contract; undeclared runtime backdoors and ambiguous claims are rejected.

## Version 1 contract

```js
defineConnectorContract({
  formatVersion: 1,
  connectorId: "example-provider",
  provider: "example-provider",
  compatibility: {
    status: "experimental",
    since: "0.10.0",
    deprecatedSince: null,
    replacementConnectorId: null,
  },
  capabilities: {
    profiles: [],
    setup: [],
    inventory: [{ id: "example-provider-inventory-v1", formatVersion: 1 }],
    evidence: [{ id: "example-provider-monitoring-v1", formatVersion: 1 }],
  },
  limits: {
    deadlineMs: 10_000,
    maxPages: 20,
    maxResponseBytes: 1024 * 1024,
    maxCandidates: 200,
  },
  boundaries: {
    exactScope: true,
    credentialIsolation: true,
    readOnly: true,
    hardDeadline: true,
    boundedPagination: true,
    boundedResponses: true,
    boundedCandidates: true,
    freshnessRequired: true,
    secretsRejected: true,
    normalizedOnly: true,
    providerMutations: false,
    catalogWrites: false,
    catalogMatching: false,
    ownershipDecisions: false,
  },
});
```

The four capability lists are independent. An exact evidence adapter does not
need account inventory or a connection profile. An inventory-only connector
does not need setup. Setup requires a versioned connection-profile capability
with the same `connectorId`, because that runner must start from reviewed
portable input.

The contract declares hard maxima, not desirable page counts. Version 1 never
permits more than 30 seconds, 100 provider pages, 2 MiB per response or 1,000
normalized candidates. A provider adapter may choose smaller limits. It must
enforce its response and pagination bounds internally, while the generic
runner independently enforces its deadline, candidate limit, output schema,
freshness and secret rejection.

These are executable production constraints, not registry decoration.
`validateConnectorInventoryExecution()` and
`validateConnectorEvidenceExecution()` resolve exactly one owning contract,
apply conservative defaults and reject a binding above any connector limit.
The production `inventory` and `collect-evidence` commands call that preflight
before credential resolution or provider I/O. The runtime registry's
`runInventory()` and `runEvidence()` methods use the same validators. Evidence
bindings expose all four execution limits; their runner supplies an
`AbortSignal`, and reviewed provider clients forward it through to fetch.

All scope and identity values are provider-owned stable identifiers. Browser
input cannot select arbitrary URLs. A credential reference may be reviewed and
stored, but its resolved value exists only in the selected adapter call and
must never appear in normalized output, thrown errors, logs, cache keys,
fixtures or catalog YAML.

## Adding a provider

1. Add or update one entry in `CONNECTOR_CATALOG`; UI and CLI continue to
   render this canonical metadata rather than a provider-specific list.
2. Implement only the required provider modules under the existing setup,
   inventory or evidence adapter directories.
3. Export stable, versioned adapter IDs. A breaking output or identity change
   gets a new adapter ID instead of silently changing the old contract.
4. Add one contract to `lib/connector-contracts.mjs` and bind the adapter in
   the existing runtime registry for its capability kind.
5. Add fictional raw fixtures and provider tests. Raw provider payloads must
   disappear at the normalization boundary.
6. Run the conformance fixture suite, the provider tests, lint, catalog
   validation and the public-export check.

The fictional Paper Crane example under `examples/connector-sdk/` deliberately
uses folios, lanes and edge cells rather than a DevHub-shaped provider payload.
Its test proves exact scope, ephemeral credential delivery, hard timeout,
pagination, response and candidate bounds, explicit freshness, secret
rejection and the absence of catalog or ownership decisions. Copy its
contract/test structure, not its provider vocabulary.

## Compatibility before 1.0

Connector contracts are explicit even while DevHub is pre-1.0:

- `experimental` means the adapter is usable but may gain a new versioned
  capability or replacement adapter during an alpha release;
- `supported` means its current format and stable adapter IDs remain accepted
  for the documented release line;
- `deprecated` requires `deprecatedSince`; an optional
  `replacementConnectorId` must already exist in the canonical connector
  catalog;
- removing fields, widening authority, changing scope identity or changing a
  normalized meaning is breaking and requires a new contract/capability
  version or adapter ID;
- adding a new optional provider observation behind the same normalized schema
  is compatible, but it must remain unknown when inaccessible;
- a deprecated contract remains readable for at least the next minor release.
  Removal and migration are never combined into the same release.

Contract format versions and capability format versions are separate. A new
provider normally uses contract format 1 and capability format 1; it does not
increment the global contract merely because its API differs.

## Conformance evidence

Every connector PR should show tests for:

- rejected broad, malformed and parentless child scopes before provider IO;
- credentials delivered only to the selected adapter and absent from every
  result and error;
- a real abortable deadline and fail-closed provider exceptions;
- bounded pagination, response bytes and normalized candidates with no partial
  success on overflow;
- fresh, stale and unavailable observations with explicit timestamps;
- rejected secret-shaped keys, values, URLs, raw payloads and unknown fields;
- candidates containing provider identity and observations only—never
  `catalogProjectId`, match status, owner, payer or cleanup decisions;
- a public export containing only fictional identities, endpoints and
  credential references.

Provider unit tests may add narrower checks, but they cannot waive any item
above by changing their contract boundaries.
