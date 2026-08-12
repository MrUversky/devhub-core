---
name: devhub-registry
description: Reconcile projects and runnable services with a self-hosted DevHub registry and answer operational questions from its catalog. Use when the user asks to register, add, sync, reconcile, update, find, open, start, recover or inspect a project or service; asks where something runs, whether it is reachable, safe, monitored, backed up or recoverable; asks for an App Passport, portfolio review or production-readiness review; reports a changed URL, host, health check, lifecycle or runtime; or asks to detect DevHub catalog drift.
---

# DevHub Registry

Treat the configured DevHub instance as the operational map for its owner. Use available DevHub MCP tools for read-only catalog lookup and use the local filesystem plus reviewed Git changes for reconciliation. Never mutate a catalog through MCP.

## Route the request

- For “where is it?”, “is it up?”, or “how do I open, start, or recover it?”: query an available DevHub MCP server and answer from catalog evidence.
- For “register”, “sync”, “update”, or a reported project change: inspect the current project, find its DevHub record, and prepare a minimal reviewed catalog change.
- For “check drift”: compare repository evidence with the current record and report `in-sync`, `drift`, or `unknown`. Prefer `unknown` over an invented fact.
- For “is this safe?”, “how production-ready is it?”, or “create an App Passport”: inspect evidence for the selected readiness profile and propose explicit `verified`, `declared`, `missing`, `not-applicable`, or `unknown` checks.
- For “review everything I shipped” or “what should I fix first?”: use `review-portfolio --json` from an available checkout, treat every result as a catalog evidence question, and prioritize the highest-harm reversible next action. Do not report a percentage or imply that unknown proves a production defect.

## Find the DevHub instance

Use DevHub MCP tools when they are configured. Identify them by their tool names and descriptions rather than assuming a server namespace or URL:

- `list_projects` for orientation;
- `search_projects` for names, aliases, repositories, and services;
- `get_project` and `get_service` for reviewed metadata;
- `get_status` for current observation, source, and freshness;
- `get_runbook` for copy-only operator guidance;
- `plan_reconciliation` for a read-only comparison with structured repository evidence.

If no DevHub MCP server is available, look for a local checkout supplied by the user, the workspace, or repository instructions. Do not guess an endpoint, owner, repository, home directory, or absolute path. Explain how to configure the user's instance when neither MCP nor a checkout is available.

Search before creating anything. Match by stable ID, repository, workspace, title, or alias so a renamed display label does not create a duplicate. Treat status source and observation time as part of every status answer. A catalog entry or stale reported state is not live proof.

## Inspect the project

Read repository instructions before acting. Inspect only relevant evidence, normally:

- Git remote and repository root;
- an existing `.devhub/project.yaml`;
- package scripts and framework configuration;
- Compose files and checked-in launchd or systemd definitions;
- documented URLs, health endpoints, and operating commands;
- the user’s explicit statement about what changed.

Do not use blind port scanning. A listening port does not establish ownership, lifecycle, visibility, or a safe recovery action. Never copy passwords, tokens, cookies, private keys, connection strings, or secret-bearing query parameters into a manifest or report.

## Inspect operational readiness

Use the service's App Passport as an evidence ledger, not a score guessed from framework conventions. Select the smallest fitting profile: `personal`, `internal`, `customer-facing`, or `sensitive`. Record only non-secret operating facts that can be reviewed: owner or accountable role, data classification, cost model, deployment provider/revision/time and critical dependencies. Review monitoring, alerting, backup, restore, rollback, security review, privacy, ownership, cost, and deployment evidence when they apply.

- Mark `verified` only when a reproducible check, reviewed document, or approved integration supports it. Include provenance and freshness.
- Use `declared` for an operator statement that has not been independently checked, `missing` for a known gap, and `unknown` when the evidence is absent or inconclusive.
- Use `not-applicable` only with an explicit reason. Do not convert an inconvenient unknown into not-applicable.
- Treat expired evidence as stale. Recommend a new observation instead of repeating the old conclusion as current.
- Never place secrets or secret-bearing URLs in evidence notes. Link to reviewed documentation, not credentials.
- Dependency records identify a provider or safe console/status/documentation link; never copy a database connection string, provider token or raw configuration.
- Prioritize the next action by likely harm and reversibility: exposure and data loss before cost and convenience.

An App Passport does not replace monitoring, backups, a security review, or a deployment system. It makes their presence, absence, source, and freshness inspectable from the same operational map.

## Choose the ownership boundary

- Use `registration: native` only when the repository is controlled by the owner and the metadata belongs with the project. Maintain `.devhub/project.yaml` and its reviewed catalog copy.
- Use `registration: overlay` for shared, client, external, or politically noisy repositories. Change only `catalog/projects/<project-id>.yaml` in DevHub; never add DevHub files to the other repository.
- Preserve stable kebab-case IDs. Do not rename an ID merely to improve its label.
- Register separate services when URLs, processes, hosts, health, owners, or lifecycles differ. Represent the same application running on two computers as two service instances.
- Require an explicit mode: `always-on`, `on-demand`, `managed`, or `internal`. A stopped on-demand service is not an incident.

If ownership cannot be established, prepare the evidence and ask one focused question before modifying a repository.

## Reconcile safely

Locate the relevant DevHub checkout dynamically. Accept, in order:

1. the current repository when it contains the DevHub catalog and CLI;
2. a checkout supplied by the user, environment, or repository instructions;
3. a repository location discovered from configured project metadata and accessible through authenticated Git tooling.

Do not clone or modify an arbitrary repository solely because its name resembles DevHub. If catalog repository access is unavailable, stop after producing a proposal and explain the missing access.

Within the located checkout:

1. Read its root `AGENTS.md` and registration documentation.
2. Run `npm run devhub -- reconcile <project-directory> --json` when the project is locally inspectable.
3. Reconcile the existing record instead of generating a second record.
4. Present the proposed manifest diff before applying uncertain facts.
5. Apply only user-authorized changes. Keep the dashboard and MCP read-only.
6. Follow the checkout's required validation commands. When unspecified, run `npm run devhub -- validate --check`, `npm test`, and `npm run lint`.
7. Review the diff for secrets, unrelated changes, and generated catalog consistency.
8. Publish through a reviewable Git branch or pull request when requested. Never push directly to a protected default branch or merge automatically unless the user explicitly authorizes it.

For a native record, leave the project-owned manifest consistent. If that requires a second repository change, report the two review units separately.

## Answer operational questions

Lead with the useful next action:

- open the canonical URL when it is reachable from the current device;
- name the required host when a local service lives elsewhere;
- explain that stopped is normal for an on-demand service;
- provide the reviewed runbook command and the host on which it must run;
- distinguish a live probe from reported or catalog-only state.

MCP is lookup-only. Never claim that `get_runbook` executed a command. Execute operational commands only when the user separately asks and the surrounding task authorizes the action.

## Finish

Report:

- matched project and service IDs;
- evidence that changed or remained uncertain;
- App Passport gaps, stale evidence, and the safest next improvement when readiness was requested;
- whether the catalog is `in-sync`, `drift`, or `unknown`;
- files changed and validation results, if any;
- the exact next action, host, and URL or runbook where relevant.

Do not require a special incantation. Requests such as “add this admin service to DevHub”, “sync this project”, “the URL moved”, and “where is this running?” should all enter this workflow.
