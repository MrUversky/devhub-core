# GitHub evidence adapters

DevHub v0.7 pilots narrow, read-only GitHub adapters because the current
daily-driver already uses GitHub for releases and operational checks.
They produce reviewable App Passport evidence candidates; they do not change a
catalog, run a workflow, deploy, restart, remediate, retain logs or enumerate
repositories.

## Reviewed bindings

The core evidence runner binds an adapter to an exact DevHub project and
service. The binding stores only a provider, a canonical resource identity,
the name of an environment variable containing a token, the permitted checks
and an evidence lifetime. Tokens are never placed in YAML, returned evidence,
cache keys or logs.

The deployment adapter requires every relevant GitHub identity in a strict
`reviewedIdentity` object:

```json
{
  "owner": "acme-example",
  "repository": "pocket-ops",
  "workflowId": "410",
  "runId": "8100",
  "environment": "production",
  "deploymentId": "9200",
  "statusId": "9300"
}
```

It fetches those four exact resources, then requires the reviewed repository,
workflow, run, environment, deployment and status IDs to match and the run and
deployment revisions to agree. Only a successful run and successful exact
deployment status produce `verified` deployment evidence.

The workflow monitoring adapter binds one exact workflow and branch:

```json
{
  "owner": "acme-example",
  "repository": "pocket-ops",
  "workflowId": "510",
  "branch": "main",
  "lookbackHours": 24
}
```

It queries only that workflow, branch and bounded 1–168 hour window. DevHub
retains an aggregate: latest conclusion, completed-run count and failed-run
count. Run names, logs, issue content, annotations and individual incident URLs
are not returned or cached. This adapter verifies that reviewed monitoring
evidence was observed; a failure count remains explicit and is not a claim that
the application is healthy.

The release deployment adapter binds an immutable public or private release:

```json
{
  "owner": "acme-example",
  "repository": "pocket-ops",
  "tag": "v1.2.3",
  "releaseId": "9400",
  "targetCommitish": "main",
  "targetSha": "abcdef0123456789abcdef0123456789abcdef01"
}
```

It reads the exact release, tag reference, optional annotated-tag object and
target Git commit. It never reads release assets, bodies or commit messages.
This evidence verifies released source identity only. It does not prove that a
cloud or self-hosted runtime currently runs that revision or is healthy.

Resource identities are strict typed objects, never URLs. Owner, repository,
workflow, run, branch, environment, deployment and status identifiers are
strictly validated before a request. All API requests use the fixed
`https://api.github.com` origin, `GET`, and a versioned GitHub media type. The
only provider links that may enter evidence are credential-free HTTPS links on
`github.com` without query strings or fragments.

The pilot uses GitHub REST API version `2026-03-10`. GitHub documents read-only
Actions access for the exact workflow and workflow-run endpoints and read-only
Deployments access for the exact deployment and deployment-status endpoints.
Responses are time-bounded and parsed through a one-megabyte limit before
provider-specific normalization. The deadline covers both the fetch and body
read even if a custom transport ignores `AbortSignal`.

## Authentication

Set the reviewed binding's `credentialEnv` to the name of an environment
variable available only to the DevHub evidence process. Use the narrowest
GitHub App or fine-grained token permissions that can read the selected Actions
workflow and, for deployment evidence, deployments. The adapter receives the
resolved token at runtime. Missing credentials, denied access, provider errors
and invalid payloads normalize to `unknown`; response bodies and token values
are never included in the result.

For a public repository, omit `credentialEnv` to make anonymous GitHub GET
requests. If `credentialEnv` is present but the named variable is missing,
DevHub returns `unknown` without contacting GitHub.

## Cache and freshness

The provider modules perform one collection and return an observation time.
The core runner applies the reviewed binding's `freshForSeconds`, caches the
normalized non-secret result by binding identity and labels cached evidence
fresh or stale. An unavailable adapter with no safe cache returns `unknown`; a
failed refresh with a safe cache leaves its evidence visible with the failed
execution and freshness state. It never overwrites or deletes existing reviewed
catalog evidence. Operators can review a fresh candidate before changing it.

Tests inject a network client and use only fictional GitHub identities and
responses. Production code never accepts a caller-supplied API base URL.
