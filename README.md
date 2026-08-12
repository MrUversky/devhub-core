# DevHub

> **Git remembers the code. DevHub remembers how it runs.**

> **Your coding agent can build and deploy it. DevHub helps you understand it,
> trust it, operate it, afford it and recover it.**

![DevHub connects the operational context around every service](public/og.png)

DevHub is the self-hosted operational home for everything you build: local
dashboards, APIs, workers, bots, databases, model runtimes and private tools
spread across laptops, servers and private networks.

It keeps every service findable, explains how trustworthy its current state
is, and leads to the safest useful next action. The catalog does not depend on
a particular framework, process manager or hosting platform.

Your coding agent may have shipped the service, but DevHub preserves the
operating context: where it was deployed, what it depends on, who owns it, what
it may cost, which safeguards have evidence and whether recovery has actually
been reviewed.

It keeps reviewed YAML manifests in Git, builds a lightweight read-only
dashboard and exposes the same catalog through a read-only MCP endpoint. It
does not scan random ports, execute shell commands or act as a process
supervisor.

> **Alpha:** the public snapshot is intended for evaluation and small
> self-hosted installations. The manifest contract may still gain
> backward-compatible fields before 1.0.

## What it answers

- Which projects and runnable services exist?
- On which host does each service belong?
- Is an endpoint live, reported, catalog-only or on another computer?
- Which reviewed runbook explains how to start, inspect or recover it?
- Which monitoring, recovery, security, ownership and cost claims have fresh
  evidence, and which remain honestly unknown?
- Which services across the portfolio need an evidence refresh or a recovery
  decision first?

The core promise is continuity: return to a project after weeks or months and
recover its operational context in under 30 seconds. DevHub is not a metrics
stack or a universal process supervisor; when trustworthy evidence is missing,
it reports `unknown` instead of inventing a green status.

## Quick start with Docker

Requirements: Docker Engine with Compose v2.

```bash
docker compose -f deploy/docker/compose.yaml up --build -d
```

Open <http://127.0.0.1:3000>. The image is built from the included demo
catalog and runs as a non-root user with a read-only filesystem. Edit the
catalog before using DevHub for real infrastructure, then rebuild the image.
Container health verifies both the dashboard and read-only MCP initialization.

The application has no built-in user authentication. Keep the default
loopback binding, or put it behind a private network or an authenticated
reverse proxy. Do not expose it directly to the public internet.

## Run from source

Requirements: Node.js 22.13 or newer and npm.

```bash
npm ci
npm run devhub -- validate --check
npm run dev
```

For a production-style check:

```bash
npm run build
npm test
npm run lint
```

## Add your catalog

Start a separate catalog without editing or deleting the included demo:

```bash
npm run devhub -- init-catalog ./my-catalog \
  --host-id developer-laptop \
  --host-name "Developer laptop" \
  --host-kind mac \
  --host-location local
```

The default is a read-only plan showing every path. Review it, repeat with
`--apply`, then use `DEVHUB_CATALOG_DIR="$PWD/my-catalog"` for catalog commands
and the DevHub process. The initializer refuses non-empty destinations and
validates the created `hosts.yaml` plus empty `projects/` starter immediately.

1. Add one project file per project under `my-catalog/projects/`.
2. Never put passwords, tokens, private keys, cookies or secret-bearing URLs
   in a manifest.
3. Run `DEVHUB_CATALOG_DIR="$PWD/my-catalog" npm run devhub -- validate` to
   regenerate the reviewed runtime JSON.
4. Commit the YAML and generated JSON together.

Use `registration: native` when a repository you control should own
`.devhub/project.yaml`. Use `registration: overlay` when the metadata is
private or the source repository is shared or external.

See [Installation](docs/INSTALLATION.md),
[Configuration](docs/CONFIGURATION.md), [App Passport](docs/APP_PASSPORT.md),
[Portfolio review](docs/PORTFOLIO_REVIEW.md),
and [Privacy](docs/PRIVACY.md).

Codex users can install the portable workflow skill and connect it to their
own MCP endpoint using [the Codex integration guide](docs/INTEGRATIONS_CODEX.md).

## Read-only MCP

The same process serves Streamable HTTP MCP at `/mcp`. It can list and search
projects, return service status and runbooks, and prepare reconciliation
context. It cannot mutate manifests, probe caller-supplied URLs or execute
commands.

Only connect clients you trust: MCP exposes the same operational metadata as
the dashboard and uses the deployment's network/authentication boundary.

## Project status

DevHub is pre-1.0 software. Good evaluation feedback includes installation
failures, confusing status semantics, portability gaps and catalog examples
that cannot be represented safely.

- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Support](SUPPORT.md)
- [Release and compatibility policy](docs/PUBLIC_RELEASE.md)

## License

Apache License 2.0. See [LICENSE](LICENSE).
