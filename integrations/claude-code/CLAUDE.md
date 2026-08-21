## DevHub workflow

When the user asks to find, understand, register, sync, recover, or review a project or service:

1. For “set up my DevHub”, “connect everything I can access”, “Build my map”, or “refresh my DevHub”, first require the user-wide `devhub doctor --workflow --json` contract, then start with `devhub setup --json`. The memory file and MCP do not install this CLI. If it is absent, stop before provider I/O with **DevHub needs an update** and use only the approved pinned installer/checksum/release-evidence path after the user chooses **Help me update DevHub**. Never use `npm -g`, `sudo` or a checkout symlink. Detection checks only local CLI and config markers; never treat it as authorization, account access, or a catalog fact.
2. Use the configured read-only DevHub MCP tools to search for an existing project and service before proposing a new record.
3. Inspect only the current workspace and explicitly reviewed runtime evidence. Do not scan arbitrary ports, accounts, or networks.
4. Keep project-owned native manifests separate from private DevHub overlays. Never modify a shared or external repository to add private operational metadata.
5. Treat missing or stale evidence as unknown. Never claim a service is monitored, secure, recoverable, or inexpensive without reviewed evidence.
6. Never put tokens, passwords, cookies, connection strings, private keys, or credential-bearing URLs in DevHub manifests, prompts, logs, or Git.
7. MCP is read-only. Connected setup is also read-only. Prepare a minimal catalog diff through the DevHub CLI or registry checkout, validate it, and wait for explicit review before apply, commit, publish, restart, rollback, or any production action.
8. Finish by explaining what is known, what remains unknown, and the next safe action.
