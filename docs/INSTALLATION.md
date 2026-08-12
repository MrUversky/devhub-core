# Installation

DevHub can run from a source checkout, as a Docker Compose service, or under
systemd. The public alpha is not distributed as a global npm package; install
from a verified source release or repository snapshot.

## Requirements

- Node.js 22.13 or newer for source and systemd installations.
- Docker Engine with Compose v2 for the container path.
- A private access boundary if more than one user or device needs access.

The dashboard has no application-layer authentication. MCP defaults to the
deployment's network boundary and may optionally require a bearer token; that
token does not protect the dashboard.

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
branch, installation root, port and MCP auth mode all live in the external
environment file; none are baked into the unit.

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
`DEVHUB_BRANCH` to the reviewed release branch and `DEVHUB_HOST_ID` to a host ID
in `catalog/hosts.yaml`. Keep the file's `root:devhub` ownership and mode `0640`
if it contains `DEVHUB_MCP_TOKEN`.

The service never pulls code. Upgrades are explicit: the updater fetches the
configured branch, installs dependencies in a commit-addressed directory, runs
catalog, lint, test and production-audit gates, and switches `current` only
after all of them pass. Then restart and verify:

```bash
sudo -u devhub /usr/local/sbin/devhub-portable-update /etc/devhub/devhub.env
sudo systemctl restart devhub.service
sudo systemctl status devhub.service
```

For a stricter production policy, point `DEVHUB_BRANCH` at a protected release
branch and review the fetched commit before running the updater. There is no
timer or unattended self-update in the portable example.

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
