# Configuration

DevHub is registry-as-code. YAML is the reviewed source of truth; generated
JSON is consumed by the dashboard and MCP.

## User-wide path precedence

The installed CLI resolves its mutable paths in this exact order:

1. command options: `--catalog-dir`, `--connection-profiles-file`,
   `--generated-dir` and `--instance-config`;
2. `DEVHUB_CATALOG_DIR`, `DEVHUB_CONNECTION_PROFILES_FILE`,
   `DEVHUB_GENERATED_DIR` and `DEVHUB_INSTANCE_CONFIG`;
3. the strict version 1 instance file;
4. installed XDG defaults, or the backward-compatible checkout paths when the
   CLI is running from source.

Command and instance-file paths are absolute. The default instance file is
`${XDG_CONFIG_HOME:-$HOME/.config}/devhub/instance.json` and may contain only
non-secret path configuration:

```json
{
  "version": 1,
  "catalogDirectory": "/absolute/path/to/devhub/catalog",
  "connectionProfilesFile": "/absolute/path/to/devhub/connection-profiles.json",
  "generatedDirectory": "/absolute/path/to/devhub/generated"
}
```

An installed runtime defaults the catalog and generated output to
`${XDG_DATA_HOME:-$HOME/.local/share}/devhub` and profiles to
`${XDG_CONFIG_HOME:-$HOME/.config}/devhub`. A source checkout retains
`catalog/`, `config/connection-profiles.json`, `app/generated/catalog.json`
and `public/catalog.json` unless an earlier layer overrides them. The CLI never
writes generated JSON into an immutable installed runtime. Profile files hold
only reviewed non-secret scope and external credential references; credential
values remain in environment, macOS Keychain or 1Password resolvers.

## Catalog layout

```text
catalog/
├── hosts.yaml
└── projects/
    └── example-app.yaml
```

`catalog/hosts.yaml` assigns stable IDs to computers or cloud hosts. A project
manifest references those IDs from workspaces and services.

Use stable lowercase kebab-case IDs. Renaming IDs breaks bookmarks and status
history. Register two services separately when they have different URLs,
processes, health checks, hosts, owners or lifecycles.

## Connected Setup

The dashboard uses one read-only handoff: **Choose sources → Run with your
coding agent**. Including a source does not contact or authorize it. Paste the
generated request into Codex, Claude Code or Cursor. From the CLI:

```bash
npm run devhub -- setup
```

Add `--json` for an agent-readable result. After the request is pasted, the
agent runs the internal connect, map, review and proposal stages. Setup checks
only exact local executable and filesystem markers. It does not execute
provider CLIs, read configuration contents or credential values, contact
providers, or change the catalog. A detected marker is a hint, not a connected account. See
[Connected Setup](CONNECTED_SETUP.md) for the connector and review boundary.

For one exact selected-only preflight and combined review, use:

```bash
npm run devhub -- setup-run --sources github,local-host --json
```

The private dashboard derives **N ready · M need access or scope** from the
same redacted preflight contract. The public demo remains support-only. Neither
surface performs browser provider access or invents a completed run.

For one first-map preview over the existing initializer, setup-run, bounded
local discovery and Discovery Inbox, use the installed runtime from any
directory:

```bash
devhub onboard --sources github,local-host \
  --root /absolute/operator-selected/projects \
  --host-id reviewed-workstation
```

The command returns one versioned no-write plan, follows the same external path
precedence and has no apply mode. Every source and root must be selected
explicitly.

## Initialize a catalog safely

Create a deterministic starter catalog in a new location without modifying the
included demo:

```bash
npm run devhub -- init-catalog ./my-catalog \
  --host-id developer-laptop \
  --host-name "Developer laptop" \
  --host-kind mac \
  --host-location local
```

The command is a dry-run unless `--apply` is present. Its plan names the exact
`hosts.yaml` file and `projects/` directory it would create. After review,
repeat it with `--apply`. Apply accepts only an absent or empty destination,
never overwrites files, supplies no machine-derived defaults and immediately
runs the same strict host/project validation used by the catalog compiler.

Use `--json` for an agent-readable plan. Host IDs must be stable lowercase
kebab-case; host kind is `mac`, `windows`, `linux` or `cloud`, and location is `local`,
`remote` or `cloud`. A host name is descriptive metadata, not a credential.

Select the new catalog explicitly when building or running DevHub:

```bash
DEVHUB_CATALOG_DIR="$PWD/my-catalog" npm run devhub -- validate
DEVHUB_CATALOG_DIR="$PWD/my-catalog" npm run dev
```

## Registration ownership

- `registration: native`: a repository you control owns
  `.devhub/project.yaml`; DevHub keeps a reviewed central copy.
- `registration: overlay`: the source repository is shared, external or should
  not contain your operational metadata; only DevHub owns the manifest.

Overlay is a privacy boundary, not a lesser registration mode.

## Service modes

- `always-on`: a supervised service expected to be reachable. Probe failure
  needs operator attention.
- `on-demand`: a local development process. Stopped is normally informational.
- `managed`: an external platform owns process lifecycle.
- `internal`: a component without a direct operator entry point.

Commands in a service manifest are copy-only runbook documentation. DevHub
does not execute them.

## Self-service host monitoring

For a private workstation or server, keep central status tied to one reviewed
HTTPS probe and optionally declare how its minimal loopback endpoint is
published:

```yaml
probe:
  type: http
  url: https://workstation.example.test/health/example
  successStatuses: [200]
  timeoutMs: 5000
  publish:
    type: tailscale-serve
    visibility: tailnet
    targetUrl: http://127.0.0.1:3000/api/health
    path: /health/example
```

On that exact host, preview and then explicitly apply the reviewed routes:

```bash
npm run devhub -- setup-host-monitoring developer-workstation
npm run devhub -- setup-host-monitoring developer-workstation --apply
```

The command verifies device identity and existing handlers. Apply is locked,
idempotent and path-scoped: it never enables Funnel, resets Serve, stores a
credential, installs a resident agent or removes unrelated routes. The
Tailscale Serve adapter works on macOS, Windows and Linux where the CLI offers
Serve. Managed cloud services normally use their direct reviewed HTTPS probe
and need no local publisher; future publisher types remain separate adapters.
Publisher `visibility` is explicitly `tailnet`; the service's primary
`visibility` remains independent. Run this from a compatible DevHub runtime
that contains the current reviewed catalog. The plugin and MCP do not install
the CLI. Tailscale, MagicDNS/HTTPS and an ACL path from the central DevHub host
must already exist. Local apply keeps `centralVerification` pending until the
published URL is checked from that central host.
Use a current Tailscale CLI with `--set-path`; Windows setup may require an
Administrator terminal, while Linux service users need daemon access.

## Service links

`url` remains the optional canonical service URL understood by existing
clients. Add `links` when a service has multiple reviewed browser destinations:

```yaml
url: https://app.example.test
links:
  - id: primary
    type: primary
    label: Open application
    url: https://app.example.test
  - id: docs
    type: docs
    label: Operator documentation
    url: https://docs.example.test/app
  - id: logs
    type: logs
    label: View logs
    url: https://logs.example.test/app
```

Every link requires a stable lowercase kebab-case `id`, a human-readable
`label`, and one of these types: `primary`, `dashboard`, `docs`, `repository`,
`logs`, or `console`. Link IDs must be unique within a service. URLs must be
absolute HTTP(S) browser links without embedded credentials or secret-bearing
query parameters. Keep `url` while older clients still rely on it; a `primary`
link may mirror it for typed-link consumers.

## App Passport evidence

A service may include an optional `readiness` block with an operating profile
and reviewed evidence:

```yaml
readiness:
  profile: customer-facing
  evidence:
    - id: restore-review
      check: restore
      state: verified
      source: operator
      note: A restore into an isolated environment completed successfully.
      observedAt: 2026-08-01T10:00:00Z
      validUntil: 2026-09-01T10:00:00Z
```

Profiles are `personal`, `internal`, `customer-facing` and `sensitive`.
Checks cover monitoring, alerting, backup, restore, rollback, security review,
privacy, ownership, cost and deployment. Evidence is `verified`, `declared`,
`missing`, `not-applicable` or `unknown` and names its `operator`, `agent`,
`integration` or `catalog` source. Expired verification is shown as stale.
DevHub does not compute a universal readiness score, run scanners or store
secrets; unknown never looks like a pass.

The optional passport inventory keeps safe operating facts beside that
evidence:

```yaml
readiness:
  profile: customer-facing
  owner: Product owner
  dataClassification: personal
  costModel: metered
  deployment:
    source: integration
    provider: Example Cloud
    revision: release-42
    deployedAt: 2026-08-13T10:00:00Z
  dependencies:
    - id: primary-database
      kind: data-store
      name: Primary database
      criticality: required
      provider: Example Database
```

Dependency kinds are `data-store`, `external-api`, `auth`, `payment`,
`messaging`, `storage`, `ai-model` or `other`. Criticality is `required`,
`degraded` or `optional`. Store names and safe documentation links only; never
connection strings or credentials.

## Status and probes

An HTTP probe is optional and must use a fixed reviewed URL. Probes use GET,
short timeouts, no credentials and no cookies. Accepting 401 or 403 proves only
that a protected edge is reachable (`PROTECTED`); it does not prove LIVE
application health. Use a minimal unauthenticated health endpoint when LIVE is
required.

`localhost` is local to the DevHub server. A central server cannot probe a
service bound to loopback on another computer. Either leave it honestly
catalog-only/on-demand or expose a health endpoint through an appropriate
private network.

## Runtime environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `DEVHUB_HOST_ID` | implementation fallback | Host from which probes run and local URLs are interpreted |
| `DEVHUB_STATUS_CORS_ORIGINS` | unset | Comma-separated exact origin-only HTTPS URLs allowed to read `/api/status`; wildcard is rejected |
| `DEVHUB_STATUS_API_BASE_URL` | unset | Exact origin-only HTTPS URL whose `/api/status` snapshot the browser reads; unset keeps same-origin behavior |
| `DEVHUB_MCP_AUTH_MODE` | `network` | `network` trusts the surrounding access boundary; `bearer` requires `DEVHUB_MCP_TOKEN`; unknown modes fail closed |
| `DEVHUB_MCP_TOKEN` | unset | Random token of at least 32 bytes for bearer-mode MCP; never commit it |
| `NODE_ENV` | tool-dependent | Use `production` for deployed instances |
| `WRANGLER_WRITE_LOGS` | `false` in the supplied deployments | Disable project-local Wrangler logs |
| `WRANGLER_LOG_PATH` | tool-dependent | Writable log path when Wrangler logging is enabled |
| `MINIFLARE_REGISTRY_PATH` | tool-dependent | Writable Miniflare state path |

Set the bind address and port through the process runner. Docker Compose also
accepts `DEVHUB_BIND_ADDRESS` and `DEVHUB_PORT` for host-side publishing; both
default to loopback port 3000.

The two status-bridge values are server-only configuration. They reject
credentials, paths, query strings, fragments and wildcard origins. The
dashboard never accepts a status base from browser input, and `/api/context`
always stays same-origin. A browser-mediated bridge still requires the viewer
device to reach the central private network; CORS does not publish that network
or replace its ACLs. With both variables unset, including in the public demo
snapshot, DevHub reads only its own same-origin `/api/status` route.

## Apply changes

```bash
npm run devhub -- validate
npm run devhub -- doctor
npm run devhub -- validate --check
npm test
```

Commit `catalog/**/*.yaml`, `app/generated/catalog.json`, and
`public/catalog.json` together. Never hand-edit generated JSON.

## Secrets

Do not put passwords, tokens, cookies, private keys, connection strings,
credentials in command strings, or secret-bearing query parameters in any
manifest. Use a secret manager or the deployment environment, and catalog only
the safe operational metadata needed to identify and reach a service.
