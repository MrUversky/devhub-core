# Codex integration

DevHub includes a portable Codex plugin with a registry workflow skill. The public plugin does not contain a server address or token: every installation points it at the owner's own DevHub deployment.

## Add the plugin marketplace

From a verified DevHub checkout:

```bash
codex plugin marketplace add .
codex plugin add devhub@devhub-community
```

Restart Codex after installing or updating the plugin.

## Configure MCP

For a loopback or private-network deployment using the network boundary:

```bash
codex mcp add devhub --url http://127.0.0.1:3000/mcp
```

For a remote deployment, use TLS and the authentication mechanism supported by your MCP client. DevHub bearer mode expects the token in an `Authorization: Bearer ...` header. Keep the token outside Git and do not paste it into project manifests, prompts, screenshots or issues.

The dashboard has no built-in login in the public alpha. An MCP bearer token protects only `/mcp`; use a VPN or authenticated reverse proxy for the dashboard.

## Use it naturally

After configuration, requests such as these invoke the registry workflow:

- “Where does this service run?”
- “Check DevHub for drift.”
- “Prepare a safe registration proposal for this project.”

MCP remains read-only. Registration changes are local Git edits that require normal review and validation.
