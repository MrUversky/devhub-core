# Read-only evidence adapter contract

Every executable provider evidence adapter also declares its versioned
capability and hard limits in the canonical [connector conformance
registry](CONNECTOR_CONFORMANCE.md). This document defines the exact-identity
evidence runner beneath that registry.

Evidence adapters collect a narrow App Passport candidate from an external
provider without turning DevHub into a provider inventory, log store or control
plane. The normalized result is transient review input. It does not become
App Passport evidence until a person accepts a catalog diff.

## Trust boundary

An adapter may read only the provider resource named by an external reviewed
binding. It must not enumerate an account, discover projects, write to the
provider or execute a catalog command.

The binding is integration configuration, not a project manifest:

```js
{
  projectId: "example-app",
  serviceId: "web",
  adapterId: "example-deployment",
  provider: "example-cloud",
  reviewedIdentity: {
    account: "example-account",
    deploymentId: "deployment-42"
  },
  credentialEnv: "EXAMPLE_CLOUD_TOKEN",
  checks: ["deployment"],
  freshForSeconds: 3600,
  deadlineMs: 10000,
  maxPages: 4,
  maxResponseBytes: 1048576,
  maxCandidates: 1
}
```

`reviewedIdentity` is an adapter-specific typed object. The selected adapter
must validate it before any request and must return the exact same observed
identity before an item may become `verified`. A changed resource ID therefore
becomes `identity-mismatch`, not a green deployment result.

`credentialEnv` names an environment variable. The credential value is read at
execution time, passed only to the selected adapter and excluded from binding
keys, normalized results, notes and errors. Provider credentials, API URLs and
provider response objects do not belong in `catalog/**/*.yaml`.

## Adapter interface

Provider adapters expose:

```js
{
  id: "example-deployment",
  provider: "example-cloud",
  validateIdentity(identity) { return true },
  async collect(request) { /* one read-only exact-identity request */ }
}
```

The runner freezes this allowlisted request:

```js
{
  provider,
  reviewedIdentity,
  checks,
  credential,
  now,
  signal,
  limits: { deadlineMs, maxPages, maxResponseBytes, maxCandidates }
}
```

The generic runner races every collection against `deadlineMs`, aborts the
runner signal on expiry and returns the stable `adapter-timeout` reason. A
provider adapter must forward that signal to its transport, use no more than
`maxPages`, apply `maxResponseBytes` while reading each response and return no
more than `maxCandidates` normalized evidence items. Provider code may impose
smaller limits. The runner still enforces its own output candidate bound and
secret-safe normalized schema even if an adapter is faulty.

A successful provider observation has `status: "success"`, the exact
`observedIdentity`, `observedAt` and one item per observed check. Provider
items may be `verified`, `declared` or `unknown`. Only exact provider evidence
may be `verified`; provider absence is not sufficient proof for
`not-applicable`. The runner computes `validUntil` from `observedAt` and the
reviewed `freshForSeconds` policy.

An adapter may throw or return a safe unavailable reason such as:

```js
{ status: "unavailable", reason: "provider-unavailable" }
```

Raw response bodies, stack traces and provider error messages never cross the
normalization boundary.

## Normalized result

`runEvidenceAdapter` and `parseEvidenceAdapterResult` produce and validate the
same versioned result:

```js
{
  formatVersion: 1,
  identity: {
    projectId,
    serviceId,
    adapterId,
    provider,
    reviewedIdentity
  },
  execution: {
    state: "succeeded" | "failed",
    reason: "stable-reason-code",
    cache: "none" | "fresh" | "stale"
  },
  freshness: {
    state: "fresh" | "stale" | "unknown",
    observedAt: "..." | null,
    validUntil: "..." | null,
    evaluatedAt: "..."
  },
  evidence: [{
    id,
    check,
    state: "verified" | "declared" | "unknown",
    source: "integration",
    note,
    observedAt,
    validUntil,
    url
  }],
  deployment: { identity, revision, url, host, deployedAt },
  recurringCost: { state, observedAt, url }
}
```

Deployment and recurring-cost blocks are optional, allowlisted summaries.
Evidence URLs must be safe HTTP(S) links with no credentials or secret-bearing
query parameters. Unknown fields are rejected so provider-specific objects,
raw logs and accidental secrets cannot silently become part of the portable
contract.

The evidence CLI and Portfolio Guardian consume only this normalized result.
Provider modules and credentials remain behind the runner. The current v0.7
dashboard and MCP do not consume transient adapter output: they continue to
show only the reviewed catalog. A candidate appears there only after its safe
facts are proposed as a YAML change, reviewed, merged and validated.

## CLI collection

Refresh one binding document without changing a manifest or provider:

```bash
npm run devhub -- collect-evidence ./config/evidence-bindings/example-release.json --json
```

A binding document may be one binding object or `{ "version": 1,
"bindings": [...] }`. `review-portfolio` accepts repeatable
`--evidence-binding <file>` arguments and passes the collected normalized
results directly to Portfolio Guardian. The production CLI deliberately does
not accept normalized-result fixture files.

The public snapshot ships `example-release.json` only as a fictional binding
template aligned with its fictional demo catalog. Replace every identity field
with reviewed values from your own catalog/provider before collection. Private
installation bindings are deliberately excluded from the public export.

Collection and review never update the App Passport themselves. After reading
the candidate or Guardian finding, propose the smallest catalog YAML diff,
preserve its provenance and freshness, and run the normal Git review workflow.
Until that change is merged and the catalog is regenerated, dashboard and MCP
must keep showing the previous reviewed evidence.

Before adapter access, DevHub validates every binding against both the generic
runner and the one canonical connector contract that claims the adapter.
Requests above that connector's deadline, page, response or candidate limit
fail before provider I/O. DevHub then matches the exact catalog project and
service. A reviewed service
link with `type: repository` is authoritative for GitHub; `project.repository`
is used only when that service link is absent. All bindings in the invocation
pass this preflight before the first network request.

## Failure and cache semantics

- Invalid binding is a caller configuration error and fails before provider
  access.
- Missing credentials, provider unavailability, adapter exceptions, unsafe
  responses and identity mismatch produce `execution.state: failed`.
- Without a successful cached observation, every requested check is `unknown`
  and freshness is `unknown`.
- With the in-memory cache, the last successful observation remains visible.
  Execution still says `failed`, and cache/freshness independently say `fresh`
  or `stale`. Stale verified evidence is historical context, not a current pass.
- The cache is injected and process-local. Only a successful result produced by
  this runner instance is accepted as fallback; parsed JSON or an externally
  constructed lookalike cannot seed verified cache evidence. This contract does
  not add a persistent cache or write observations into project manifests.

Fixtures cover an exact success, changed deployment identity, stale evidence
and an unavailable provider under `tests/fixtures/evidence-adapters/`.

The first concrete provider pilots use exact GitHub release, Actions deployment
and workflow identities. See
[GitHub evidence adapters](GITHUB_EVIDENCE_ADAPTERS.md) for their binding,
authentication and retained-data boundaries.

The experimental [Vercel connector](VERCEL_CONNECTOR.md) adds exact reviewed
Production/Preview deployment evidence through the same normalized contract.

The experimental [OpenAI Admin connector](OPENAI_ADMIN_CONNECTOR.md) adds exact
organization/project, Completions Usage API, Costs API and redacted project-key
metadata with separate project and billing access semantics.

## Explicit non-goals

- No account or repository enumeration.
- No browser-supplied provider target.
- No provider credentials in manifests, JSON results or logs.
- No raw logs, metrics, findings, billing rows or backup data.
- No restart, rollback, deployment, remediation or other write action.
- No claim that a provider integration proves general production readiness.
