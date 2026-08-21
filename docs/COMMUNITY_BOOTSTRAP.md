# Community first-run with Codex

This is the implementation runbook behind the public GitHub entry point. It
takes a blank Codex workspace to one self-hosted DevHub dashboard and read-only
MCP by composing the existing installer, `init-catalog`, `onboard`,
`onboard-apply`, Docker/systemd and `agent-setup` contracts.
It is not another setup engine or catalog database.

## Human entry point

Share only the public repository:

<https://github.com/MrUversky/devhub-core>

In a new Codex task, the person says:

> Set up DevHub for me from this repository.

That single request is enough. Everything below is instruction for Codex, not
wording the person must copy into a prompt. Codex selects and verifies the
reviewed public release, keeps machine output internal, asks only recognizable
product choices, and pauses at every write boundary. The user is never expected to type shell commands, assemble JSON, select an
internal schema or interpret doctor output. Do not ask the person to choose a
tag or repeat the workflow's safety language in their prompt.

## Supported boundary

- macOS and Linux have a clean-room-tested user-wide CLI path.
- Local Docker Compose is the default dashboard deployment and binds only to
  loopback.
- An existing private Linux host may use the portable systemd path when Codex
  already has separately approved access and the host already has a private
  HTTPS or equivalent reviewed access boundary.
- Windows may use the separately tested narrow release-asset and path checks,
  but this release does not claim Windows installation, local discovery,
  dashboard service operation or a Windows service installer. Report it as
  unsupported instead of improvising.
- The owner-only Sites companion is optional and separate. It is never the
  canonical backend for this workflow.

The workflow never creates public ingress, changes a firewall, enables
Tailscale Funnel, scans arbitrary roots or ports, authorizes a provider,
installs a resident agent, creates a credential vault or enables unattended
updates.

## Human choices

Codex asks only these product-level questions, one ambiguity at a time:

1. **Run on this computer (recommended)** — local Docker on
   `http://127.0.0.1:3000`, or another reviewed loopback port.
2. **Use an existing private Linux host** — only a host the user recognizes and
   explicitly selects. Lack of reviewed host access or a private dashboard/MCP
   boundary blocks this option; it does not authorize new networking.
3. Which local folders should be checked. Every root is explicit and absolute;
   none is inferred from the home directory.
4. Which supported provider sources should be checked. Selecting a source is
   bounded read authority, not permission to authorize an account or write to
   the provider.
5. A recognizable host name and proposed stable host ID. Codex shows the
   proposal; it never silently accepts a hostname as reviewed identity.

## Phase 1: exact public release

Before provider I/O, Codex resolves one exact annotated tag in
`MrUversky/devhub-core`. A mutable branch, an unannotated tag or an asset set
from another release is rejected. `v1.0.0-rc.4` is the first published release
that proves the distribution foundation; later releases must use their own
exact tag and matching assets rather than treating `latest` as an immutable
identity.

Codex downloads all of these from that one GitHub Release into a fresh
temporary directory:

- `devhub-self-hosted-v<VERSION>-source.tar.gz`;
- `devhub-cli-v<VERSION>.tar.gz`;
- `devhub-install-v<VERSION>.mjs`;
- `devhub-self-hosted-v<VERSION>-sbom.cdx.json`;
- `SHA256SUMS` and `RELEASE-EVIDENCE.json`;
- the published macOS and Linux clean-room reports; and
- the narrow Windows CLI/path report.

Codex verifies the annotated tag and peeled public commit, the GitHub Release's
exact tag, every line of `SHA256SUMS`, release-evidence format/version, clean
source state, runtime/installer/source/SBOM digests and the applicable platform
report. It keeps raw JSON internal and reports a short result such as
**Release v1.0.0-rc.6 verified from MrUversky/devhub-core**. A missing or
contradictory artifact stops the workflow.

After showing the exact version and user-owned installation paths, Codex asks
for the **Install the verified DevHub CLI** boundary. Approval permits only the
standalone, checksum-pinned installer. It never permits `npm -g`, `sudo`, an
unpinned URL or a checkout symlink.

The internal execution is equivalent to:

```bash
node /absolute/temporary/devhub-install-v<VERSION>.mjs install \
  --archive /absolute/temporary/devhub-cli-v<VERSION>.tar.gz \
  --sha256 <digest-from-the-same-SHA256SUMS>
devhub doctor --workflow --json
devhub doctor --install --json
```

Both doctors must bind the installed runtime to the exact release and expected
workflow contract before any provider check. Codex does not ask the user to
read their JSON.

For a new Codex installation, Codex also previews and then installs the generic
guidance plugin from the same exact public tag:

```bash
codex plugin marketplace add MrUversky/devhub-core --ref <EXACT_TAG>
codex plugin add devhub@devhub-community
```

The plugin contains no endpoint or credential. Codex may need a restart and a
new task before the skill is loaded; it returns one plain-language resume
prompt instead of pretending the current process loaded new guidance.

## Phase 2: separate catalog and bounded first map

The catalog lives in its own user-owned Git repository, separate from the
immutable CLI runtime, the extracted application source and every discovered
project. A normal default is:

```text
${XDG_DATA_HOME:-$HOME/.local/share}/devhub/catalog-repository/
└── catalog/
    ├── hosts.yaml
    └── projects/
```

Codex shows that path, the proposed host identity, the read-only
`devhub init-catalog` plan and the initial Git commit before asking **Create the
catalog repository**. It refuses cloud/FileProvider paths, an existing
non-empty unmanaged directory and a dirty repository. That approval permits
only the already-previewed `init-catalog --apply`, `git init` and initial commit
inside the selected destination. Codex validates the resulting empty catalog
and records its exact commit before onboarding. It does not add discovered
project repositories as submodules or write DevHub metadata into
shared/external projects.

The first `devhub onboard` call receives only the selected source IDs, selected
absolute roots and reviewed/proposed host ID, plus explicit `--catalog-dir`,
profiles and generated paths. It is preview-only and returns the existing
version 1 onboarding plan. Codex summarizes known matches, possible matches,
new candidates and the first unresolved question without exposing absolute
paths, profile IDs, credential locators or internal schemas.

After the user resolves ambiguity, Codex creates the artifact-bound review and
replays `onboard` to produce the exact approved plan outside the catalog
repository. This is still read-only. The user then sees the exact planned
catalog files before **Create the isolated catalog proposal** authorizes:

```bash
devhub onboard-apply /absolute/temporary/approved-plan.json
devhub onboard-apply /absolute/temporary/approved-plan.json --apply
```

The existing apply command owns all mutation safety. It checks the plan hash,
runtime version, catalog base/fingerprint, clean Git state and evidence
freshness, then writes only in a temporary worktree and returns a local proposal
branch and commit. It does not change the active checkout, push, open or merge a
pull request, deploy, call a provider or edit another repository.

Codex repeats the same exact apply once. `already-committed` with the same
proposal commit is the required idempotence result; a new diff or commit is a
blocker. Accepting that local catalog proposal is another explicit review
boundary. It is never merged automatically.

## Phase 3: dashboard deployment

Codex extracts and verifies the exact source archive into a versioned,
user-owned application directory. The application source is disposable; the
separate catalog repository remains the source of truth.

### Run on this computer

Codex previews the exact source version, catalog checkout/commit, host ID,
loopback address and port. After **Start the local dashboard**, Compose builds
with the catalog as an independent named context:

```bash
DEVHUB_CATALOG_CONTEXT=/absolute/catalog-repository/catalog \
DEVHUB_HOST_ID=reviewed-host \
DEVHUB_INSTANCE_MODE=private \
DEVHUB_INSTANCE_LABEL="Private workspace" \
docker compose -f /absolute/source/deploy/docker/compose.yaml up --build -d
```

The Compose default remains loopback. Codex must not set
`DEVHUB_BIND_ADDRESS=0.0.0.0`. Rebuilding after a reviewed catalog commit uses
the same exact catalog context; the image never silently falls back to the
fictional demo catalog.

### Use an existing private Linux host

Codex first verifies that the selected host and access method are the ones the
user reviewed. It previews the portable systemd files, exact public repository,
annotated release tag, separately verified peeled public commit, external
catalog path, runtime host ID, bind address and existing private endpoint.

The portable updater accepts either the recommended exact
`DEVHUB_RELEASE_TAG` plus `DEVHUB_EXPECTED_COMMIT`, or the legacy reviewed
branch path. A community bootstrap uses the exact tag path. A lightweight tag,
rewritten tag, commit mismatch or simultaneous tag/branch configuration fails
closed before build or service change. There is no timer.

System-user, root-owned configuration, service installation/update and restart
remain explicit host-write boundaries. Codex may execute them only through the
already approved host channel; otherwise it returns the reviewed plan and the
missing access blocker. It never creates a VPN, proxy, DNS record or public
route to make this option work.

## Phase 4: verify and connect Codex

Codex verifies, from the device that will use DevHub:

- dashboard HTTP health and the returned DevHub application shell;
- read-only MCP `initialize` and `serverInfo.name=devhub`;
- MCP runtime version equal to the selected exact release;
- one read-only project/list query against the reviewed catalog;
- catalog repository commit and catalog fingerprint used by the onboarding
  plan; and
- a second unchanged bootstrap/onboarding preview with no unexpected diff.

The local result is normally:

```text
Dashboard: http://127.0.0.1:3000
MCP:       http://127.0.0.1:3000/mcp
```

A remote result must use the already reviewed private HTTPS endpoint. Plain
remote HTTP, a guessed hostname or a loopback URL from another computer is not
a working result.

Codex runs `devhub agent-setup codex` internally to generate the existing
read-only MCP registration plan. It presents the recognizable endpoint and
auth boundary, never a token value. Only **Connect this Codex to DevHub**
permits the corresponding `codex mcp add` write. A restart/new task may be
required before the connection is available.

## Result and recovery

The completion report contains only:

- exact public tag, application version and verified source identity;
- deployment choice and reviewed host;
- catalog repository path, base and accepted proposal commit;
- selected roots/providers by recognizable label and unresolved items;
- dashboard URL and MCP endpoint;
- health/MCP/provenance/idempotence results; and
- exact recovery actions below.

Recovery is scoped and preserves the catalog by default:

- CLI rollback: `devhub-install rollback --version <retained-version>`;
- CLI uninstall: `devhub-install uninstall` (catalog and configuration stay);
- catalog proposal before acceptance: remove only its exact local proposal
  branch; after acceptance, use a normal reviewed revert commit;
- local Docker: `docker compose ... down`; the catalog repository is retained;
- systemd: restore the previously recorded `current` release target and restart
  only after review, or stop/disable the service when no prior release exists;
- Codex MCP: remove only the `devhub` MCP entry after explicit review; and
- plugin: remove or change the pinned marketplace separately from the runtime
  and catalog.

Temporary assets and transient review documents may be removed after evidence
is recorded. Deleting the catalog repository, provider configuration, project
files or secrets is never part of uninstall.

## Optional next step: owner-only Sites companion

After every canonical verification above passes, the user may separately ask
Codex to add the [owner-only Sites companion](SITES_COMPANION.md). It is a
sanitized private view built from the same exact public source and reviewed
catalog revision. It reuses the self-hosted `/api/status` route only through the
viewer browser, omits credentials and never ships `/api/context`, `/api/status`
or MCP as a Sites backend. It remains optional, preview-first and independent
from first-run success.
