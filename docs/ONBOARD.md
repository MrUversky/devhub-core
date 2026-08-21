# Productized onboarding preview

`devhub onboard` is the version 1 review-plan facade for a first DevHub map. It
does not apply a plan and does not introduce another setup engine, matching
database or source of catalog truth.

From an installed user-wide runtime it can run in any working directory:

```bash
devhub onboard \
  --sources github,local-host \
  --root /absolute/operator-selected/projects \
  --host-id reviewed-workstation
```

From an explicitly supplied contributor checkout, use the equivalent
`npm run devhub -- onboard ...` command. The ordinary global path options and
their installed XDG defaults still select the external catalog, connection
profiles and generated outputs. The command never redirects mutable state into
the installed runtime or caller's working directory.

## Small orchestration seam

The facade owns only command parsing, deadline propagation, safe host
suggestions and the final redacted plan projection. Existing primitives remain
authoritative:

1. `init-catalog` supplies the absent-or-empty destination contract and starter
   host shape. Onboarding projects that dry-run into symbolic intended writes;
   it never passes `--apply`.
2. `setup-run` performs selected-only marker planning, reviewed-profile
   preflight and bounded provider collection through workflow contract version
   2 and the existing connector scope rules.
3. `discover-local` runs only when at least one absolute root was supplied and
   a host was bound by `--host-id` or reviewed runtime configuration. Its
   existing isolated child, no-follow reads, limits and process-group cleanup
   remain unchanged.
4. One additive `localDiscoveryDocument` input lets `runSetupReview` pass that
   validated local artifact into the existing Discovery Inbox beside the
   setup session. Discovery Inbox still owns matching, exact/possible/new
   classification, candidate IDs and review questions.
5. The existing strict catalog reader validates a non-empty reviewed catalog.
   The initializer's host validator checks an empty starter preview. The plan
   records the generated-catalog check as a verification step for a later
   separately reviewed apply workflow.

No other matching, provider, profile, catalog or validation logic lives in the
facade.

## Authority and identity

`--sources` is required and accepts only unique currently available canonical
source IDs. `--root` is repeatable, absolute and never inferred. The selected
source list and the supplied roots are the complete authority boundary;
provider I/O and local filesystem reads cannot add another source or root.
An agent may pass one absolute, transient `--task-observation` document through
the existing connector-owned setup-run bridge. The facade never creates that
document, expands its selected sources or turns task-only evidence into a saved
profile or exact catalog match.

The command suggests host kind, display hostname and one stable kebab-case host
ID from the local operating system and hostname only. Secret-shaped, malformed
or generic hostnames become an explicit safe fallback. A suggestion is not
reviewed host authority. If the catalog is empty, or selected roots need a host
and neither `--host-id` nor `DEVHUB_HOST_ID` binds one, the plan emits one host
identity question and performs no local enumeration. A selected host must
exist in an existing reviewed catalog and must match the current platform
before local discovery.

## Version 1 plan

The single stdout plan contains:

- exact selected source and redacted local-root authority;
- catalog, workflow, host-suggestion and artifact provenance;
- per-source checked or unresolved state;
- one catalog-contract classification for every active/production service;
- unresolved host, connection and Discovery Inbox questions;
- exact, possible, new, external, ignored or unknown candidate decisions;
- symbolic intended catalog/generated targets, never filesystem paths;
- current source validation and later generated-check/replay steps;
- an explicit no-write/no-diff safety result and deterministic SHA-256 plan ID.

Normal output shows the human progress summary only. It omits absolute paths,
profile IDs, credential locators, reviewed private scopes and machine JSON.
`--json` returns the bounded plan contract, still without absolute paths or
secret values. Root and workspace identities are one-way digests. Identical
catalog, selected authority, host facts and observations produce the same plan
ID and `diff.state: "none"`.

### Health-contract classification

`healthCoverage` is a read-only projection of the reviewed catalog. It does
not contact a service and cannot make a service `LIVE`. Each active/production
service receives exactly one capability classification:

- `direct-https-probe` — a reviewed HTTPS probe can be verified directly from
  the central DevHub host;
- `reviewed-tailnet-publisher` — a reviewed Tailscale Serve publisher exists;
  its device-local preview reuses `setup-host-monitoring`;
- `provider-evidence-only` — reviewed managed-platform deployment evidence
  exists, but it is not runtime reachability;
- `intentionally-not-checked` — an on-demand or internal service deliberately
  remains non-LIVE unless a later health contract is justified;
- `missing-health-contract` — an active always-on or managed service has no
  reviewed live probe or adequate documented boundary.

Accepted 401/403 statuses are projected as protected-or-success access, never
as an unauthenticated application-health claim. Provider deployment state is
also never promoted to runtime `LIVE`; that still requires a fresh
`source=probe` observation.

Publisher rows include only a dry-run `setup-host-monitoring` handoff. They are
not onboarding apply operations. Applying a reviewed route requires separate
explicit approval on the target device, and the route must then be verified
independently from the central DevHub host.

The first preview's `provenance.setupArtifactId` binds the existing Discovery
Inbox review document. Supplying that reviewed document produces another
read-only plan with only the already-reviewed overlay proposals embedded:

```bash
devhub onboard \
  --sources github,local-host \
  --root /absolute/operator-selected/projects \
  --host-id reviewed-workstation \
  --review /absolute/artifact-bound-discovery-review.json \
  --json > /temporary/path/approved-onboard-plan.json
```

Keep the plan file outside the catalog repository so the catalog base remains
clean. `--review` does not add authority: Discovery Inbox recomputes the exact
artifact, rejects stale or unrelated candidate decisions and emits only its
existing strict overlay proposal. Native project-manifest proposals stay
separate and no project repository is edited.

## Isolated apply and verify

`onboard` itself still has no `--apply`, Git, commit, pull-request,
provider-mutation or deployment option. The separate `onboard-apply` command is
also a preview by default:

```bash
devhub onboard-apply /temporary/path/approved-onboard-plan.json
```

The preview verifies the plan hash, exact runtime version, local Git repository
identity, base revision, catalog-source fingerprint, clean catalog checkout and
current candidate evidence. It derives one deterministic
`codex/onboard-...` branch name and lists the exact catalog/generated paths, but
creates nothing. The caller's current working directory may be unrelated and
dirty; the configured catalog repository may not.

After reviewing that result, explicit apply is:

```bash
devhub onboard-apply /temporary/path/approved-onboard-plan.json --apply
```

Apply rechecks every precondition before its first write, acquires the existing
catalog mutation lock and creates a dedicated temporary Git worktree from the
exact base revision. It can perform only these plan-enumerated reversible
actions:

- initialize an absent/empty starter catalog through the existing initializer;
- create strict DevHub-owned overlay project YAML already emitted by Discovery
  Inbox after review;
- refresh the generated catalog through the existing compiler.

Before committing, the temporary worktree passes strict source validation,
the catalog secret policy, doctor (errors block), generated freshness and Git
diff checks. Repository-backed generated outputs join the proposal; external
generated output is verified in transaction-local scratch space and removed.
Only the exact planned paths are staged. Native manifests, other project
repositories, connection profiles, providers and production systems are never
mutated.

Success returns the exact branch, commit, parent revision, files, verification
steps and next review action. It removes the temporary worktree and scratch
output while leaving the active catalog checkout at the original clean base.
It does not push, open a pull request, merge, publish or deploy. Repeating the
same current plan returns the existing verified commit instead of creating a
second proposal. That idempotent result re-runs source validation, doctor and
generated freshness against the exact existing commit in temporary scratch.

Catalog/base drift, a concurrent lock, expired evidence, a conflict,
validation failure or interruption fails closed. Before commit, the temporary
worktree and its new branch are removed; the active checkout remains unchanged.
An existing mismatched proposal branch is reported as a conflict and is never
overwritten.
