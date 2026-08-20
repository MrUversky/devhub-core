# Bounded Setup Run

`setup-run` is the agent-facing orchestration command behind Connected Setup:

```bash
devhub setup-run --sources github,local-host,vercel,railway,openai --json
# From a contributor checkout:
npm run devhub -- setup-run --sources github,local-host,vercel,railway,openai --json
```

The additive [`onboard`](ONBOARD.md) facade reuses this command's selected-only
preflight, provider execution and Discovery Inbox result while optionally
supplying one already bounded local-discovery artifact. Ordinary `setup-run`
callers remain unchanged.

## Workflow runtime prerequisite

Before running setup, prefer a user-wide `devhub` already available on `PATH`
and verify it with `devhub doctor --workflow --json`. If it is unavailable or
incompatible, use `npm run devhub -- doctor --workflow --json` only in the
current checkout explicitly supplied by the user, task or repository
instructions for DevHub setup. A DevHub-looking current directory is not enough
to select that checkout.

Keep the result internal and accept only the exact canonical workflow contract:
contract version 2, a semantic runtime version and exactly `setupRun: 1`,
`connectionReview: 1`, `guidedConfirmation: 1` and `taskObservation: 1`, with
no missing, drifted or extra fields. A plugin provides guidance only, and MCP
provides read-only catalog access; neither proves a local setup runtime.
Any-project setup requires the capability-verified user-wide CLI.

If neither runtime passes, stop before marker planning, profiles, provider
tools or provider I/O. Do not manually compose `setup-session` and
`discovery-inbox` when `setup-run` is absent. Show **DevHub needs an update**
with **Help me update DevHub** and **Not now**, then wait. The doctor check and
update blocker perform zero provider I/O.

The default command-wide deadline is 30 seconds. Maintainers and bounded
automation may choose a reviewed budget from 100 to 120000 ms with
`--deadline-ms`, for example `--deadline-ms 10000`.

It performs one read-only pass: bounded local marker planning, capability-aware
preflight, an on-demand recheck for sources with reviewed exact profiles, and a Discovery Inbox
built from the actual validated session artifact. The command does not mutate a
provider, profile, catalog, dashboard or MCP result.

## Readiness contract

Only selected, currently available canonical connector IDs are accepted.
Preflight reports these stable presentation states:

- `ready`: a setup-capable connector has a fresh, connected reviewed profile;
- `needs-scope`: a setup-capable connector has no reviewed exact profile;
- `reconnect`: the reviewed profile is stale or needs authorization;
- `retry`: reviewed connection evidence is unavailable or unknown;
- `reviewed-binding-required`: the connector is implemented through inventory
  or evidence bindings rather than an on-demand setup profile.

Local marker detection is informational. It never proves access, chooses a
scope or promotes a source to `ready`. The browser-safe preflight is produced by
`createSetupRunPresentationPreflight` from the redacted connection snapshot and
canonical capability metadata. The server-side preflight projects full reviewed
profiles through that same function and asserts identical readiness semantics.

## Execution and review

Every selected setup-capable source with a valid reviewed exact profile may
enter the bounded setup session. `reconnect` and `retry` are honest preflight
states, not execution blocks: the run uses the reviewed scope to recheck them.
A source with no reviewed profile is not contacted, and an inventory/evidence-
only source still requires a reviewed binding. If every attempted profile for
a connector becomes connected, its preflight attention is cleared. Otherwise
the unified review emits one connector-level recheck question without profile
IDs. The overall deadline starts before local planning and catalog/profile
preload, then propagates its remaining budget to profile validation,
credential resolution, local host inspection and provider collectors.
Successful earlier sources remain in a deterministic partial review when a
later source times out. The default local-host connector runs the entire
one-shot inspection in a dedicated child, including reviewed catalog,
workspace and `package.json` reads. Aborting or timing out that inspection
terminates its POSIX process group, follows with bounded `SIGKILL` when needed,
waits for child close, and then returns `unknown`. This keeps a stalled local
filesystem read or status subprocess from retaining the setup-run process.

The returned review combines:

- access, connection, exact-scope and reviewed-binding questions;
- real Discovery Inbox candidate/runtime question groups;
- safe artifact, candidate and question IDs plus freshness and provenance
  needed to bind a later review.

The presentation omits profile IDs, owners, authorization descriptors,
credential locators and private reviewed scopes. Credential values are resolved
ephemerally, never returned, and never persisted. A successful collection is
still transient: catalog and dashboard enrichment requires a separate reviewed
YAML diff, validation and merge.

## Compact Setup Review

The human output is organized for an agent completing setup with a person. It
keeps four concerns separate instead of printing one flat candidate list:

1. **Source preflight** lists sources that were actually checked and became
   ready, then sources that still need an exact scope, reviewed binding,
   reconnect or retry. A profile that looked ready before the run is distinct
   from a source that completed a bounded check.
2. **Already known** reports the count of exact catalog matches and hides those
   matches from the human review queue.
3. **Artifact review** reports the validated artifact ID, distinct candidate
   count, and every real question-group ID with its provider, state, type,
   prompt, candidate count and choices. Candidate rows remain in `--json`; the
   compact human output does not repeat them as a flat list.
4. **Delivery** states that the result is stdout-only and performs no writes.

JSON keeps all existing `review.summary`, `review.questionGroups` and
`review.findings` fields. An additive deterministic `review.presentation`
projection indexes them without copying private connection data:

```json
{
  "version": 1,
  "sourcePreflight": {
    "selected": 5,
    "profileReadyCount": 3,
    "checkedCount": 3,
    "readyCount": 3,
    "ready": [],
    "notCheckedCount": 0,
    "notChecked": [],
    "needsAttentionCount": 2,
    "needsAttention": []
  },
  "knownExactMatches": {
    "count": 10,
    "hiddenFromHumanReview": true,
    "byProvider": [{ "provider": "github", "count": 10 }]
  },
  "artifactReview": {
    "artifactId": "sha256:…",
    "candidateCount": 28,
    "groupCount": 1,
    "groupIds": ["question-group-…"]
  },
  "delivery": { "transport": "stdout", "writes": false }
}
```

`ready`, `notChecked` and `needsAttention` contain only connector IDs, display
names, public presentation states, aggregate observation counts,
question-group IDs and safe action labels. They never contain profile IDs,
account or project scopes,
credential references or credential values. There is no export path or file
write option; redirecting stdout is an explicit caller action outside
`setup-run`.

### Agent conversation order

The copied dashboard request stays short and human. It names selected display
names and the review/safety outcome, but contains no CLI sequence, JSON schema
or continuation mechanics. The installed DevHub workflow maps those names to
canonical connector IDs and applies the contract in this section internally.

One setup request consumes one full-selection setup-run result and artifact.
The agent does not rerun that unchanged selection for another snapshot unless
the command failed before provider I/O and returned no usable artifact.

After workflow verification, the selected source list itself authorizes
supported safe read-only checks. Before showing a connection card, exhaust the
selected reviewed profiles, selected computer and already callable signed-in
provider tools. Do not call an unselected source, open new authorization or
invoke a write action.

Every selected source reports separate current and reusable state:

```text
Checked now: <recognizable scope · item count | Not checked>
Saved connection: <Yes | Yes · needs recheck | No>
```

The human status is per source. A current reviewed reusable profile is
**Saved connection: Yes**. An existing reviewed profile in reconnect, stale or
authorization-required state is **Saved connection: Yes · needs recheck** until
a successful bounded recheck clears the attention. Task-only access or no
reviewed profile is **Saved connection: No**. Aggregate presentation totals do
not override those distinctions. Reuse any recognizable label and aggregate
count already returned by the bounded check; never make another provider or
tool call solely to obtain a label, and use the source display name with the
aggregate count when no label was returned.

One recognizable scope continues automatically. A unique task-scoped plugin
session runs its bounded read and contributes transient review-only candidates
without becoming saved access. Several scopes ask exactly one recognizable
choice. Only several scopes or new authorization may block the connection
stage. Connector-owned sign-in, saved-connection, help and defer actions appear
only when automatic checks prove that the choice remains necessary and the
action is real for the current task.

Task observations are not profiles or catalog truth. They may feed first-map
candidate triage without blocking on persistence. After useful results, **Save
<source> for future refresh** is an optional non-blocking action. Choosing it
starts a separate exact-scope review for a runtime-supported reusable method;
OAuth or a resource list never implies **Save and continue**, a profile
proposal or a hidden write.

In the deterministic five-source forward-test case, a unique already-authorized
Vercel task session runs automatically and reports **Saved connection: No**.
Railway remains the one connection blocker when no callable task access or
reviewed reusable access is available. Any stale reviewed profile remains
**Saved connection: Yes · needs recheck**, never **No**.

The user does not author JSON, profile IDs, raw scope IDs, schemas,
secure-reference syntax, credential references, locators or profile files. The
agent performs capability checks and machine serialization internally.
Connector-owned task-observation bridges define the only accepted normalization
paths; the presence of a bridge does not prove that a matching provider plugin,
signed-in session or read-only tool is callable.

For an eligible selected source with an already callable read-only tool, the
agent records only a current recognizable scope label and bounded project
labels. One scope continues automatically; several scopes produce one human
choice before the document is built. The internal version-1 document contains
the full canonical `selectedConnectorIds` and 1..N unique observations in that
same order. Each observation contains only `connectorId`, connector-owned
`bridgeId`, `observedAt`, `scope` kind/label and `resources` kind/label. Raw
provider IDs, URLs, metadata, credential references, locators and secrets are
rejected. Observations must be no more than five minutes old and stay within the
bridge's bounded project limit.

New authorization remains a human blocker. Passwords, MFA, consent, one-time
codes and new-token creation stay in provider or operating-system UI and
outside chat; the agent never places them in the task-observation document.

The agent writes that document to an absolute temporary path outside the
checkout and runs the original selection exactly once:

```bash
devhub setup-run --sources github,local-host,vercel,railway,openai \
  --task-observation /absolute/transient-task-observations.json --json
```

There is no baseline setup-run before this command. If no eligible task
observation exists, omit only `--task-observation`; do not invent an empty
document. Saved profiles collect once in the canonical run. A task-observed
source performs zero provider and credential I/O inside DevHub, and both saved
and task-only results feed one Discovery artifact. Remove the transient file
after the run.

The result reports `taskObservations.checkedThisTask` and separate
`checkedThisTaskCount`, `savedForRefreshCount` and `taskOnlyCount` presentation
totals. Reusable preflight state remains unchanged. Task observations create no
profile proposal or write and may produce only possible-match, new or unknown
review candidates—never an exact match, including after a catalog relationship
review.

Setup-capable sources expose connector-owned onboarding cards. **This
computer** uses a local-session card and runs local preflight on the task's
computer. A binding-only inventory/evidence source exposes no guided setup
card, so the agent follows only its exact reviewed binding action or defers it.
Planned and unsupported sources cannot enter the selected setup run and never
gain a simulated provider, browser or plugin path.

If the canonical result still contains a real multiple-scope or new-
authorization blocker, the agent handles only the first connector-owned
question. The existing typed `--connection-review` continuation remains the
separate path for that answer: it cannot be combined with `--task-observation`,
cannot batch or skip blockers, and writes no profile or catalog file. Any
returned reusable profile operation is stdout-only until its normal config diff
is reviewed. A non-typed reconnect or retry follows only its returned action;
it never becomes an invented typed answer.

Only after source blockers are resolved does the agent present:

1. the exact-match total and `byProvider` counts, without repeating known names;
2. every possible match with its proposed catalog target(s) and reason;
3. new candidates grouped only by provider and count, followed by a question
   asking which group the reviewer wants to open.

Candidate names are expanded only after that group choice. This preserves each
artifact-bound candidate decision without dumping a large provider inventory
into the first response.

The agent does not run validation before asking a required blocker question.
If review is deferred or concludes without a connection-profile or catalog
YAML diff, validation stops at `validate --check` and reports `no diff`. The
repository's full test and lint gates run after an actual source change, before
its reviewed pull request.

## Planning timeout

Standalone `setup --json` bounds allowlisted local filesystem/CLI marker probes
for the full connector catalog. `setup-run` builds that marker plan only for
the exact `--sources` selection, so an unselected connector is never probed and
cannot consume the command-wide budget. A never-settling selected probe becomes
`unknown`; if the command deadline is exhausted, the runner returns a
deterministic partial review and performs no provider collection. The result
reports `selectedOnly: true` only when the planning input is scoped to the same
canonical source list. Default marker checks run in one dedicated child with a minimal
environment. That child receives only bounded absolute paths and performs
`access`/`lstat`; it never reads file contents, configuration or credentials.
On abort the parent sends `SIGTERM`, follows with bounded `SIGKILL` when needed,
and waits for child close before returning. Invalid or incomplete child output
becomes an all-unknown partial plan, never `not-detected`.

Marker planning and host inspection share the same bounded process lifecycle,
but use separate strict JSON protocols. Host inspection receives only the
reviewed root/catalog paths, exact host ID, one timestamp, home path and numeric
uid. Its child environment contains a fixed command-search path (and
`SystemRoot` on Windows), not credentials or the caller environment. Output is
size-limited and schema-checked before it can become setup evidence.

This deadline begins after the Node CLI and its modules have loaded. A
cloud-backed or File Provider workspace can stall before JavaScript entry, so
the reliable local setup path is an installed or staged DevHub CLI runtime on a
local filesystem outside synced Documents/Desktop folders. Isolation does not
justify claiming that arbitrary source loading is command-bounded. The runner
does not mask lifecycle failures with `process.exit`.
