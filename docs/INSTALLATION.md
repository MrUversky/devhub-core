# Installation

DevHub can run as a pinned user-wide CLI, from a source checkout, as a Docker
Compose service, or under systemd. The user-wide CLI is a verified release
asset, not a global npm package and not a symlink to a checkout.

## Requirements

- Node.js 22.13 or newer for user-wide CLI, source and systemd installations.
- Docker Engine with Compose v2 for the container path.
- A private access boundary if more than one user or device needs access.

The dashboard has no application-layer authentication. MCP defaults to the
deployment's network boundary and may optionally require a bearer token; that
token does not protect the dashboard.

Codex users can use the preview-first
[community bootstrap](COMMUNITY_BOOTSTRAP.md) instead of executing this guide
as a shell checklist. The same reviewed commands and boundaries remain
authoritative; Codex keeps their machine output internal and asks only for
recognizable choices and explicit write approval.

## Coding-agent workflow runtime

The portable Codex plugin installs workflow guidance only, and an MCP
connection exposes only the reviewed read-only catalog. Neither installs the
local CLI that runs Connected Setup. Before Connected Setup, prefer a user-wide
`devhub` already available on `PATH`; running setup from any project requires
that command to be accepted by:

```bash
devhub doctor --workflow --json
```

After the marketplace publishes plugin version `0.7.0-alpha.5`, refresh its
snapshot and reinstall the portable guidance plugin. For the documented public
marketplace name:

```bash
codex plugin marketplace upgrade devhub-community
codex plugin add devhub@devhub-community
```

A fresh Codex installation pins the existing public repository to one reviewed
annotated tag before adding that same marketplace:

```bash
codex plugin marketplace add MrUversky/devhub-core --ref <TAG>
codex plugin add devhub@devhub-community
```

Never substitute `main` or another mutable ref for `<TAG>`. The application
release and generic plugin keep independent versions; the tag selects the
reviewed public tree containing both.

Release maintainers must record one fresh install from this remote exact tag in
an isolated Codex home after the public tag and release are published. A local
staged-tree install is a required pre-publication gate, but it does not replace
that post-publication remote smoke.

Restart Codex and start a new task so the refreshed skill is loaded. This
changes guidance only; the local setup runtime must still pass the workflow
check below.

Do not invent an `npm -g` installation. Install the user-wide CLI only from an
approved exact-commit candidate or GitHub release using the pinned procedure
below. For first setup from source, use the current checkout
only when it was explicitly supplied for DevHub setup, then verify it with:

```bash
npm run devhub -- doctor --workflow --json
```

Do not select a checkout merely because the current directory looks like
DevHub. The exact compatibility result has contract version 2, a semantic
runtime version and only `setupRun: 1`, `connectionReview: 1`,
`guidedConfirmation: 1` and `taskObservation: 1`. The check reads no catalog or
credentials and contacts no provider; it performs zero provider I/O.

If the command is missing, fails or returns another contract, Connected Setup
must stop before provider I/O with **DevHub needs an update** and the actions
**Help me update DevHub** and **Not now**. Update through the same approved
installation source and repeat the check. Do not substitute lower-level setup
commands such as `setup-session` or `discovery-inbox` for an outdated runtime.

## Pinned user-wide CLI

Obtain these files from the same approved candidate or release:

- `devhub-self-hosted-v<VERSION>-source.tar.gz`;
- `devhub-cli-v<VERSION>.tar.gz`;
- `devhub-install-v<VERSION>.mjs`;
- `devhub-self-hosted-v<VERSION>-sbom.cdx.json`;
- `SHA256SUMS` and `RELEASE-EVIDENCE.json`.

The evidence binds the runtime, installer, sanitized public manifest, exact
source commit, checksums and CycloneDX SBOM. From the asset directory, verify
every checksum before installation. On macOS use `shasum -a 256 -c
SHA256SUMS`; on Linux use `sha256sum -c SHA256SUMS`.

Then install one exact version without `sudo` or npm. Both paths passed to the
installer must be absolute:

```bash
VERSION=1.0.0-rc.6
ASSETS=/absolute/path/to/verified-assets
RUNTIME="$ASSETS/devhub-cli-v$VERSION.tar.gz"
SHA256=$(awk -v file="$(basename "$RUNTIME")" '$2 == file { print $1 }' "$ASSETS/SHA256SUMS")
node "$ASSETS/devhub-install-v$VERSION.mjs" install \
  --archive "$RUNTIME" \
  --sha256 "$SHA256"
```

The installer accepts only a clean sanitized runtime manifest, verifies the
pinned digest, loads the exact workflow contract before activation and fails
closed on a FileProvider/cloud-backed or non-owner-writable destination. It
installs immutable files under
`${XDG_DATA_HOME:-$HOME/.local/share}/devhub/runtime/<VERSION>`, atomically
updates the active-version pointer and writes regular wrapper files to
`$HOME/.local/bin`. It never creates a symlink to the source checkout. Add that
bin directory to `PATH`, then verify:

If installation is interrupted, repeat `install` with the same archive and
digest. An existing same-version runtime is reused only after its manifest
bytes, complete file set, file modes, checksums and workflow contract exactly
match the pinned archive. A mismatch fails closed without activation. Ordinary
activation failures restore the pre-existing wrappers and active-version
pointer; retry removes only abandoned staging for that exact version. External
catalog and configuration paths are never part of this recovery transaction.

```bash
export PATH="$HOME/.local/bin:$PATH"
devhub doctor --workflow --json
devhub doctor --install --json
```

Mutable state stays outside the runtime:

- catalog: `${XDG_DATA_HOME:-$HOME/.local/share}/devhub/catalog` by default;
- connection profiles: `${XDG_CONFIG_HOME:-$HOME/.config}/devhub/connection-profiles.json`;
- instance paths: `${XDG_CONFIG_HOME:-$HOME/.config}/devhub/instance.json`;
- generated CLI output: `${XDG_DATA_HOME:-$HOME/.local/share}/devhub/generated`.

The installed runtime can preview one first map from any working directory.
Every provider source and local root is explicit, and `--host-id` binds local
discovery to one reviewed or proposed host identity:

```bash
devhub onboard --sources github,local-host \
  --root /absolute/operator-selected/projects \
  --host-id reviewed-workstation
```

The version 1 plan is stdout-only. It does not write the catalog, profiles,
generated output or caller directory and has no apply mode.

Initialize the external catalog explicitly. Preview first and add `--apply`
only after reviewing the destination and host identity:

```bash
CATALOG="${XDG_DATA_HOME:-$HOME/.local/share}/devhub/catalog"
devhub init-catalog "$CATALOG" \
  --host-id developer-laptop \
  --host-name "Developer laptop" \
  --host-kind mac \
  --host-location local
```

Use `--host-kind linux` on Linux. Windows CLI support is not documented by
this release. See [Portable configuration boundary](CONFIGURATION.md) for path
precedence and instance configuration.

### Explicit upgrade, rollback and uninstall

An upgrade repeats the verified `install` command with a newer exact version.
The new version is staged and smoke-tested before the active pointer changes;
older installed versions remain available for rollback:

```bash
devhub-install rollback --version 0.7.0-alpha.1
```

There is no unattended updater. Remove the user-wide command and all installed
runtime versions with:

```bash
devhub-install uninstall
```

Uninstall preserves the external catalog, generated data and
`$XDG_CONFIG_HOME/devhub` configuration by default. Delete those paths only as
a separate reviewed data-removal decision.

## Docker Compose

From the repository root:

```bash
docker compose -f deploy/docker/compose.yaml up --build -d
docker compose -f deploy/docker/compose.yaml ps
```

Open <http://127.0.0.1:3000>. Compose binds loopback by default, drops Linux
capabilities, enables `no-new-privileges`, uses a read-only root filesystem and
runs the application as a non-root user. Container health is `healthy` only
after both the dashboard and a read-only MCP initialization succeed.

For a real catalog, keep it in a separate Git repository and pass only its
`catalog/` directory as the named build context. The public demo remains the
default when this variable is omitted:

```bash
DEVHUB_CATALOG_CONTEXT=/absolute/catalog-repository/catalog \
DEVHUB_HOST_ID=reviewed-host \
DEVHUB_INSTANCE_MODE=private \
DEVHUB_INSTANCE_LABEL="Private workspace" \
docker compose -f deploy/docker/compose.yaml up --build -d
```

To change the host-side port without making the service public:

```bash
DEVHUB_PORT=3100 docker compose -f deploy/docker/compose.yaml up --build -d
```

The catalog is compiled into the image. After changing `catalog/`, rebuild:

```bash
docker compose -f deploy/docker/compose.yaml up --build -d
```

Do not set `DEVHUB_BIND_ADDRESS=0.0.0.0` unless a firewall, private network or
authenticated reverse proxy supplies the intended access boundary.

`DEVHUB_MCP_AUTH_MODE=network` trusts that boundary. If you need MCP access
without a private network or authenticated proxy, use bearer mode and keep a
random token of at least 32 bytes outside the repository:

```bash
DEVHUB_MCP_AUTH_MODE=bearer \
DEVHUB_MCP_TOKEN="$(openssl rand -hex 32)" \
docker compose -f deploy/docker/compose.yaml up --build -d
```

Configure the same token in the MCP client's authorization header. This token
protects `/mcp`; it does not add login protection to the web dashboard.

## From source

```bash
npm ci
npm run devhub -- validate --check
npm run build
npm test
```

For a real installation, keep the included fictional demo intact and initialize
a separate catalog. The first command is a read-only plan; add `--apply` only
after reviewing the listed paths:

```bash
npm run devhub -- init-catalog ./my-catalog \
  --host-id devhub-server \
  --host-name "DevHub server" \
  --host-kind linux \
  --host-location local
```

Then export `DEVHUB_CATALOG_DIR="$PWD/my-catalog"` for validation, builds and
the running process. See [Configuration](CONFIGURATION.md) for the complete
non-overwrite and host-field contract.

For local development:

```bash
npm run dev
```

For a production process, run the built application on loopback:

```bash
DEVHUB_HOST_ID=devhub-server \
  ./node_modules/.bin/vinext start --hostname 127.0.0.1 --port 3000
```

`DEVHUB_HOST_ID` must match a host ID in `catalog/hosts.yaml`. Use your reverse
proxy or private-network tooling for TLS and remote access.

## systemd

The portable example installs verified commits into immutable release
directories, then switches a `current` symlink atomically. Repository URL,
exact annotated release tag and peeled commit (or a legacy reviewed branch),
installation root, external catalog, port and MCP auth mode all live in the
external environment file; none are baked into the unit.

```bash
id -u devhub >/dev/null 2>&1 || \
  sudo useradd --system --home-dir /var/lib/devhub --shell /usr/sbin/nologin devhub
sudo install -d -o devhub -g devhub /var/lib/devhub
sudo install -d -m 0755 /etc/devhub
sudo install -d -m 0755 /usr/local/libexec /usr/local/sbin
sudo install -o root -g devhub -m 0640 deploy/systemd/devhub-portable.env.example /etc/devhub/devhub.env
sudo install -m 0755 deploy/systemd/devhub-portable-run /usr/local/libexec/devhub-portable-run
sudo install -m 0755 deploy/systemd/devhub-portable-update /usr/local/sbin/devhub-portable-update
sudo install -m 0644 deploy/systemd/devhub-portable.service.example /etc/systemd/system/devhub.service
sudo editor /etc/devhub/devhub.env
sudo install -d -o devhub -g devhub /opt/devhub
sudo -u devhub /usr/local/sbin/devhub-portable-update /etc/devhub/devhub.env
sudo systemctl daemon-reload
sudo systemctl enable --now devhub.service
```

Edit `/etc/devhub/devhub.env` before creating the installation directory. If
you change `DEVHUB_ROOT` from `/opt/devhub`, use that path in the `install -d`
command. Set `DEVHUB_REPOSITORY_URL` to the reviewed public repository,
`DEVHUB_RELEASE_TAG` to the exact annotated public tag,
`DEVHUB_EXPECTED_COMMIT` to its separately verified peeled public commit and
`DEVHUB_HOST_ID` to a host ID in the external catalog. Keep the file's
`root:devhub` ownership and mode `0640` if it contains `DEVHUB_MCP_TOKEN`.

The service never pulls code. Upgrades are explicit: the updater fetches the
configured exact tag (or legacy reviewed branch), rejects lightweight tags and
tag/commit drift, installs dependencies in a commit-addressed directory, runs
catalog, lint, test and production-audit gates, and switches `current` only
after all of them pass. Then restart and verify:

```bash
sudo -u devhub /usr/local/sbin/devhub-portable-update /etc/devhub/devhub.env
sudo systemctl restart devhub.service
sudo systemctl status devhub.service
```

The exact tag path is the community default. Existing installations may retain
`DEVHUB_BRANCH` for a protected release branch only after removing both tag
fields and reviewing the fetched commit. There is no timer or unattended
self-update in the portable example.

## Verify

Dashboard:

```bash
curl --fail --silent --show-error http://127.0.0.1:3000/ >/dev/null
```

Read-only MCP initialization:

```bash
curl --fail --silent --show-error \
  --header 'accept: application/json, text/event-stream' \
  --header 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":"install-check","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"install-check","version":"1.0.0"}}}' \
  http://127.0.0.1:3000/mcp
```

The MCP response must include `serverInfo`. Initialization is read-only.
