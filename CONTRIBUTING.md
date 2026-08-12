# Contributing to DevHub

Thank you for helping make private service inventories easier to understand
and maintain.

## Before opening a change

- Search existing issues and pull requests.
- Use a discussion or feature request before a large schema, security-boundary
  or control-plane change.
- Never include a real private catalog, internal hostname, personal filesystem
  path, access token, cookie, connection string or private key in an issue,
  fixture, screenshot or commit.
- Keep mutating service actions outside the read-only dashboard and MCP.

## Development setup

Use Node.js 22.13 or newer.

```bash
npm ci
npm run devhub -- validate --check
npm run lint
npm test
```

Use only fictional data in tests and examples. If a test needs a URL, use
reserved names such as `example.test`, loopback, or documentation address
ranges.

## Pull requests

Keep each pull request focused and explain:

- the user-visible outcome;
- security or privacy implications;
- files and contracts changed;
- validation performed;
- any known limitation or deferred follow-up.

Schema or registration workflow changes must update the relevant docs and
fixtures. Deployment changes must preserve a loopback/private-network default
and a non-root execution path.

By contributing, you agree that your contributions are licensed under the
Apache License 2.0.
