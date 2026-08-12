# Release and compatibility policy

DevHub follows semantic versioning. Before 1.0, minor versions may add or
change manifest fields with a documented migration; patch versions should not
change the catalog contract.

## Public alpha artifacts

A trustworthy public release is produced from a public-safe source snapshot,
not by changing the visibility of a private operational repository. The
snapshot must contain fictional catalog data and fresh Git history.

Before using an alpha release, verify its tag or commit, review release notes
and run the included validation and test commands. Container images or package
registry artifacts are supported only when explicitly linked from that
release; do not assume an unrelated package with a similar name is DevHub.

For an untouched source archive, verify the deterministic file manifest before
installing dependencies or initializing a new Git repository:

```bash
npm run artifact:verify
```

The verifier intentionally rejects extra, missing, changed, symbolic-link and
special files. Development changes make the release manifest stale by design.

Maintainers generate release evidence from that verified snapshot, never from
the private operational checkout:

```bash
npm run release:evidence -- --output ../devhub-release-evidence
npm run release:verify -- ../devhub-release-evidence
```

The output contains a deterministic source archive, normalized CycloneDX SBOM,
machine-readable provenance and `SHA256SUMS`. The archive verifier reads its
embedded public manifest and rejects any extra, missing or changed package file.
Generate the bundle twice in CI and compare it byte-for-byte before upload.

## Compatibility surfaces

Release notes identify changes to:

- project and host manifest schema versions;
- generated catalog format;
- CLI JSON output;
- MCP tool names, inputs and structured outputs;
- required Node.js and Docker versions;
- deployment and authentication assumptions.

Start, stop, restart and arbitrary shell execution are outside the read-only
MCP compatibility contract.

## Release verification

Maintainers should verify:

```bash
npm ci
npm run devhub -- validate --check
npm run lint
npm test
npm audit --omit=dev --audit-level=high
```

The final public artifact must also pass its privacy scanner, deterministic
export check, package file allowlist, clean-room installation, dashboard health
check and MCP initialization check. Docker releases must run as non-root and
remain loopback-bound by default. The Dockerfile requires the exported
`.devhub-public-snapshot` marker and must never be built from a private
operational checkout.

Privacy scanning, package allowlisting and `npm audit --omit=dev
--audit-level=high` are blocking gates. Registry errors, unsupported artifact
formats and unavailable audit tooling fail the release rather than being
downgraded to warnings. CI may upload evidence for review, but it must not create
a tag or public release automatically.

## Upgrade and rollback

Back up the catalog before upgrading. Build and validate a candidate release
separately, then switch the running version only after its dashboard and MCP
checks pass. Keep the previous verified source or image available for rollback.

Schema changes that cannot read the previous version require an explicit
migration tool and release-note warning.
