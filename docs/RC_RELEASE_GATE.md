# RC clean-room release gate

The `v1.0.0` release-candidate gate consumes one candidate evidence bundle built
from the sanitized public snapshot. It does not run the first-use transaction
from the private checkout and it does not publish a tag, release, package,
image or deployment.

## Exact candidate boundary

The `release-evidence` CI job exports the public snapshot once from the checked
out commit, runs the private fingerprint policy and generic privacy scanner,
builds the evidence twice, verifies both copies and requires a byte-for-byte
comparison. It uploads one bundle containing the source archive, npm-free CLI
runtime, standalone installer, CycloneDX SBOM, `SHA256SUMS` and
`RELEASE-EVIDENCE.json`.

`RELEASE-EVIDENCE.json` records the exact source commit, sanitized manifest,
artifact digests and the SHA-256 of the private fingerprint policy used for the
source and user-runtime privacy scans. The macOS and Ubuntu jobs download that
same bundle and do not check out the repository. They extract only its source
archive to obtain the gate harness and application source.

The gate writes one `RC-GATE-EVIDENCE.json` report per runner. The report binds
every passed check to the candidate version, source commit, evidence checksum,
runtime, installer, source archive, SBOM and privacy-policy digests. Candidate
reports are review evidence, not permission to publish. A pull-request run may
name GitHub's synthetic merge commit; after the RC change merges, the evidence
must be rebuilt from the exact `main` commit before a tag review.

Current candidate evidence uses format version 3, which requires the privacy
scan record. The verifier continues to accept published format version 2
evidence without that newer field, but the RC clean-room gate rejects it.

## Required transaction

On real macOS and Ubuntu runners the artifact-only harness verifies:

1. release evidence, deterministic checksums, SBOM identity, public manifest
   and privacy-scan evidence;
2. bad-checksum and checksum-valid truncated archives fail before activation;
3. a process-level interrupted install retries to one exact runtime;
4. install vN, upgrade to the exact candidate vN+1 and workflow doctor;
5. an absent catalog in a clean Git repository, plus local discovery inside
   one explicit approved root;
6. read-only onboarding preview, artifact-bound human review, apply preview and
   reviewed isolated apply;
7. a second apply of the same onboarding plan returns the existing verified
   commit and produces no new diff;
8. source validation and generated-catalog freshness on the proposal commit;
9. a built dashboard renders the reviewed project and MCP `list_projects`
   returns it;
10. stale evidence and catalog revision drift fail closed;
11. the unrelated intentionally dirty caller repository keeps identical
    working-tree bytes, modes and `git status --porcelain` output;
12. rollback to vN, re-upgrade to the candidate and uninstall while preserving
    catalog and configuration sentinels by default.

The prior vN input is the published `v0.7.0-alpha.2` runtime asset. CI downloads
`devhub-cli-v0.7.0-alpha.2.tar.gz` directly from that fixed release, and the
harness requires its pinned SHA-256 plus its clean runtime-manifest version and
source commit. The prior version, source and digest must differ from the
candidate and are recorded in `RC-GATE-EVIDENCE.json`.

## Platform claims and limitations

The Windows release-evidence job uses the same sanitized source asset for
workflow-doctor, external-path, starter-catalog and validate/check CI on a real
Windows runner. Public-repository Windows CI likewise materializes
`git archive HEAD` before manifest verification so it checks canonical Git
blob bytes instead of a checkout that may have rewritten line endings. The
manifest verifier ignores only root `.git` transport metadata and does not
normalize content or line endings.
It does not prove a Windows user-wide installer, local discovery, dashboard
service operation or recovery lifecycle, and there is no Windows service
installer claim. Windows support remains undocumented until those missing
capabilities receive their own release evidence.

The clean-room gate performs no provider call and uses no provider credential.
It does not exercise browser authorization, a daemon or resident agent,
automatic updating, public ingress, automatic merge, release publication,
production deployment or schema version 2. Private and legacy source-checkout
workflows remain covered by their existing validation, test, lint, public
export, privacy and packaging jobs.
