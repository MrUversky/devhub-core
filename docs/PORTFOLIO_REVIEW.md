# Portfolio review

`review-portfolio` turns the reviewed DevHub catalog into a read-only queue of
operational questions. It is for deciding what to inspect next, not for
certifying an application or inventing a readiness score.

```bash
npm run devhub -- review-portfolio
npm run devhub -- review-portfolio --json
```

Without evidence bindings, the command does not scan ports, contact providers,
probe URLs, execute runbooks or change manifests. It reads only
`catalog/hosts.yaml` and the validated manifests in `catalog/projects/*.yaml`.

To refresh exact reviewed provider evidence before the review, pass one or more
binding files:

```bash
npm run devhub -- review-portfolio --json \
  --evidence-binding ./config/evidence-bindings/example-release.json
```

Bindings are checked against the validated catalog before any network request.
The project and service must exist. When the service has a reviewed repository
link, a GitHub binding must match it exactly; only services without that link
may fall back to the project repository. The CLI accepts only registered
read-only adapters; it does not accept prebuilt or forged normalized results.
Provider failure remains `unknown`. Collection returns candidates; it does not
update the App Passport.

The public `example-release.json` is a fictional template, not a live provider
resource. Replace its exact release identity with reviewed values before using
it in a real installation.

## What it reviews

For services with an App Passport, the selected operating profile defines a
small set of expected evidence:

| Profile | Expected checks |
| --- | --- |
| `personal` | backup, restore, rollback, ownership, cost, deployment |
| `internal` | monitoring, backup, restore, rollback, ownership, cost, deployment |
| `customer-facing` | monitoring, alerting, backup, restore, rollback, security review, privacy, ownership, cost, deployment |
| `sensitive` | the same full set, with higher scrutiny for data loss and exposure evidence |

An explicit `not-applicable` item satisfies an expectation only because its
reviewed note explains the decision. A current `verified` item also satisfies
it. A declaration is retained as evidence but produces an `unknown` review
state until verified. Expired verification produces `stale`; a recorded gap
produces `missing`; absent evidence produces `unknown`.

The review also identifies:

- always-on services with neither a reviewed probe nor current verified
  monitoring evidence;
- services with no App Passport profile;
- services with no reviewed logs or recovery entry point and no rollback or
  restore evidence;
- a normalized deployment identity, service URL or host that differs from the
  exact reviewed binding and catalog record;
- expired normalized backup or restore evidence;
- an exact reviewed resource reporting a recurring cost while its project is
  `paused` or still in `discovery`.

Provider drift is a review question, never an action. Every such finding keeps
the adapter ID, provider, reviewed resource identity, evidence ID, observation
time, freshness and safe evidence URL when supplied. It states what remains
uncertain and offers one next action: owner review followed by a reviewed
catalog decision. It never deletes, pauses, restarts or migrates a resource.

Only the newest normalized result for the same exact binding is evaluated.
Provider failure or stale cache produces `unknown` or `stale`, never drift or a
passing state. Results for identities that do not match the current catalog are
not treated as discovered resources and cannot trigger enumeration.

Provider fields are compared only when their reviewed identity declares the
same namespace: `resourceId` or `deploymentIdentity` for deployment identity,
`serviceUrl` for the user-facing service URL and `catalogHost` for a DevHub host
ID. A provider deployment ID, console URL or environment name is useful linked
evidence but must not be compared with a catalog resource, URL or machine host.
Without an explicitly comparable reviewed field, Guardian stays silent instead
of inventing drift.

Every finding includes `project`, `service`, `check`, derived `state`, exact
catalog `evidence` or `null`, a human-readable `reason`,
`recommendedNextAction` and `severity`. Findings are sorted deterministically;
the JSON object contains counts, never a percentage or aggregate score.

## Review workflow

1. Run the JSON form and select the highest-severity reversible improvement.
2. Inspect the owning project and external system that can supply evidence.
3. Propose a minimal manifest diff. Never paste secrets, raw logs or backup
   payloads into DevHub.
4. Review the evidence state, provenance and freshness, then merge the catalog
   change through Git review.
5. Run `npm run devhub -- validate --check`, `npm test` and `npm run lint`.
6. Only then verify the accepted facts in the dashboard and MCP. Both remain
   catalog-only and must not display an unreviewed collection candidate.

A false positive is closed through reviewed evidence, not a hidden dismissal:

- update the reviewed catalog URL or host after confirming the move;
- update the exact adapter binding after confirming a resource replacement;
- add a newer `verified` evidence item for the same check; or
- record an explicit `not-applicable` item with a human-readable reason.

For deployment, backup, restore and cost findings, a current catalog evidence
item suppresses an older normalized observation only when it is `verified` and
at least as recent. An explicit current `not-applicable` reason also resolves
the review. `declared`, missing and undated verification cannot silently turn
provider drift green.

Unknown is not a failure claim. A catalog-only review cannot prove that a
backup is absent, a service is unsafe or an owner does not exist; it says that
DevHub lacks reviewed current evidence. Provider integrations may supply that
evidence later, but monitoring, security, backup and billing systems remain
the systems of record.
