# Configuration

DevHub is registry-as-code. YAML is the reviewed source of truth; generated
JSON is consumed by the dashboard and MCP.

## Catalog layout

Initialize a new catalog using `npm run devhub -- init --catalog` (or test with `--dry-run`). The command creates a clean, secret-free starter host inventory and starter project manifest, and compiles generated runtime JSON files immediately. Existing catalog destinations are refused to prevent accidental overwriting.

```text
catalog/
├── hosts.yaml
└── projects/
    └── devhub.yaml
```

`catalog/hosts.yaml` assigns stable IDs to computers or cloud hosts. A project
manifest references those IDs from workspaces and services.

Use stable lowercase kebab-case IDs. Renaming IDs breaks bookmarks and status
history. Register two services separately when they have different URLs,
processes, health checks, hosts, owners or lifecycles.

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

## Status and probes

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

## Status and probes

An HTTP probe is optional and must use a fixed reviewed URL. Probes use GET,
short timeouts, no credentials and no cookies. Accept 401 or 403 only when that
response proves the protected endpoint is alive.

`localhost` is local to the DevHub server. A central server cannot probe a
service bound to loopback on another computer. Either leave it honestly
catalog-only/on-demand or expose a health endpoint through an appropriate
private network.

## Runtime environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `DEVHUB_HOST_ID` | implementation fallback | Host from which probes run and local URLs are interpreted |
| `DEVHUB_MCP_AUTH_MODE` | `network` | `network` trusts the surrounding access boundary; `bearer` requires `DEVHUB_MCP_TOKEN`; unknown modes fail closed |
| `DEVHUB_MCP_TOKEN` | unset | Random token of at least 32 bytes for bearer-mode MCP; never commit it |
| `NODE_ENV` | tool-dependent | Use `production` for deployed instances |
| `WRANGLER_WRITE_LOGS` | `false` in the supplied deployments | Disable project-local Wrangler logs |
| `WRANGLER_LOG_PATH` | tool-dependent | Writable log path when Wrangler logging is enabled |
| `MINIFLARE_REGISTRY_PATH` | tool-dependent | Writable Miniflare state path |

Set the bind address and port through the process runner. Docker Compose also
accepts `DEVHUB_BIND_ADDRESS` and `DEVHUB_PORT` for host-side publishing; both
default to loopback port 3000.

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
