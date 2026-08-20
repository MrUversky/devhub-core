# Coding-agent integrations

DevHub is coding-agent agnostic. Codex, Claude Code, Cursor and future MCP
clients use the same two product interfaces:

1. the self-hosted Streamable HTTP MCP endpoint exposes reviewed catalog,
   status, runbook and reconciliation context without mutations;
2. the deterministic CLI inspects local evidence and prepares reviewable
   catalog changes without turning the agent into a hidden control plane.

Client-specific plugins, memory files and rules are thin workflow adapters.
They must not contain a private catalog, hard-coded credential, business rule,
or alternative source of truth.

## Plan connected setup

The dashboard is a two-step handoff, not an agent runtime: **Choose sources →
Run with your coding agent**. After copying the request, open a task in Codex,
Claude Code or Cursor on the computer holding the reviewed CLI sessions,
credential references or local workspaces. Use the DevHub workspace for first
setup. Later tasks may run from any project only when a capability-verified
user-wide `devhub` CLI is available; a plugin or MCP connection alone is not a
local setup runtime. Selecting **This computer** always means the task must run
on that computer. Copying the request does not contact a provider or complete
setup.

### Verify the local workflow first

Before setup planning, profile access, a provider tool or provider I/O, prefer
the user-wide `devhub` command already on `PATH` and run:

```bash
devhub doctor --workflow --json
```

If that command is unavailable or incompatible, use the current checkout only
when the user, task or repository instructions explicitly supplied that exact
checkout for DevHub setup:

```bash
npm run devhub -- doctor --workflow --json
```

Do not choose a checkout merely because the current directory looks like
DevHub, contains a catalog or exposes an npm script. The agent keeps the output
internal and accepts it only when it exactly matches the canonical workflow
contract: contract version 2, a semantic runtime version and exactly
`setupRun: 1`, `connectionReview: 1`, `guidedConfirmation: 1` and
`taskObservation: 1`, with no extra fields. This local check reads no catalog
or credentials and performs no
provider I/O. MCP proves only read-only catalog connectivity; the portable
plugin supplies only guidance.

If neither candidate passes, do not fall back to `setup-session`,
`discovery-inbox` or hand-built orchestration. Show only **DevHub needs an
update** with **Help me update DevHub** and **Not now**, then wait. After an
approved update, repeat the workflow check before contacting a provider.
**Help me update DevHub** uses only the pinned runtime archive, standalone
installer, `SHA256SUMS` and `RELEASE-EVIDENCE.json` from one approved
exact-commit candidate or release. Verify those files and follow
[Pinned user-wide CLI](INSTALLATION.md#pinned-user-wide-cli);
never substitute `npm -g`, `sudo`, an unpinned download or a checkout symlink.

Before authorizing a provider or editing a catalog, generate the same
read-only setup plan in Codex, Claude Code, Cursor or a plain terminal:

```bash
devhub setup --json
# From a contributor checkout:
npm run devhub -- setup --json
```

`setup` checks only whether allowlisted CLI executable names are present on
`PATH` and whether exact, safe config marker paths exist in the current
workspace. It does not run those CLIs, read config contents or environment
credentials, scan ports or networks, contact providers, start OAuth, open a
browser or update the catalog. A detected marker suggests a possible source;
it does not prove authentication, account access or ownership.

The deterministic result contains:

- prioritized recommended connectors and their `available` or `planned` stage;
- `detected`, `not-detected` or `not-detectable` state with marker evidence;
- supported connection methods and one safe next step;
- the internal **Build my map** run sequence: connect tools, build a bounded map,
  review unclear matches, then apply one separately reviewed catalog update.

Natural requests such as “set up my DevHub”, “connect everything I can
access”, “Build my map” and “refresh my DevHub” should start with this plan.
This planning command may enumerate all supported connectors and check only
allowlisted local markers. It performs no provider inspection. The subsequent
setup session and discovery must use only the sources selected in the handoff.
The agent must still ask for review before external authorization or catalog
mutation. Refreshes reuse existing reviewed MCP, evidence and inventory
bindings; setup never silently creates them.

For the normal agent-assisted path, run one selected-only orchestration command:

```bash
devhub setup-run --sources github,local-host,vercel,railway,openai --json
```

The dashboard copies only a short human request: selected display names, safe
automatic checks, one-source-at-a-time guidance, the secret boundary and the
reviewed-diff outcome. It does not embed this command sequence or any machine
schema. The configured DevHub workflow owns the execution contract below, so
the user does not have to carry implementation instructions between tasks.

Use this command as the canonical handoff rather than manually composing the
lower-level setup-session and Discovery Inbox commands. Its preflight must
contain every selected source. A selected source that reports `needs-scope` or
`reviewed-binding-required` remains an explicit review question and performs
zero provider I/O until the exact non-secret scope or binding is reviewed.

After the exact workflow check succeeds, the copied selection authorizes safe
read-only checks through reviewed profiles, the selected computer and already
callable signed-in provider tools. Exhaust those paths for every selected
source before showing a connection action. Never call an unselected source,
open new authorization or invoke a write action during this phase.

Report two separate facts for every selected source:

```text
Checked now: <recognizable scope · item count | Not checked>
Saved connection: <Yes | Yes · needs recheck | No>
```

One recognizable scope continues automatically. A unique task-scoped plugin
session also runs its bounded read automatically and contributes transient
review-only candidates to the first map; it remains **Saved connection: No**.
Several scopes produce exactly one plain-language scope choice. Only several
scopes or new authorization may block the connection stage.

Use **Saved connection: Yes** for a current reviewed reusable profile and
**Saved connection: Yes · needs recheck** for an existing reviewed profile in
reconnect, stale or authorization-required state. Use **No** only for task-only
access or when no reviewed profile exists. Never turn a stale reviewed profile
into **No** because it was not ready in this run. For **Checked now**, reuse the
recognizable label and aggregate count already returned by the bounded check;
do not call a provider or tool again just to get a label. If none was returned,
use the source display name with the aggregate count.

Show connector-owned **Use current sign-in**, **Use a saved connection**,
**Help me sign in**, **Help me connect** or **Not now** actions only after the
automatic checks prove that the corresponding choice is still needed and the
action is actually callable. Password, MFA, consent and new-token work stays in
provider or operating-system UI. Report recognizable labels and aggregate
counts only; never show JSON, profile IDs, raw scope IDs, schemas, credential
references or locators.

Task-scoped provider access is current-task evidence, not reusable access. It
never becomes a profile or catalog truth, but its normalized bounded resources
may enter review-only candidate triage. Continue to that useful result without
requiring persistence. Afterwards, **Save <source> for future refresh** may be
offered as an optional non-blocking action. Only if the user chooses it may a
separate exact-scope confirmation use a runtime-supported reusable method.
Never infer **Save and continue**, a profile proposal or a hidden write from
OAuth success or a resource list. Provider-specific behavior must still come
from the connector-owned capability.

In the five-source forward-test case, a unique already-authorized Vercel task
session runs automatically and remains **Saved connection: No**. Railway is the
one connection blocker when it has neither callable task access nor reviewed
reusable access. Any stale reviewed profile remains **Saved connection: Yes ·
needs recheck**, never **No**.

The agent runs local/read-only planning and capability checks itself. The user
does not run the CLI, assemble JSON, interpret schemas, provide a review ID or
write a connection profile. From the verified v2 runtime, the agent uses the
connector-owned task-observation bridge registry. A bridge proves only that
bounded task-tool results can be normalized safely; it does not prove a plugin,
signed-in session or read-only tool is callable.

For each selected source with both a bridge and an already callable read-only
tool, the agent collects one recognizable scope and bounded resource labels.
It keeps the exact internal document out of chat, rejects raw provider IDs,
URLs, metadata, secrets and locators, and writes the current observation only
to a temporary absolute path outside the checkout. The full canonical selected
list and every eligible observation stay in canonical order.

The agent then runs one canonical command for the original selection, adding
the transient `--task-observation` path when at least one observation exists.
There is no prior setup-run baseline. Saved profiles collect once; task-only
sources perform no provider or credential I/O inside DevHub; both streams feed
one Discovery artifact. The temporary file is removed after the run. If no
eligible task observation exists, only that option is omitted.

**This computer** is a local-session path, not an account login. Run safe local
preflight automatically on the computer hosting the task. If it is the wrong
computer, ask whether to inspect this one, continue the task on the intended
computer, or defer. A binding-only inventory/evidence source has no guided
on-demand connection path: use only its returned exact binding action, show
supported steps, or defer. Planned and unsupported sources never enter the
run; report the roadmap milestone when known and continue without simulating
provider or plugin support.

The result keeps saved and task-only states separate. Task observations never
clear reusable preflight readiness, create a profile or become exact matches;
they may produce only possible, new or unknown review candidates. A real
multiple-scope or new-authorization blocker still uses exactly one first
connector-owned conversation and, when necessary, one separate
`--connection-review` continuation. Never combine connection review and task
observations in one run. Any reusable profile remains a stdout-only proposal
until its normal config diff is reviewed.

After blockers are resolved or explicitly deferred, begin candidate triage.
Show the exact-match count and by-provider counts, each possible match with its
proposed target(s) and reason, and new candidates grouped by provider/count.
Ask which new group to open instead of printing every candidate name. Only
after that useful result may task-source persistence be offered separately.

Do not run validation or tests before asking the next blocker question. If the
review is deferred or concludes with no connection-profile/catalog YAML diff,
run only `devhub validate --check` (or the npm wrapper) and report `no diff`.
Full tests and lint belong after an actual source change, when the reviewed diff
is ready.

It rechecks selected setup-capable sources whenever a reviewed exact profile
exists, including stale or authorization-required profiles, while missing
exact scope and reviewed bindings remain questions. One overall deadline
starts before planning/profile/catalog preload, propagates through local and
provider collection, and Discovery Inbox is built from the real session artifact. Its
presentation contains no credential locator, owner, profile ID or private
reviewed scope. See [Bounded Setup Run](SETUP_RUN.md).

The lower-level primitives remain available for audits and fixture-driven
review. After an on-demand `setup-session`, every supported agent can use the
same provider-neutral review command:

```bash
devhub discovery-inbox connection-profiles.json setup-session.json --json
```

When the result contains unclear candidates, the agent presents its bounded
`questionGroups` first and records a separate choice for every candidate. It
may then pass an artifact-bound review document as the third file.
The command prints a proposal but never writes it; the agent still presents
the YAML diff for Git review and validation. Codex, Claude Code and Cursor do
not implement their own provider matching or decision format.

These primitives are not a compatibility fallback. If the verified runtime
lacks `setup-run`, stop at **DevHub needs an update** instead of manually
composing a setup session and Discovery Inbox.

Prefer `questionGroups` for the human conversation and keep `questions` for
constructing exact per-candidate decisions. A grouped prompt is a compact batch
selector, not a shared answer: every selected row must still become its own
artifact-bound decision. Ask product identity only after the user chooses
`catalog` or `new`; do not turn missing owner or payer context into an inferred
answer.

## Generate a setup plan

From a DevHub checkout or installed package, ask DevHub for a non-mutating
client plan:

```bash
npm run devhub -- agent-setup claude-code \
  --url https://devhub.example.com/mcp \
  --auth bearer \
  --scope user \
  --json

npm run devhub -- agent-setup cursor \
  --url https://devhub.example.com/mcp \
  --auth bearer \
  --scope project
```

Use `devhub agent-setup ...` when the package binary is on `PATH`. Supported
clients are `codex`, `claude-code`, and `cursor`. The command prints the exact
commands and mergeable file contents; it never edits client settings or writes
a token.

Choose the access boundary deliberately:

- `--auth network` is only for loopback or an endpoint already protected by a
  reviewed private network such as a tailnet.
- `--auth bearer` references `DEVHUB_MCP_TOKEN` by name. Set a token of at
  least 32 UTF-8 bytes in the environment or secret manager that launches the
  client. Use `--token-env NAME` to choose another variable.
- `--scope user` makes one DevHub available across the user's projects.
  Project scope is useful when a team deliberately reviews and shares the
  endpoint definition. It must still contain no literal secret.

## Claude Code

Claude Code recommends remote HTTP for remote MCP servers. The simplest
user-scoped network configuration is:

```bash
claude mcp add --transport http --scope user devhub https://devhub.example.com/mcp
claude mcp list
```

For a reviewed project configuration, merge
[`integrations/claude-code/mcp.network.json`](../integrations/claude-code/mcp.network.json)
or [`mcp.bearer.json`](../integrations/claude-code/mcp.bearer.json) into the
repository's `.mcp.json`. Claude Code supports `${VAR}` and
`${VAR:-default}` expansion in HTTP URLs and headers. It asks for approval
before using a project-scoped server in an interactive session.

Merge the focused workflow block from
[`integrations/claude-code/CLAUDE.md`](../integrations/claude-code/CLAUDE.md)
into the project's `CLAUDE.md`, or into `~/.claude/CLAUDE.md` for personal
cross-project guidance. Then use `/mcp` or `claude mcp list` to verify the
connection.

## Cursor

Cursor reads project MCP servers from `.cursor/mcp.json` and global servers
from `~/.cursor/mcp.json`. Merge
[`integrations/cursor/mcp.network.json`](../integrations/cursor/mcp.network.json)
or [`mcp.bearer.json`](../integrations/cursor/mcp.bearer.json) into that file.
The bearer template uses Cursor's `${env:NAME}` interpolation and keeps the
token value outside Git.

Project guidance belongs in `.cursor/rules/*.mdc`; `.cursorrules` is legacy.
Copy [`integrations/cursor/devhub.mdc`](../integrations/cursor/devhub.mdc) to
`.cursor/rules/devhub.mdc`, or adapt the same text as a Cursor User Rule when
DevHub should work across all projects. Verify with:

```bash
cursor-agent mcp list
cursor-agent mcp list-tools devhub
```

Cursor asks before MCP tool calls by default. Do not enable automatic tool or
terminal execution merely for DevHub. On desktop systems, ensure the
environment variable is available to the Cursor application process, not only
to an unrelated shell.

## Codex

Codex has the richest current packaging because DevHub ships a portable skill
plugin plus an instance-specific MCP connection. The same generator works:

```bash
npm run devhub -- agent-setup codex \
  --url https://devhub.example.com/mcp \
  --auth bearer
```

See [Codex integration](INTEGRATIONS_CODEX.md) for plugin installation and the
private-profile split. Codex does not receive extra product authority: its MCP
tools remain read-only and catalog changes still go through a reviewed diff.
The plugin is guidance-only; it does not install the local CLI required by
Connected Setup.

## One workflow in every client

After setup, this request should work in any supported client:

> Use DevHub to find this project, explain what is current, and tell me the
> next safe action. Do not change anything.

For registration or drift, say “sync this project with DevHub” and describe
what appeared or changed. The agent should search before creating, inspect the
current workspace, respect native versus overlay ownership, mark unsupported
claims `unknown`, and present a minimal diff. The MCP never applies, commits,
publishes, restarts, or rolls back anything.

When a new service appears later, there is no new client setup: use the same
request in that project's task. Re-run `agent-setup` only when the DevHub URL,
authentication boundary, client, or desired scope changes.

## Team boundary

- Share endpoint definitions and workflow rules only after review.
- Give every person or machine its own provider credentials where the provider
  supports it; DevHub stores only environment-variable references.
- Keep the DevHub catalog and Git review as the durable shared memory. Client
  chat history, local rules and MCP caches are not sources of truth.
- Provider discovery remains bounded and read-only. A resource found in
  Railway or another provider becomes a catalog fact only after a reviewed
  manifest diff is merged and validated.

Official client references: [Claude Code MCP](https://code.claude.com/docs/en/mcp),
[Cursor MCP](https://docs.cursor.com/context/model-context-protocol), and
[Cursor Rules](https://docs.cursor.com/context/rules).
