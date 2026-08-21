# Release and compatibility policy

DevHub follows semantic versioning. Before 1.0, minor versions may add or
change manifest fields with a documented migration; patch versions should not
change the catalog contract.

## Public alpha artifacts

A trustworthy public release is produced from a public-safe source snapshot,
not by changing the visibility of a private operational repository. The
snapshot must contain fictional catalog data and fresh Git history.

The generated catalog identifies itself as `Public demo` and contains an empty
connection snapshot. A self-hosted operational installation identifies itself
as `Private workspace` and may project only redacted state from its own
reviewed profiles.

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
special files. It excludes only the root `.git` transport metadata; every
released path and its exact bytes, including line endings, remain bound to the
manifest. Development changes make the release manifest stale by design.

On Windows, verify an extracted release source archive or a `git archive HEAD`
tree, not a normal checkout that may have rewritten line endings. Public CI
uses the archive form and never normalizes changed content to make verification
pass.

Maintainers generate release evidence from that verified snapshot, never from
the private operational checkout:

```bash
npm run release:evidence -- --output ../devhub-release-evidence
npm run release:verify -- ../devhub-release-evidence
```

The output contains a deterministic source archive, an npm-free CLI runtime,
the standalone user installer, a normalized CycloneDX SBOM, machine-readable
exact-commit provenance and `SHA256SUMS`. The verifier reads the embedded
public and runtime manifests, rejects any extra, missing or changed package
file, and proves that the runtime contains no catalog or connection profile.
Generate the bundle twice in CI and compare it byte-for-byte before upload.

`config/release-intent.json` is the one committed application-release
declaration. It must match `package.json` and `package-lock.json`; the verifier
also requires the source and CLI archives, SBOM, versioned filenames and
`RELEASE-EVIDENCE.json` to carry that same version. The portable Codex plugin
has its own manifest version and may advance independently. These checks create
candidate evidence only: a maintainer still reviews the final archive and
manually approves any tag or release.

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

RC candidates additionally follow [RC clean-room release gate](RC_RELEASE_GATE.md),
including exact per-platform evidence and explicit Windows limitations.

Sites deployments follow the same boundary: build and package only from this
verified public snapshot. Add instance-specific `.openai/hosting.json`
metadata only inside a temporary deployment staging directory; it is not part
of the portable source artifact. After publishing, scan the live response for
private fingerprints instead of trusting the local archive alone.

Privacy scanning, package allowlisting and `npm audit --omit=dev
--audit-level=high` are blocking gates. Registry errors, unsupported artifact
formats and unavailable audit tooling fail the release rather than being
downgraded to warnings. CI may upload evidence for review, but it must not create
a tag or public release automatically.

## Upgrade and rollback

Back up the catalog before upgrading. A user-wide CLI upgrade installs a newer
pinned runtime and changes the active pointer only after checksum, manifest and
workflow smoke checks pass. `devhub-install rollback --version <VERSION>`
reactivates a retained runtime, and `devhub-install uninstall` preserves the
external catalog and configuration by default. Dashboard/server releases still
switch only after their dashboard and MCP checks pass.

Schema changes that cannot read the previous version require an explicit
migration tool and release-note warning.
