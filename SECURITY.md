# Security policy

DevHub stores operational metadata and can make HTTP probes from the server's
network. Treat its catalog, dashboard and MCP endpoint as private unless you
have deliberately added an authentication boundary.

## Supported versions

Before 1.0, security fixes are made on the latest released minor version only.
Older alpha snapshots may not receive patches.

## Report a vulnerability

Do not open a public issue containing exploit details, private infrastructure
metadata or secrets. Use the repository's **Security → Report a
vulnerability** flow to create a private security advisory. If that feature is
unavailable, contact a maintainer privately through the contact method listed
on their GitHub profile and provide only enough information to establish a
secure reporting channel.

Include the affected version, deployment model, reproduction steps and impact.
Maintainers aim to acknowledge a complete report within seven days; alpha
software does not yet carry a formal response-time guarantee.

## Security boundaries

- The dashboard has no built-in user authentication in the self-hosted alpha.
- MCP can require a bearer token, but that does not protect the dashboard.
- Bind to loopback by default. Use a VPN or authenticated reverse proxy for
  access from other devices.
- MCP is read-only but exposes operational metadata to every client that can
  reach it.
- Health probes are accepted only from reviewed catalog entries. Browser and
  MCP callers cannot supply arbitrary probe URLs.
- Commands in manifests are documentation. The web application and MCP do not
  execute them.
- Never store credentials, cookies, private keys, connection strings or
  secret-bearing query parameters in a catalog.

If you believe a catalog accidentally included a secret, rotate the secret
first. Removing the current file is not sufficient because Git history and
release artifacts may retain it.
