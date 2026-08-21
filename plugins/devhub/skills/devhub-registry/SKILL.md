---
name: devhub-registry
description: Set up, refresh and reconcile projects and runnable services with a self-hosted DevHub registry, then answer operational questions from its catalog. Use when the user asks to set up DevHub, connect tools or everything they can access, build their map, refresh DevHub, register, add, sync, reconcile, update, find, open, start, recover or inspect a project or service; asks where something runs, whether it is reachable, safe, monitored, backed up or recoverable; asks for an App Passport, portfolio review or production-readiness review; reports a changed URL, host, health check, lifecycle or runtime; or asks to detect DevHub catalog drift.
---

# DevHub Registry

Treat the configured DevHub instance as the operational map for its owner. Use available DevHub MCP tools for read-only catalog lookup and use the local filesystem plus reviewed Git changes for reconciliation. Never mutate a catalog through MCP.

## Route the request

- For “set up DevHub from scratch”, “install DevHub in a blank Codex”, “set up
  my community DevHub”, or an equivalent first-run request: follow
  **Community first-run bootstrap** below before ordinary Connected Setup. Do
  the machine work yourself and ask only recognizable choices plus explicit
  write approvals; do not turn the installation guide into user homework.
- For “add my private Sites companion”, “show my DevHub in Sites”, or an
  equivalent request after community first run: follow **Owner-only Sites
  companion** below. Use the installed Sites building and hosting workflows,
  but keep create/reuse and publish as distinct explicit approvals.
- For “set up my DevHub”, “connect everything I can access”, “Build my map”, “refresh my DevHub”, or “подключи всё, к чему у меня есть доступ”: first verify the local workflow runtime under **Verify the Connected Setup runtime** below. Then run `devhub setup --json`, or its wrapper from the one explicitly supplied compatible checkout. Report recommended connectors, exact detection evidence and the Build-my-map plan. Detection is not authorization or account access: do not start OAuth, open provider pages, read credential values or modify the catalog. A planned connector remains planned even when its local marker is detected.
- For “where is it?”, “is it up?”, or “how do I open, start, or recover it?”: query an available DevHub MCP server and answer from catalog evidence.
- For “make this host live” or “configure host monitoring”: when an exact reviewed probe contains `publish.type: tailscale-serve`, preview it on that target with `devhub setup-host-monitoring <host-id> --json`. Use `--apply` only when the user asked to configure monitoring and the preview has no identity or path conflict. Never enable Funnel or run `tailscale serve reset`.
- For “register”, “sync”, “update”, or a reported project change: inspect the current project, find its DevHub record, and prepare a minimal reviewed catalog change.
- For “check drift”: compare repository evidence with the current record and report `in-sync`, `drift`, or `unknown`. Prefer `unknown` over an invented fact.
- For “is this safe?”, “how production-ready is it?”, or “create an App Passport”: inspect evidence for the selected readiness profile and propose explicit `verified`, `declared`, `missing`, `not-applicable`, or `unknown` checks.
- For “review everything I shipped” or “what should I fix first?”: use `review-portfolio --json` from an available checkout, treat every result as a catalog evidence question, and prioritize the highest-harm reversible next action. Do not report a percentage or imply that unknown proves a production defect.
- For “refresh provider evidence”: use `collect-evidence <binding.json> --json`, or pass reviewed binding files to `review-portfolio --evidence-binding`. Never accept a prebuilt normalized result as production evidence.
- For “what exists in Railway/provider?” or a remote-only project with no checkout: use `inventory <binding.json> --json` with an explicitly reviewed bounded scope. Treat repository, domain and name as possible-match evidence only; exact matching and reviewed-external classification require a reviewed decision in the binding document.

Collected provider evidence is a transient candidate, not a catalog mutation.
After review, propose a minimal YAML diff with provenance and freshness; only a
merged and validated catalog change may make the fact visible through the
dashboard or MCP. Never describe a successful collection as an already-updated
App Passport.

Provider inventory is also transient. An unregistered remote project may yield
a review-only overlay proposal, but the command never writes or applies it.
Never invent services, hosts, workspaces, commands or probes from provider
status. A missing resource is `unknown`, not proof that it is orphaned, unused
or safe to delete.

## Community first-run bootstrap

This is one Codex-led composition of existing contracts, not a second setup
engine. Use the public `MrUversky/devhub-core` repository and its
`devhub-community` marketplace. Keep all release JSON and command output
internal; speak in product choices and outcomes.

1. Perform a read-only platform preflight. The full path is supported on macOS
   and Linux. On Windows, say that installation, local discovery, dashboard
   service operation and a Windows service installer are not proven by this
   release; report the full first-run as unsupported and do not improvise around
   that boundary.
2. Ask exactly one deployment choice: **Run on this computer (recommended)**
   for Docker on loopback, **Use an existing private Linux host**, or **Not
   now**. The remote option requires an explicitly selected known host,
   separately approved access and an existing reviewed private dashboard/MCP
   boundary. Never create ingress, a firewall rule, VPN, proxy, DNS or
   Tailscale route to make it work.
3. Resolve one exact annotated public tag and its GitHub Release. Never use
   `main`, `latest`, a lightweight tag or mixed releases. Download source,
   runtime, installer, SBOM, `SHA256SUMS`, `RELEASE-EVIDENCE.json` and the
   published platform reports into a new temporary directory. Verify the tag
   and peeled public commit, release tag, every checksum, format/version, clean
   source state and bound artifact digests. Stop on unknown or contradiction.
4. Show the exact version and user-owned paths, then request **Install the
   verified DevHub CLI**. Only that approval permits the checksum-pinned
   standalone installer. Never use `npm -g`, `sudo`, an unpinned URL or a
   checkout symlink. Run both `devhub doctor --workflow --json` and `devhub
   doctor --install --json` internally before any provider I/O.
5. If the generic plugin is not installed, preview and install the same exact
   tag with `codex plugin marketplace add MrUversky/devhub-core --ref
   <EXACT_TAG>` and `codex plugin add devhub@devhub-community`. The plugin has
   no endpoint or secret. If Codex must restart to load it, return one resume
   prompt; do not claim the current process loaded new guidance.
6. Ask only for explicit local folders, supported provider sources and one
   recognizable reviewed/proposed host identity. Never infer home-directory
   roots, broaden provider scope, start authorization or ask the user to
   assemble JSON. Treat every source as unselected until named.
7. Preview a separate user-owned Git catalog repository, normally with
   `catalog/` below `${XDG_DATA_HOME:-$HOME/.local/share}/devhub/catalog-repository`.
   Refuse cloud/FileProvider paths, unmanaged non-empty destinations and dirty
   catalog repositories. Use the existing `devhub init-catalog` preview, show
   the planned paths and initial commit, then request **Create the catalog
   repository** before `init-catalog --apply`, `git init` and that commit.
   Validate and record the exact catalog commit. Do not modify discovered
   project repositories.
8. Run the existing `devhub onboard` with only selected sources/roots, the
   host ID and explicit catalog/profile/generated paths. Present its first
   ambiguity in plain language. Keep the artifact-bound review and approved
   plan outside the catalog repository. `onboard` remains preview-only.
9. Preview `devhub onboard-apply` and show the exact planned catalog paths.
   Request **Create the isolated catalog proposal** before `--apply`. The
   existing apply contract alone owns plan/revision/fingerprint/freshness,
   lock, worktree, validation and cleanup. Repeat the same exact apply and
   require `already-committed` with the same commit. Accepting or merging the
   local proposal is another explicit boundary; never merge automatically.
10. Extract the verified source archive to a versioned user-owned application
    directory. For local Docker, preview version, accepted catalog commit,
    host, `127.0.0.1` and port; then request **Start the local dashboard**.
    Set `DEVHUB_CATALOG_CONTEXT` to the separate catalog checkout and
    `DEVHUB_INSTANCE_MODE=private`. Never set the bind address to `0.0.0.0`.
11. For the selected Linux host, use only the reviewed portable systemd path.
    Prefer `DEVHUB_RELEASE_TAG` plus its separately verified
    `DEVHUB_EXPECTED_COMMIT`; never configure a tag and branch together. Keep
    the catalog external. System-user, root-owned config, service update and
    restart remain separate explicit host-write approvals. There is no timer.
12. Verify dashboard health, MCP initialization and `serverInfo`, exact runtime
    version, one read-only catalog query, catalog revision/fingerprint and an
    unchanged second preview. A remote URL must be the already reviewed private
    HTTPS endpoint; another computer's loopback is not a working result.
13. Run `devhub agent-setup codex` internally and show the recognizable MCP
    endpoint/auth boundary. Only **Connect this Codex to DevHub** permits the
    `codex mcp add` write. Never show or request a token value.
14. Finish with exact tag/version/source identity, deployment/host, catalog
    base/proposal, selected sources/roots, unresolved items, dashboard URL, MCP
    endpoint, verification and scoped recovery. Include CLI rollback/uninstall,
    exact catalog-branch revert, Docker down or prior systemd release restore,
    and removal of only the DevHub MCP/plugin entries. Preserve the catalog and
    configuration by default.

The full public operator/evaluator contract is in
`docs/COMMUNITY_BOOTSTRAP.md`. An optional Sites companion is a later view and
never replaces this canonical backend.

## Owner-only Sites companion

Run this only after the community bootstrap proves the canonical self-hosted
dashboard, MCP, exact public release and exact reviewed catalog revision.
Missing proof stops this optional view; it does not make first run fail.

1. Verify the same exact annotated public tag/source manifest and require the
   user catalog Git repository to be clean at its reviewed commit. Accept only
   one exact private HTTPS canonical backend origin. Another device's loopback,
   mutable source, dirty catalog or guessed endpoint stops the workflow.
2. Read the optional external version 1 companion binding. It may contain only
   project ID, exact Site origin and current/prior version IDs. Never read or
   reuse a shared `.openai/hosting.json`, another owner's private project/binding or a
   project found only by a common display name.
3. Run `devhub sites-companion` without `--apply` and summarize exact release,
   catalog revision, create/reuse action, fixed backend origin and owner-only
   access. Only **Prepare this private companion** permits the identical
   `--apply`, which writes a fresh temporary staging directory and nothing
   else.
4. Require the staged transform to keep only the catalog fields needed by the
   view and to remove profiles, credentials, locators, access facts, stewards,
   workspaces, readiness, URLs, commands, probes and reported state. It must
   omit `/api/context`, `/api/status`, `/mcp` and `.openai/hosting.json` while
   recording exact source/catalog provenance. Scan the staged output before
   Sites work.
5. Use the installed Sites building/hosting connector contracts. Do not invent
   arguments. Prove custom/private access with exactly the invoking owner, zero
   groups and zero external visitors. If that cannot be created or verified,
   stop rather than publish shared/public. A valid binding means reuse exactly
   that project; otherwise **Create this owner-only Site** is a separate
   approval and creates no deployed version.
6. Add the connector-returned project ID only to `.openai/hosting.json` inside
   temporary staging. Configure `DEVHUB_SITES_COMPANION=owner-only` and one
   origin-only `DEVHUB_STATUS_API_BASE_URL` through Sites runtime values, not
   Git. Never put a token, CORS wildcard, endpoint path/query or owner binding
   into public source.
7. The canonical backend separately allows only the exact Site origin for
   credential-free `/api/status` reads. Do not expose `/api/context` or MCP and
   never create a Worker relay, tunnel, Funnel, public ingress, token or
   provider authorization. If the reviewed backend change is unavailable,
   report the prerequisite.
8. Build and show one private preview. The viewer browser is the only status
   transport and uses `credentials: "omit"`. Validate response schema, known
   service keys and timestamps. Clear prior observations on failure; unknown,
   unavailable, duplicate or stale evidence never renders as `LIVE`.
9. Only **Publish this private companion** permits saving and privately
   deploying the exact previewed version. Recheck one owner/no groups/no
   external visitors after success, then atomically record the external
   binding. A failed publish leaves the prior binding/version unchanged.
10. An unchanged rerun must reuse the same project ID. Rollback restores only
    the recorded prior Site version after approval. Removing the binding removes
    only that external record; Site deletion, access changes, backend changes,
    catalog removal and canonical DevHub removal are separate actions.

The full product and recovery contract is in `docs/SITES_COMPANION.md`. This is
not a second setup engine, hosted monitoring/control plane, SaaS, browser OAuth,
schema-v2 migration, resident agent, automatic deploy or unrelated workflow.

## Verify the Connected Setup runtime

Before any Connected Setup marker probe, profile load, provider-tool action or
provider I/O, select one compatible local runtime:

1. Prefer a user-wide `devhub` already available on `PATH`. Do not add a
   project checkout or its `node_modules` to `PATH` to make this check pass.
   Run `devhub doctor --workflow --json` and keep its output internal.
2. If no compatible user-wide command exists, use the current checkout only
   when the user, task or repository instructions explicitly supplied that
   exact checkout for DevHub setup. Merely having a DevHub-looking package,
   directory name, catalog or CLI in the current working directory is not
   supply. Run `npm run devhub -- doctor --workflow --json` in that exact
   checkout.
3. Accept only the exact workflow contract recognized by the canonical
   `isWorkflowContract` policy: contract version 2, a semantic runtime version,
   and exactly `setupRun: 1`, `connectionReview: 1`,
   `guidedConfirmation: 1` and `taskObservation: 1`, with no missing, drifted
   or extra fields. The
   command is a non-secret local capability check; never ask the user to read
   or interpret its output.

The portable Codex plugin supplies guidance only. A configured DevHub MCP
connection supplies read-only catalog tools only. Neither installs or proves a
local Connected Setup runtime, and MCP alone never makes setup runnable from an
arbitrary project. The any-project path exists only when the user-wide
`devhub` command passes the exact workflow check above.

If both candidates are missing, return nonzero, or fail the exact contract,
stop before provider I/O. Do not manually fall back to `setup-session`,
`discovery-inbox` or other lower-level commands when `setup-run` is missing.
Show one human blocker and wait:

- **DevHub needs an update**
- **Help me update DevHub** — after approval, use only an approved installation
  or update source. Require the runtime archive, matching standalone installer,
  `SHA256SUMS` and `RELEASE-EVIDENCE.json` from one pinned exact-commit
  candidate or release; verify the checksums, then invoke the standalone asset
  as `node /absolute/path/devhub-install-v<VERSION>.mjs install --archive
  <absolute-path> --sha256 <pinned-digest>`. An already-installed CLI may use
  `devhub-install` for an explicit pinned upgrade. Repeat the workflow check
  before setup. Never use `npm -g`, an unpinned URL, `sudo`, an unattended
  updater or a symlink to a checkout.
- **Not now** — stop without probing or connecting a source.

Do not show the contract object, JSON, internal capability names or command
failure details in that blocker. The workflow check and update route perform
zero provider I/O. After an approved install, run `devhub doctor --install
--json` internally. If the stable external catalog is not configured, offer
the reviewed `devhub init-catalog
${XDG_DATA_HOME:-$HOME/.local/share}/devhub/catalog ...` preview from the
installation guide before `setup-run`; never invent the host identity or write
without a separately reviewed `--apply`.

## Build the first map and refresh it

Connected setup is a plan, not a discovery permission. After `setup --json`:

1. Explain which recommended connectors have local markers and which do not.
2. Name each connector's supported connection method and safe next step. Never
   claim that a CLI marker proves a login or that a planned connector works.
3. Use the current workspace reconciliation flow for local projects. Use
   provider inventory or evidence collection only through an exact reviewed
   binding; never broaden a provider scope because the user said “everything”.
4. Present ambiguous matches, owners and possibly unused resources for review.
   Apply nothing merely because setup completed.
5. For “refresh my DevHub”, reuse the reviewed catalog, MCP and existing
   bindings. Report only new, changed, stale or unclear evidence and prepare a
   reviewable diff when needed.

When a Connected Setup request names selected sources, verify the exact local
workflow contract first. If it is unavailable, show **DevHub needs an update**
and perform zero provider I/O. After verification, treat the selection itself
as permission for supported safe read-only checks of those sources. Never call
an unselected source.

Before showing any connection action, exhaust the selected sources' safe paths:
reviewed exact profiles, the current computer when selected, and already
callable signed-in provider tools whose connector-owned contract marks the
operation read-only. Do not open sign-in, request new authorization or invoke a
write action during this phase. Complete these checks yourself; do not ask the
user to run the CLI, assemble JSON or interpret machine output.

After those checks, lead with human progress: **N of M sources are ready.** Do
not count task-only access as a saved connection.

For every selected source, keep the human result to two separate facts:

- **Checked now:** reuse a recognizable account, team, workspace, project or
  computer label and aggregate item count already returned by the bounded
  check, or **Not checked**. Never make another provider or tool call only to
  obtain a human label; if no label was returned, use the source display name
  with the aggregate count;
- **Saved connection:** **Yes** for a current reviewed reusable connection;
  **Yes · needs recheck** for an existing reviewed profile whose state is
  reconnect, stale or authorization-required; **No** for task-only access or
  when no reviewed profile exists. A successful bounded recheck may clear the
  attention state to **Yes**. Never describe an existing stale profile as
  **No** merely because it was not ready in this run.

One exact recognizable scope continues automatically. A task-scoped plugin
session with one scope also runs its bounded read automatically and contributes
only transient review-only candidates to the first map. It is checked for this
task, not saved, and never becomes a profile or catalog truth. If several
recognizable scopes are available, ask exactly one plain-language scope choice
for that source. If new authorization is required, ask one source question and
show only the still-relevant connector-owned actions. Do not show **Use current
sign-in**, **Use a saved connection**, **Help me connect** or **Not now** before
the automatic checks establish that a choice is actually needed.

Only multiple scopes or new authorization may block the connection stage.
Questions remain one source at a time. Keep passwords, MFA, consent, one-time
codes and new-token creation in provider or operating-system UI; never ask the
user to paste them into chat. Report recognizable labels and counts only; never
emit JSON, profile IDs, raw scope IDs, schemas, credential references or
locators. Planned, unsupported and binding-only sources never gain an invented
provider-tool path.

Continue into candidate triage without requiring reusable persistence. After
useful results, offer **Save <source> for future refresh** as an optional,
non-blocking action. Only if the user chooses it may one later confirmation
review the exact recognizable scope and a runtime-supported reusable method.
Task OAuth or a resource list alone never permits **Save and continue**, a
profile proposal or a hidden write.
Provider-specific behavior must come from the connector-owned capability; do
not invent a browser, plugin or persistence path.

For the deterministic five-source forward-test case, keep the unique
already-authorized Vercel task session automatic and report **Saved connection:
No** for it. Railway remains the one connection blocker when no callable
session or reviewed reusable access is available, so ask exactly one Railway
question. Any existing stale reviewed profile remains **Saved connection: Yes ·
needs recheck**, never **No**. Persistence remains optional afterwards.

### Connected Setup machine handoff

Keep these mechanics behind the conversation:

1. Resolve the selected display names through the canonical connector catalog;
   fail on an unknown or ambiguous name and never add another source. Begin only
   after the local runtime passes workflow contract v2 with
   `taskObservation: 1`. A separate `setup --json` marker preview is optional,
   never a prerequisite or a provider check.
2. Read the connector-owned task-observation bridge registry from that verified
   runtime. A bridge only defines a safe normalization boundary; it does not
   prove that a provider plugin, signed-in session or read-only tool is callable.
   For each selected eligible source, invoke only an already callable read-only
   tool. With one recognizable scope, collect its bounded labels automatically;
   with several scopes, ask one recognizable choice; for new authorization, ask
   before opening it or defer. Never invoke an unselected source.
3. Keep task-tool output internal. Build one transient task-observation document
   for the full canonical selection with 1..N unique eligible observations in
   canonical order. Each observation carries only the connector and bridge IDs,
   observation time, one recognizable scope kind/label and bounded project
   kind/labels. Never include raw provider IDs, URLs, metadata, credentials,
   locators or secrets. Write it to an absolute temporary path outside the
   checkout and keep it current within the runtime's five-minute bound.
4. Run the original selection exactly once with
   `devhub setup-run --sources <canonical-comma-list> --task-observation
   <absolute-transient-file> --json` (or its npm wrapper), then remove the file.
   If no eligible task observation exists, omit only the task-observation option.
   Do not run a baseline setup-run first. Saved profiles collect once in this
   canonical run; task-observed sources perform zero provider and credential I/O
   inside DevHub, and all results feed one Discovery artifact.
5. Treat `taskObservations.checkedThisTask` as **Checked now**. Derive each
   **Saved connection** value from the per-source reviewed-profile existence
   and preflight state: current reviewed reusable is **Yes**; reconnect, stale
   or authorization-required reviewed access is **Yes · needs recheck**;
   task-only or no reviewed profile is **No**. Aggregate saved/task-only counts
   are summaries, not a substitute for this per-source distinction. Task-only
   preflight readiness stays unchanged, no connection profile is proposed or
   written, and task evidence may produce only possible, new or unknown review
   candidates—never an exact match.
6. If the canonical result still contains a real multiple-scope or new-
   authorization blocker, handle only its first question through the existing
   connector-owned conversational and `--connection-review` contract. Never
   batch, skip or combine that continuation with task observations. A returned
   reusable profile operation remains a stdout-only proposal and requires the
   normal reviewed config diff before any write.
7. After every real connection blocker is resolved or explicitly deferred,
   report known matches by count, show possible matches with reasons, and group
   new candidates by source/count before expanding a chosen group. Offer task-
   source persistence only after this triage and only as an optional action. If
   no profile or catalog diff is accepted, run only `devhub validate --check`
   and report no diff. Never merge or deploy automatically.

For a completed bounded session, run
`devhub discovery-inbox <profiles.json> <session.json> [review.json] --json`.
Treat its `artifactId`, `candidateId`, evidence source, freshness and
uncertainty as one review unit. Present its bounded `questionGroups` first;
every choice still binds to an individual candidate. Ask follow-up product
identity, environment, owner and payer questions only for resources the
reviewer chose to track. Never copy an unreviewed `new` or
`possible-match` candidate into the catalog. A printed proposal is stdout-only
until it is reviewed, validated and merged through Git.

These lower-level commands are available only for an explicitly requested
maintainer audit or fixture review. They are never a compatibility fallback for
an absent or outdated `setup-run`; show **DevHub needs an update** instead.

Codex gets guidance from the plugin. Claude Code and Cursor can receive the same
guidance through `devhub agent-setup`; no client receives a local setup runtime
from MCP or from guidance alone, broader authority or a separate source of
truth.

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

Provider bindings live outside project manifests. Before collection, require an
exact catalog project/service match and an allowlisted adapter. A GitHub binding
must match the reviewed service repository link when one exists; only services
without that link may fall back to the reviewed project repository.
An absent named credential is `unknown`; public anonymous reads are allowed only
when the binding omits `credentialEnv`. Release evidence proves released source
identity, not live runtime health.

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
