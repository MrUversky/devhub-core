# Privacy and data handling

DevHub is designed for operational metadata, not secrets. A real catalog can
still reveal project names, repository ownership, local filesystem paths,
internal hostnames, network topology, service URLs and recovery commands.
Treat the catalog and every derived artifact as private data.

## Data surfaces

The following contain or expose catalog data:

- `catalog/**/*.yaml`;
- `.devhub/project.yaml` in native project repositories;
- generated `app/generated/catalog.json` and `public/catalog.json`;
- the rendered dashboard and status API;
- MCP tool responses;
- screenshots, logs, support bundles, Git history and release archives.

Deleting a value from the current YAML does not remove it from Git history or
previous artifacts.

## Safe operating rules

- Start with the fictional demo catalog and replace it locally.
- Keep the repository private once it contains real operational metadata.
- Bind the application to loopback, a private network, or an authenticated
  reverse proxy.
- Grant MCP access only to clients and people allowed to read the catalog.
- Sanitize logs and examples before opening an issue.
- Prefer overlay registration when project metadata should not enter a shared
  repository.
- Rotate an exposed credential before cleaning history or artifacts.

DevHub health probes send unauthenticated HTTP GET requests from the server to
the reviewed URLs in the catalog. Those destinations may observe the server's
source address, request time and normal HTTP headers. DevHub does not send
catalog credentials or browser cookies with probes.

## Public snapshots

Official public source snapshots must contain only fictional examples and be
built from an explicit allowlist. A private operational repository should
never become public by changing its visibility: private values can remain in
Git history even after the current tree is sanitized.

If you maintain a private fork, publish reusable code through a fresh,
verified snapshot with new Git history. Scan the final archive independently;
do not assume `.gitignore`, `.npmignore` or deleting files is sufficient.
