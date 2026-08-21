# Connected Setup

Connected Setup is the guided way to turn scattered software context into a
reviewed DevHub catalog. A builder starts from the tools they already use,
collects only bounded non-secret observations, and reviews the few facts that
cannot be established safely.

It is a setup and reconciliation experience, not a provider control plane.
The current dashboard does not contact providers. Including a source authorizes
the later coding-agent task to use supported already-authorized read-only checks
for that source. It never grants permission to sign in, deploy, restart, delete,
rotate credentials or silently add catalog records.

## User journey

The public landing presents three sequential product stages: **Get DevHub →
Connected Setup → Demo workspace**. The first stage gives a three-step path
from an authorized current-alpha source release or checkout to a local
dashboard. Its primary action prepares an installation request for a coding
agent; it does not invent an npm package or imply that a private GitHub release
is publicly downloadable.

Once DevHub is running, the dashboard has one honest two-step setup handoff:

1. **Choose sources** — include only the sources the later agent may check
   read-only. Nothing runs on the page. Status describes the last reviewed
   check; selection does not sign in or save a connection. In a private workspace,
   the redacted catalog snapshot also produces one honest preflight summary:
   **N ready to check · M need your input**.
2. **Run with your coding agent** — copy one bounded request into Codex, Claude
   Code or Cursor. The agent completes the safe checks first, then guides any
   remaining connections one source at a time and returns a reviewable diff.

The internal runner still uses four operational stages—connect with an existing
reviewed authorization, build the bounded map, review unclear discoveries and
prepare the handoff. Those are real stages after the request is pasted, not
progress simulated by the dashboard. Setup is not complete when the request is
copied. Accepted facts appear only after a validated diff is merged and
deployed.

## Five-minute guided first run

The dashboard and coding-agent entry points are two views of the same setup,
not separate workflows. Starting from an installed DevHub:

1. Open DevHub and choose **Set up my DevHub** or **Prepare setup request**.
2. Include the sources that matter now. Start with GitHub and this computer;
   add a deployment or API provider only when it contains relevant projects.
3. Continue to **Run with your coding agent**. The second step shows the
   handoff in order: **Paste once → Run safe checks → Review your update**.
4. Open a new Codex, Claude Code or Cursor task on the computer that has the
   selected projects or sign-ins, then paste the copied request. For first
   setup use the DevHub workspace. After its workflow or MCP is installed for
   the agent, the task can start from another project. Run **This computer** on
   the computer that should be inspected.
5. After the exact workflow check passes, selection authorizes the agent to use
   reviewed profiles, the selected computer and already callable signed-in
   read-only tools. It runs those checks before showing connection actions and
   never calls an unselected source.
6. A single recognizable scope continues automatically. Several scopes produce
   one plain-language choice; new authorization produces one source question.
   Passwords, one-time codes and token values stay in provider or operating-
   system UI, not in chat.
7. Review exact, possible and new candidates from both reusable connections and
   task-only observations. Saving a source for future refresh is optional after
   this useful result; only a reviewed merge and deploy updates the dashboard.

The current alpha deliberately does not embed provider tokens, run OAuth or
host a general credential vault. Direct browser connections belong to a
separate `v0.13 — Direct connections` milestone: authenticated tenant sessions,
provider OAuth with exact-scope review, encrypted credential custody, bounded
jobs with real IDs and status, audit logs, rate limits and approval-gated
catalog proposals. Only that control plane may use **Connect**, **Queued** or
**Running** as real actions and states.

The dashboard itself has two presentation modes. A **Private workspace** is a
real reviewed catalog and may show redacted connection state for its own
profiles. The hosted **Public demo** shows which connectors are available and
lets a visitor try the setup journey, but it never becomes that visitor's
workspace. Both modes use the same product flow; only the private workspace can
contain a user's reviewed map.

### Dashboard interaction model

Connected Setup opens as one focused two-step dialog rather than expanding
between catalog sections. Its progress, content and persistent action bar stay
in the same viewport until the user closes the flow or deliberately chooses to
open the resulting catalog. Back and Continue change only the current setup
step; they never scroll the underlying dashboard.

The first step keeps connection state and setup selection visually separate:

- **Last check succeeded**, **Check expired**, **Access needed**,
  **Unavailable**, **Unknown** and **Not configured** describe reviewed source
  status;
- **Ready to check**, **Needs your choice**, **Sign in again** and **Needs
  another try** are capability-aware preflight states derived from the reviewed
  redacted snapshot, not live provider results;
- **Can inspect** describes the connector's supported product capabilities;
- **Include in this run** and **Included** describe whether that source
  participates in the current setup or refresh pass;
- reviewed existing connections are selected when the private flow opens;
- planned connectors live in a collapsed roadmap and cannot be selected.

The public demo starts with no selected sources and demonstrates the journey
without claiming that a visitor connected an account. It shows support and
capabilities only—never a ready count, access diagnosis, last check or private
preflight result. The private workspace
uses the same flow for reviewed connections and new sources. Its final action
copies one setup request for Codex, Claude Code or Cursor; the agent runs the
bounded collection and returns the catalog proposal for review.

The second step keeps the handoff compact. The three-part path is always
visible, while agent-specific placement is progressively disclosed under
**Which task should I open?** The dashboard does not render fake connection
cards or pretend to follow the external task. Its success state confirms only
that the request was copied. The agent owns the live guided conversation.

### Guided agent conversation

The copied selection is the read-only authority boundary for the later task.
After runtime verification, the agent first exhausts every supported safe path
for the selected sources; it does not ask the user to confirm an already
callable sign-in, reviewed profile or the selected computer.

Each source result keeps current access separate from persistence:

```text
Vercel
Checked now: Acme Team · 7 projects
Saved connection: No
```

The agent reuses the recognizable label and aggregate count already returned
by the bounded check. It does not make another provider or tool call just to
obtain a label; when no label was returned, it uses the source name with the
aggregate count.

A current reviewed reusable profile reports **Saved connection: Yes**. An
existing reviewed profile that is stale, needs reconnect or still requires
authorization reports **Saved connection: Yes · needs recheck** until a
successful bounded recheck clears that attention. Task-only access or a source
without a reviewed profile reports **Saved connection: No**. An existing stale
profile is never described as not saved.

One recognizable scope continues automatically and its bounded task
observation contributes review-only candidates to the first map. Several scopes
produce exactly one recognizable choice without raw IDs. Only multiple scopes
or new authorization may block the connection stage. Generic actions such as
**Use a saved connection**, **Help me connect** and **Not now** are not shown
before automatic checks establish that a choice is still needed.

A connector's task-observation bridge is only a safe normalization capability;
it does not mean that its plugin or signed-in read-only tool is installed or
callable in the current task.

Task-only access is never presented as saved. Candidate triage continues while
**Saved connection: No**. After useful results, **Save <source> for future
refresh** may appear as an optional action; choosing it starts a separate exact-
scope and supported-method review. It does not retroactively turn a task tool
result into a connection profile.

In the five-source forward test, the unique already-authorized Vercel task
session is checked automatically and reports **Saved connection: No**. Railway
remains the one connection blocker when it has neither callable task access nor
reviewed reusable access. Any stale reviewed profile stays **Saved connection:
Yes · needs recheck**.

Human output contains recognizable names and counts rather than JSON, schemas,
review IDs, credential locators, profile IDs or raw provider IDs. The agent
never calls an unselected source, asks for a secret in chat or writes provider
or catalog state.

The public home keeps setup distinct from its **Demo workspace**. Setup teaches
how the bounded request is prepared; the demo uses six example projects and
varied lifecycle, runtime and evidence states to show the resulting catalog.
Project, service and runtime-host totals sit inside the demo workspace beside
the catalog rather than in the hero. Guardian definitions are attached to the
individual metrics as accessible help controls instead of a separate
explanation panel. Neither path creates a visitor workspace or claims that a
provider was contacted.

Outside setup, the catalog toolbar contains only search and lifecycle filters.
Private device identity and service-observation freshness live in a separate
**Device context** bar because they change how local services are interpreted,
not which projects match the catalog query. The public demo hides the viewer's
device identity and every private catalog or connection profile. It still shows
fictional reviewed hosts and service placement because understanding where a
service runs is part of the product preview.

For an existing installation, **Prepare setup request** opens the same two-step
flow. The source selection may contain reviewed existing connections, new
sources, or both. Status labels describe reviewed evidence; **Include in this
run** and **Included** describe only the sources named in the copied request.

The unified read-only runner accepts an exact source allowlist, performs the
same capability preflight, rechecks selected reviewed exact profiles and returns one
combined connection, candidate and runtime review:

```bash
npm run devhub -- setup-run --sources github,local-host --json
```

This is the canonical coding-agent handoff. When it is available, the agent
must not substitute a manually assembled `setup-session` plus
`discovery-inbox` flow. Its preflight keeps every selected source visible: a
source without an exact reviewed scope or binding returns an explicit review
question and performs zero provider I/O, while sources with reviewed exact
profiles may be rechecked in the same bounded run.

An available source without a reviewed profile stops at **Needs exact scope**.
A source without an on-demand setup capability uses only an exact reviewed
inventory/evidence binding; it never broadens discovery. One overall deadline
covers planning, preload, validation, credentials, local inspection and
provider collection. JSON is deterministic, and the human summary is derived
from that same result. Neither form returns secret values or writes provider or
catalog state.

Unlike the standalone all-connector `setup --json` preview, `setup-run` probes
local markers only for its exact selected source list. Unselected connector
markers cannot consume the bounded run or make its `selectedOnly` claim false.

Default marker planning is isolated in a killable child that performs only
bounded `access`/`lstat` checks and is reaped before the plan returns. This
runtime guarantee starts after CLI module loading; run an installed or staged
CLI from a non-File-Provider location when a synced worktree can block before
JavaScript entry.

The lower-level on-demand session command accepts reviewed portable JSON and
exits after one observation:

```bash
npm run devhub -- setup-session ./connection-profiles.json --json
```

The public snapshot includes
[`config/connection-profiles.example.json`](../config/connection-profiles.example.json)
as a fictional starting point. A coding agent should copy it, replace only the
selected account/workspace/host identities, remove irrelevant profiles, and
present that non-secret profile diff for review. The user should not need to
author this schema by hand.

A connection profile records `connectorId`, an exact provider-owned `scope`,
an authorization method, a non-secret credential reference, an accountable
owner, prior observation state and a freshness window. Profiles are Git-
reviewable input, not a hidden writable connection database. The runner
returns `authorization-required`, `connected`, `unavailable`, `stale` or
`unknown`, and reports prior state separately so an old `connected` value
never proves a current connection.

`npm run devhub -- validate` also derives a deliberately redacted dashboard
snapshot from the reviewed profile document. It contains only connector ID,
state, last observation time and freshness deadline. Profile IDs, scopes,
owners, authorization methods and credential references are excluded. The
internal snapshot retains provider-neutral states such as `connected`, `stale`
and `authorization-required`; the UI renders them as **Last check succeeded**,
**Check expired** and **Access needed** without reading or returning
credentials. A changed profile still requires validation and a normal reviewed
deployment before its status appears.

Environment references contain only a variable name. macOS Keychain locators
use `generic-password:<service>:<account>` and execute the exact bounded
`security find-generic-password` read. 1Password references use an `op://`
vault/item/field URI and execute the exact bounded `op read --no-newline`
read. Missing tools, accounts or items become `authorization-required`; no
stderr or credential value enters setup output. Other secret managers remain
unsupported until they receive their own reviewed resolver.

GitHub can use an existing `gh` CLI session; Vercel, Railway and OpenAI use a
reviewed external credential reference; and this computer uses exact scope `{ "hostId": "..." }`
with the isolated one-shot `inspect-host` implementation. The full default
inspection, including reviewed package metadata reads, runs in a killable and
reaped child; injected library inspectors remain available only for tests and
trusted embedding. The default runner
does not open a browser, and a `github-app` profile remains unavailable unless
a trusted transport is explicitly injected.

Coding agents are equal entry points into this journey. Codex can use the
packaged DevHub workflow, while Claude Code and Cursor use the same MCP and CLI
contract described in [Coding-agent integrations](INTEGRATIONS_AGENTS.md). A
client-specific setup file must not contain catalog truth or additional
mutation authority.

## Canonical connector contract

`lib/connectors.mjs` is the only product-level connector catalog. CLI and UI
consumers import it; they must not maintain provider lists or capability copy
in parallel.

Each immutable connector definition contains:

- `id`, `name`, `priority` and `category` for stable identity and ordering;
- `stage`: `available` or `planned`; every planned entry also names its
  roadmap milestone and delivery theme;
- a short `summary` suitable for provider-neutral presentation;
- `capabilities`, chosen from the fixed shared capability vocabulary;
- `auth`, describing supported authorization patterns without credentials;
- `detection.commands` and `detection.markers`, containing only exact safe
  executable names and filesystem marker paths.

The module exports the connector catalog and the setup copy used by every
surface:

- `CONNECTOR_CATALOG` and `CONNECTOR_CAPABILITIES`;
- `CONNECTED_SETUP`, `CONNECTED_SETUP_ENTRY_POINTS`,
  `CONNECTED_SETUP_STEPS`, `CONNECTED_SETUP_RUN_STAGES`,
  `CONNECTED_SETUP_NEXT_ACTIONS` and `buildConnectedSetupAgentPrompt()`;
- `listConnectors()`;
- `getConnector(id)`;
- `recommendedConnectors(limit)`;
- `validateConnectorCatalog(connectors)`.

`createSetupRunPresentationPreflight()` is the canonical browser-safe
projection over that connector contract and `catalog.connections`. It accepts
only the selected available connector IDs and returns redacted capability,
connection and next-action presentation. Dashboard code must not recreate its
readiness rules, inspect credentials or treat local detection as access.

Priority is product setup order, not a popularity or quality ranking.
`recommendedConnectors()` returns the first **available** items in that stable
order. Planned entries never displace a working connector from first-run setup
and never imply that they were detected or connected.

The static catalog does not store connection state, sessions, account IDs,
tenant IDs, credentials, API origins, provider commands or catalog matches.
Runtime setup results may overlay a detected/not-detected observation, but that
observation must carry its own source and must never be written back into the
connector definition.

## Connector library

The v0.9 foundation defines fifteen ordered sources in `CONNECTOR_CATALOG`.
GitHub, this computer, Vercel, Railway, Sentry and OpenAI are currently
`available`; all other entries are honestly marked `planned`. Product priority starts with
source code and the current computer, then expands through deployment,
infrastructure, data, observability, AI and business systems. The executable
catalog is the source of truth for exact names, order, capabilities and stage;
this document does not maintain a second provider matrix.

`Available` means at least one bounded DevHub collection path exists today; it
does not mean every advertised provider capability is implemented or that a
user is already connected. Vercel currently provides reviewed-profile setup,
inventory and exact deployment evidence, while Sentry provides exact project monitoring/release
evidence. `Planned` is roadmap metadata, not a disabled implementation hidden
among selectable setup cards. The dashboard renders available sources first
and places planned providers in a separate collapsed roadmap. Every planned
entry maps to milestone `v0.11 — Deployment and data connectors` or
`v0.12 — Cloud and business context`. Moving a connector to `available`
requires at least one real bounded
collection path, canonical contract registration, fail-closed tests and setup
docs.

Connector support, local detection and reviewed connection state are three
separate axes in the UI. A working connector with no profile is `Not
configured`;
a CLI or workspace marker is only detection evidence; and only a fresh
reviewed profile observation is shown as `Last check succeeded`. Cards show
that state separately from **Include in this run** or **Included**, which
controls only the current unified setup run. The final handoff prepares one
reviewed agent request and does not itself contact the provider.

The public Sites demo intentionally presents available connectors as a setup
preview, not as personal connection state. A private deployment shows the
human-readable status labels above from its own redacted reviewed profiles. A
login held by ChatGPT,
a browser or a coding-agent environment is not automatically shared with
DevHub.

The canonical capability list describes shipped collection paths only.
Vercel cost, ownership and monitoring depth and Sentry account inventory and
ownership remain future work; setup cards must not imply that those facts are
collected today.

The long tail remains documented rather than added to the canonical v0.9 data:
Lovable, Bolt, Base44, OpenAI Sites, Fly.io, DigitalOcean, Heroku, Hetzner,
Coolify, PostHog, Better Stack, Anthropic, ElevenLabs, Resend and domain
registrars. A source joins the library only when it has a concrete bounded
contract and a real user need.

## Capabilities

Capabilities describe what a connector may contribute after review; they do
not assert that the data is present or current:

- `repositories`, `inventory`, `runtimes`, `deployments`, `environments` and
  `domains` describe project and runtime placement;
- `data` describes non-secret data-service metadata;
- `monitoring`, `recovery`, `ownership` and `costs` describe evidence or
  context, not monitoring, backup, IAM or billing systems;
- `key-metadata` means redacted key identity and ownership metadata only, never
  a key value.

The OpenAI pilot accepts an exact organization/project scope and a reviewed
external Admin credential reference. DevHub does not create the Admin key. See
[OpenAI Admin connector](OPENAI_ADMIN_CONNECTOR.md) for the Keychain template,
on-demand setup flow and evidence boundary.

Unsupported or inaccessible capability results remain `unknown`. A connector
must not infer completeness from one provider account or workspace.

## Authentication and detection

Authorization metadata is deliberately abstract: `anonymous`, `github-app`, `oauth`,
`cli-session`, `local-session`, `secret-reference` or `cloud-iam`. Secret
references name an external credential location; values never enter the
connector catalog, project manifests, setup output or logs.

Detection is optional local evidence for choosing useful sources. A safe setup
implementation may check whether an exact executable name is present on
`PATH`, or whether an exact marker path exists relative to an explicitly
selected workspace. It must not:

- execute the detected CLI;
- read configuration contents or environment-variable values;
- inspect arbitrary home-directory files;
- scan ports, networks, provider accounts or browser sessions;
- report a source as connected merely because a marker exists.

The browser cannot perform local detection by itself. UI copy should say
“Check with agent” or “Detection available” until a trustworthy runtime result
is supplied.

## Build-my-map boundary

Connected Setup composes existing safe primitives:

```text
selected connector
  -> bounded read-only observation
  -> normalized candidates with source and freshness
  -> deterministic comparison with reviewed identities
  -> ambiguous or missing context only
  -> proposed YAML diff
  -> validate and merge
  -> dashboard and MCP
```

GitHub exact-resource evidence, local host inspection and Railway bounded
inventory remain separate execution contracts. The connector library is the
shared product description above them; it does not weaken their scope,
credential or review requirements.

`lib/setup-session.mjs` defines the provider-neutral hook as
`{ connectorId, validateProfile(profile), collect({ profile, credential,
now }) }`. Credential values are resolved only for the selected adapter and
discarded after the call. Connector failures are isolated per profile;
untrusted error text is not returned. Normalized observations have depth,
count and byte limits and reject secret-like keys and values. The session
never writes provider state or catalog files. Reconciliation and evidence
collection remain subsequent review primitives, rather than hidden automatic
steps.

Executable provider capabilities also pass the versioned
[connector conformance contract](CONNECTOR_CONFORMANCE.md). That registry
binds setup, inventory and evidence runtimes to the same canonical connector
metadata, hard limits and fail-closed safety boundary without adding provider
conditionals to this journey.

[Connected Setup state and refresh](CONNECTED_SETUP_STATE.md) defines the
strict session-artifact trust boundary, verified completion rule, incremental
refresh semantics and review-only disconnect proposal used by every surface.

## Discovery Inbox

The provider-neutral review step consumes the same reviewed profiles together
with the exact setup-session artifact:

```bash
npm run devhub -- discovery-inbox ./connection-profiles.json ./setup-session.json --json
```

Previously unregistered projects on the current computer enter this same
matching and review contract through
[`discover-local`](LOCAL_DISCOVERY.md). That command requires one reviewed host
ID plus explicit absolute roots, redacts workspace paths and preserves
`inspect-host` as the known-service-only runtime check.

The command strictly revalidates the artifact against those profiles before
using any observation. It produces a deterministic temporary `artifactId`,
then classifies each exact provider resource as `exact-match`,
`possible-match`, `new`, `reviewed-external`, `unknown` or `ignored`. Names and
domains are supporting evidence only; only a unique reviewed repository,
provider-resource or project/service/host identity is exact.

Discovery does not join a GitHub repository to a local runtime merely because
a checkout history or display name looks similar. For each catalog-reviewed
workspace on the reviewed local host, one-shot inspection may read only the
local Git `origin` and emit its canonical GitHub provider, owner and repository
name. Workspace paths and raw remote URLs never enter the setup artifact. When
that exact identity also appears in the selected GitHub artifact, Discovery
Inbox offers the reviewed local project as a `possible-match`; duplicate
project targets stay ambiguous, and review is still required. This evidence
never becomes an exact match or catalog truth by itself.

Possible and new candidates never emit YAML until a review document binds its
decision to both the current `artifactId` and `candidateId`. Every decision
records `reviewedAt` and `reviewedBy`; ignored and external candidates also
require a reason. A new proposal requires reviewed product identity and
operating intent. Unknown or stale evidence cannot be unlocked by review.

```bash
npm run devhub -- discovery-inbox \
  ./connection-profiles.json \
  ./setup-session.json \
  ./discovery-review.json \
  --json
```

Questions are limited to product identity, environment, accountable owner,
payer and operating intent. Every question carries source, observation time,
freshness and uncertainty. Proposals are schema-valid overlay YAML sent to
stdout only. The command does not write a catalog file, create a mutable setup
database or make anything visible through the dashboard or MCP; only a later
validated Git merge can do that.

The JSON keeps per-candidate `questions` for deterministic agent decisions,
but presents current human work as bounded `questionGroups`. Up to fifty
candidates from one profile/provider/state share one batch prompt with their
candidate IDs, safe display labels and a provenance summary. Thus twenty-six
new repositories require one initial operating-intent triage instead of twenty-
six repeated forms. The reviewer still chooses separately for every candidate;
grouping never applies one answer implicitly, infers ownership or ignores a
resource.

Product identity is a follow-up, not an initial required question. It becomes
required only after the reviewer chooses to map a candidate to the catalog or
create a new DevHub project. Owner and payer remain explicit optional context;
omitting them leaves those facts unknown. `summary.questions` and
`summary.unansweredRequiredQuestions` count grouped user prompts, while
`candidateQuestions` and `unansweredRequiredCandidateQuestions` expose the
underlying machine-level work.

Provider-specific details belong in connector adapters and their documentation,
not in dashboard components. The setup UI renders the shared connector fields
and hands work to an agent or CLI. The dashboard remains read-only, and Git
remains the first review, audit and rollback boundary.

## v0.9 definition of done

- The canonical connector catalog is validated, immutable and public-safe.
- CLI and UI consume the same catalog without provider-specific branches.
- Codex, Claude Code and Cursor can enter the same setup journey.
- Available, planned, detected and connected are never conflated.
- Setup reads no secret value and performs no hidden catalog mutation.
- A completed setup produces a reviewable, validated catalog diff or an honest
  explanation of what remains unknown.

The implementation is tracked in the v0.9 Connected Setup milestone: Setup
Runner and connection profiles (#41), GitHub (#44), Railway (#42), the
Discovery Inbox (#43), and verified refresh/completion state (#45). Connector
depth follows in the v0.10 milestone rather than adding provider-specific
shortcuts to this setup contract. The current agent-assisted handoff remains
the honest self-hosted path; `v0.13 — Direct connections` is a separate future
control-plane milestone, not a relabeling of the read-only dashboard.
