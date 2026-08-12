# Portfolio review

`review-portfolio` turns the reviewed DevHub catalog into a read-only queue of
operational questions. It is for deciding what to inspect next, not for
certifying an application or inventing a readiness score.

```bash
npm run devhub -- review-portfolio
npm run devhub -- review-portfolio --json
```

The command does not scan ports, contact providers, probe URLs, execute
runbooks or change manifests. It reads only `catalog/hosts.yaml` and the
validated manifests in `catalog/projects/*.yaml`.

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
  restore evidence.

Every finding includes `project`, `service`, `check`, derived `state`, exact
catalog `evidence` or `null`, a human-readable `reason`,
`recommendedNextAction` and `severity`. Findings are sorted deterministically;
the JSON object contains counts, never a percentage or aggregate score.

## Review workflow

1. Run the JSON form and select the highest-severity reversible improvement.
2. Inspect the owning project and external system that can supply evidence.
3. Propose a minimal manifest diff. Never paste secrets, raw logs or backup
   payloads into DevHub.
4. Review the evidence state, provenance and freshness before merging.
5. Run `npm run devhub -- validate --check`, `npm test` and `npm run lint`.

Unknown is not a failure claim. A catalog-only review cannot prove that a
backup is absent, a service is unsafe or an owner does not exist; it says that
DevHub lacks reviewed current evidence. Provider integrations may supply that
evidence later, but monitoring, security, backup and billing systems remain
the systems of record.
