# Codex integration

Codex is one client of DevHub's agent-independent MCP and CLI contract. Start
with [Coding-agent integrations](INTEGRATIONS_AGENTS.md) for the shared
security and workflow boundary; this page documents Codex-specific packaging.

DevHub includes a portable Codex plugin with a registry workflow skill. The
public plugin contains no server address, token, private profile or catalog:
every installation points it at the owner's own DevHub deployment.

## Start from the repository

The public repository is the user-facing entry point:

<https://github.com/MrUversky/devhub-core>

In a new Codex task, say:

> Set up DevHub for me from this repository.

Codex follows the reviewed [community first-run](COMMUNITY_BOOTSTRAP.md),
selects and verifies the current annotated public release, performs the machine
work and asks only recognizable deployment, host, folder and source questions.
The person does not need to know the plugin source name, choose a tag, assemble
JSON or follow a shell checklist.

After that canonical deployment is verified, an owner may separately ask for
the optional [owner-only Sites companion](SITES_COMPANION.md). It is a
preview-first private view, not the catalog, MCP server or monitoring backend.

## What “marketplace” means here

Codex plugin packaging calls a GitHub repository containing a machine-readable
plugin listing a **marketplace**. In this project:

- `MrUversky/devhub-core` is the public GitHub repository;
- `devhub-community` is the name of the plugin source described inside it; and
- `devhub` is the generic guidance plugin installed from that source.

There is no separate DevHub marketplace website or account. This repository
marketplace is distribution plumbing for Codex, and its existence alone does
not claim that DevHub is listed in a universal plugin directory. People should
receive the repository link; Codex can follow this page and the first-run
runbook.

## Manual plugin installation

Most people do not need this section. For a deliberate manual installation,
pin the public repository to one reviewed annotated release tag. Do not install
from a mutable branch:

```bash
codex plugin marketplace add MrUversky/devhub-core --ref <TAG>
codex plugin add devhub@devhub-community
```

Release evidence requires these remote commands to succeed in a fresh isolated
Codex home after the exact public tag is published. Pre-publication validation
of a staged local marketplace remains separate evidence.

For example, after the matching public release is published, `<TAG>` is an
exact value such as `v1.0.0-rc.6`. From an already downloaded and verified
DevHub checkout, the equivalent offline marketplace command is:

```bash
codex plugin marketplace add .
codex plugin add devhub@devhub-community
```

To refresh an existing install after plugin `0.7.0-alpha.5` is published:

```bash
codex plugin marketplace upgrade devhub-community
codex plugin add devhub@devhub-community
```

Restart Codex and start a new task after installing or updating the plugin so
the current skill is loaded. The plugin supplies guidance only; the local
Connected Setup runtime must separately pass `devhub doctor --workflow --json`.
The refreshed skill requires workflow contract v2 with task-observation
support. It automatically uses only already callable selected read-only tools;
a runtime bridge does not prove that a plugin is callable, and task-only results
remain unsaved review candidates. The agent reports saved profiles as saved
even when they need recheck, keeps task-only access unsaved, and reuses
already-returned recognizable labels instead of making another provider call
for display copy.

## Verify the local CLI separately

The plugin and MCP do not install the local workflow runtime. Prefer the
user-wide command from [Pinned user-wide CLI](INSTALLATION.md#pinned-user-wide-cli)
and verify it before any provider I/O:

```bash
devhub doctor --workflow --json
devhub doctor --install --json
```

If it is absent or incompatible, show **DevHub needs an update** with **Help me
update DevHub** and **Not now**. The help path uses one approved pinned runtime,
installer, checksum and release-evidence set; it does not use `npm -g`, `sudo`,
an unpinned download or a checkout symlink. Claude Code and Cursor use this
same CLI/MCP boundary.

## Configure MCP

For a loopback or private-network deployment using the network boundary:

```bash
codex mcp add devhub --url http://127.0.0.1:3000/mcp
```

For a remote deployment, use TLS and the authentication mechanism supported by your MCP client. DevHub bearer mode expects the token in an `Authorization: Bearer ...` header. Keep the token outside Git and do not paste it into project manifests, prompts, screenshots or issues.

The dashboard has no built-in login in the public alpha. An MCP bearer token protects only `/mcp`; use a VPN or authenticated reverse proxy for the dashboard.

Generate a non-mutating connection plan for either boundary with:

```bash
npm run devhub -- agent-setup codex --url https://devhub.example.com/mcp --auth bearer
```

## Use it naturally

After configuration, requests such as these invoke the registry workflow:

- “Where does this service run?”
- “Check DevHub for drift.”
- “Prepare a safe registration proposal for this project.”

MCP remains read-only. Registration changes are local Git edits that require normal review and validation.
