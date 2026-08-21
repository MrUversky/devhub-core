# Vercel connector

The experimental Vercel connector is a bounded, read-only source for Connected
Setup. It maps projects and the latest Production and Preview deployments in
one exact Vercel account or team, then can refresh deployment evidence for one
exact reviewed deployment. It never deploys, promotes, rolls back, restarts or
changes Vercel or the DevHub catalog.

The two versioned capabilities are:

- `vercel-inventory-v1` — transient projects, the exact READY deployment
  currently serving Production, separate latest production attempts and the
  latest Preview deployment;
- `vercel-deployment-v1` — exact deployment status, revision, created time and
  URL evidence for an already reviewed service identity.

Both capabilities normalize through DevHub's generic inventory/evidence
contracts. Matching, ownership and catalog decisions remain in the Discovery
Inbox and normal Git review workflow.

## Scope and credential reference

A connection must review one exact scope:

```json
{ "kind": "team", "id": "team_REPLACE_WITH_REVIEWED_ID" }
```

or:

```json
{ "kind": "account", "id": "REPLACE_WITH_REVIEWED_USER_UID" }
```

Team runs append that same ID as `teamId` on every scoped list/read. Personal
account runs never add a team parameter. Before collecting resources, the
adapter reads the exact team or current user and requires its returned ID to
match the reviewed scope. It never lists all teams to guess a scope.

Connected Setup stores only an external credential reference in a reviewed
connection profile, for example:

```json
{
  "version": 1,
  "id": "vercel-reviewed-team",
  "connectorId": "vercel",
  "authorization": {
    "method": "secret-reference",
    "credentialRef": {
      "kind": "environment",
      "locator": "DEVHUB_VERCEL_TOKEN"
    }
  },
  "scope": { "kind": "team", "id": "team_REPLACE_WITH_REVIEWED_ID" },
  "owner": "Accountable operator",
  "state": "authorization-required",
  "lastObservedAt": null,
  "freshForSeconds": 3600
}
```

The setup connector bridges this profile internally to `vercel-inventory-v1`.
The token value is resolved at the runner boundary, exists only for the request
and is absent from profiles, normalized results, cache keys and error output. Prefer a
least-privilege, expiring Vercel token scoped to the exact account/team.

When initial `setup-run` returns `QUESTION setup-run-vercel-needs-scope`, its
typed answer contains only the exact scope, supported non-secret
`credentialRef` and accountable `owner`. A reviewed v1 answer document is
passed back with the original source selection:

```bash
devhub setup-run --sources github,local-host,vercel,railway,openai \
  --connection-review /absolute/reviewed-connection-answers.json --json
```

The runner recomputes `review.connectionReviewId` before credential/provider
I/O, runs only the answered newly unlocked source and returns the profile under
stdout-only `connectionProfileProposals`. It does not write the profile or
catalog. The lower-level inventory binding below remains an audit primitive;
Connected Setup does not require an agent to handcraft it.

Example inventory binding:

```json
{
  "version": 1,
  "binding": {
    "adapterId": "vercel-inventory-v1",
    "provider": "vercel",
    "scope": {
      "kind": "team",
      "id": "team_REPLACE_WITH_REVIEWED_ID"
    },
    "credentialEnv": "DEVHUB_VERCEL_TOKEN",
    "freshForSeconds": 3600,
    "maxResources": 200,
    "maxPages": 20,
    "deadlineMs": 10000
  },
  "decisions": []
}
```

## Inventory boundary

The adapter uses only fixed `https://api.vercel.com` GET routes to:

- verify the reviewed team or personal user;
- paginate every project in that exact scope;
- read each exact project target to identify the deployment currently serving
  Production;
- paginate project domains;
- read at most the latest deployment separately for `production` and
  `preview` for each project.

It retains only allowlisted project/environment/deployment/domain/revision,
collection time and mapped status fields. Production project domains are
attached only to the exact project target when that target is `READY`. A newer
building, failed or staged production-targeted deployment remains a separate
`deployment-attempt` candidate and never changes the status, revision or URLs
of the serving Production candidate. If the project does not expose a verified
READY Production target, current Production remains unknown rather than being
guessed from the newest attempt. Preview retains only its exact deployment URL;
unclassified aliases are discarded so a Production domain cannot silently
cross the environment boundary. The stable service-instance identity is
`projectId:production` or `projectId:preview`, while `deploymentId` and revision
change as new versions ship.

The deployment query intentionally uses `limit=1` for each environment. Its
pagination cursor means older deployment history exists, not that the latest
observation is partial. Project and domain lists, by contrast, must reach the
end of pagination. If their pagination cannot finish within reviewed bounds,
the whole run becomes `unknown` with no candidates.

The connector never requests or returns environment-variable names or values,
source/build files, deployment bodies, functions, logs, members, billing,
provider error details or raw responses. Extra response keys are discarded by
allowlist extraction.

## Exact deployment evidence

An evidence binding pins the scope, project, deployment, environment and
revision (or explicit `null` when the deployment has no supported revision):

```json
{
  "projectId": "reviewed-catalog-project",
  "serviceId": "web-production",
  "adapterId": "vercel-deployment-v1",
  "provider": "vercel",
  "reviewedIdentity": {
    "scope": {
      "kind": "team",
      "id": "team_REPLACE_WITH_REVIEWED_ID"
    },
    "projectId": "prj_REPLACE_WITH_REVIEWED_ID",
    "deploymentId": "dpl_REPLACE_WITH_REVIEWED_ID",
    "environment": "production",
    "revision": "0123456789abcdef0123456789abcdef01234567"
  },
  "credentialEnv": "DEVHUB_VERCEL_TOKEN",
  "checks": ["deployment"],
  "freshForSeconds": 3600
}
```

The adapter re-verifies the scope and reads only that deployment. Project ID,
deployment ID, environment and revision must all match. `READY` yields verified
deployment evidence; any other valid provider status is visible as `unknown`,
not a false pass. Changed identity, access denial, stale generic freshness or
invalid/partial response also remains unknown.

## Hard limits and failure semantics

The canonical connector contract declares a 10-second deadline, 20 requests,
1 MiB per response and 200 candidates. The generic runners enforce their
reviewed deadline/page/candidate bounds and the provider transport additionally
caps each JSON response at 2 MiB maximum. Fixed paths and query fields prevent
browser input from selecting an arbitrary origin or endpoint.

Access denial, rate limiting, timeout, malformed JSON, duplicate resource,
scope mismatch, repeated pagination cursor, exceeded bound or any partially
read project/domain set returns a stable unavailable reason. The normalized
result has unknown freshness and no partial candidates. Absence is never
interpreted as deletion.

## Live smoke without printing a token

Do this only on an operator machine with a reviewed binding. Do not paste a
token into a command, commit it, enable shell tracing, run `env`, or attach raw
provider responses to an issue.

```bash
read -rs DEVHUB_VERCEL_TOKEN
export DEVHUB_VERCEL_TOKEN
npm run devhub -- inventory /absolute/path/to/reviewed-vercel-binding.json --json > /tmp/devhub-vercel-smoke.json
unset DEVHUB_VERCEL_TOKEN
jq '{source, execution, freshness, candidates: [.candidates[] | {resourceType, resourceId, environment, status, urls, metadata}]}' /tmp/devhub-vercel-smoke.json
```

Confirm the source scope is exact, Production and Preview remain distinct, no
secret-shaped field is present and every unexpected/partial response is
unknown. Delete the temporary normalized output after review. A deployment
evidence smoke uses the existing `collect-evidence` command with a reviewed
catalog service and binding; apply the same credential and output rules. This
procedure does not authorize DevHub to perform provider or catalog mutations.

Official Vercel references:

- [REST API basics, authentication, team scoping, pagination and versioning](https://vercel.com/docs/rest-api)
- [Integration API read endpoints for teams and current user](https://vercel.com/docs/integrations/create-integration/vercel-api-integrations)
- [Vercel agent tools for exact projects and deployments](https://vercel.com/docs/agent-resources/vercel-mcp/tools)
- [Deployment environments](https://vercel.com/docs/deployments/environments)
- [CLI deployment listing and pagination](https://vercel.com/docs/cli/list)
