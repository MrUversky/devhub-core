# Changelog

Notable changes to the public DevHub snapshot are recorded here.

## Unreleased

## 1.0.0-rc.2 — Pending release

### Added

- A preview-first community promotion workflow verifies one exact annotated
  private tag, rebuilds the privacy-scanned public tree and release handoff
  twice, and exercises the staged `devhub-community` marketplace in an
  isolated Codex home before any public-repository write.
- The promotion can prepare one deterministic normal-history commit and draft
  pull request against an exact reviewed `devhub-core` base. Source, artifact,
  target-head, branch, pull-request or retry drift fails closed; merge, public
  tag and release publication remain separate maintainer approvals.

## 1.0.0-rc.1 — 2026-08-20

### Added

- `devhub onboard-apply` turns one reviewed, exact-revision onboarding plan
  into an isolated Git proposal without changing the active catalog checkout.
  Repeated apply is idempotent, stale evidence and catalog drift fail closed,
  and temporary worktrees and branches are cleaned after failure.
- A capability-based health-coverage matrix classifies every registered
  service without turning catalog, reported, provider or protected evidence
  into false LIVE status. Remaining device or owning-repository gaps stay
  explicit instead of being guessed healthy.
- An artifact-only RC gate proves install, bounded first map, reviewed apply,
  validation, dashboard and MCP, a real published-version upgrade and
  rollback, config-preserving uninstall, dirty-repository isolation and
  fail-closed recovery on macOS and Ubuntu. Windows evidence remains limited
  to source-asset CLI and path behavior.

### Changed

- Release evidence format version 3 requires privacy-scan provenance. The
  verifier remains compatible with published format version 2 evidence that
  predates that field.

## 0.7.0-alpha.3 — 2026-08-20

### Added

- `discover-local` performs bounded, deadline-isolated, no-follow discovery
  only inside explicit macOS or Linux roots and sends redacted review-only
  candidates through Discovery Inbox without catalog or repository writes.
- `devhub onboard` produces one deterministic, idempotent and review-only map
  from explicitly selected roots and sources without catalog, Git or provider
  writes.

## 0.7.0-alpha.2 — 2026-08-20

### Changed

- The application/runtime candidate and committed release intent are now
  `0.7.0-alpha.2`. The portable Codex guidance plugin remains independently
  versioned at `0.7.0-alpha.5`. Release verification fails when the intent,
  package/lock, generated source or CLI archive, SBOM, artifact filenames or
  release evidence disagree.

- DevHub now produces a checksum-verified, npm-free user-wide CLI runtime and
  standalone installer from the sanitized exact-commit snapshot. The runtime
  keeps catalog, profiles and generated JSON in external XDG paths, supports
  explicit atomic upgrade/rollback and preserves configuration on uninstall.

- The portable Codex guidance plugin is now `0.7.0-alpha.5`. Refresh the
  marketplace with `codex plugin marketplace upgrade devhub-community`, then
  reinstall it with `codex plugin add devhub@devhub-community`, restart Codex
  and start a new task. The plugin remains guidance-only; Connected Setup still
  requires the exact verified local workflow contract before provider I/O.
  Contract v2 adds selected-only task observations to one canonical setup run.
  Selected sources authorize already-available read-only checks before
  connection questions; task observations stay unsaved review-only candidates.
  Agent status now distinguishes current saved connections, saved connections
  that need recheck, and task-only access without extra provider calls for
  labels.
  The refreshed workflow can also preview and explicitly apply reviewed,
  path-scoped private health publication without Funnel, route resets,
  credentials or a resident agent.

- The hosted landing now follows install → setup → demo workspace: the hero
  points to the current-alpha installation path, workspace totals and hosts sit
  beside the demo catalog, and each Guardian metric has its own accessible help
  control and actionable project filter.

- Connected Setup keeps connector support, capability and selection separate.
  The public demo is support-only; private readiness comes only from a reviewed
  redacted preflight and is never simulated in the browser.
- Connected Setup now presents one honest two-step agent handoff: choose
  sources, then copy a selected-only request into Codex, Claude Code or Cursor.
  Source status is separate from inclusion, and the dashboard does not contact
  providers or simulate job progress.
- Connected Setup now copies an 899-character human handoff for GitHub, This
  computer, Vercel, Railway and OpenAI. The agent keeps the typed machine
  protocol internal, automatically uses selected already-authorized read-only
  tools, asks only for multiple-scope or new-authorization choices, keeps task
  observations unsaved and review-only, and performs no hidden provider or
  catalog writes.

- The earlier four-stage setup preview has been replaced by the two-step agent
  handoff above. Internal connect, map, review and proposal stages remain part
  of the real runner after the request is pasted.

### Added

- A versioned connector conformance kit and canonical runtime registry, plus a
  fictional third-party connector example with hard safety bounds.
- Bounded Vercel inventory and deployment evidence with distinct production
  and preview environments, and exact Sentry monitoring/release evidence that
  retains no event payload or stack trace.
- Reviewed accountable, operator, billing and credential stewardship with
  inherited provenance, separate access facts and non-secret credential
  inventory metadata.
- Guardian questions for unknown payer, orphaned references and single-person
  continuity risk without deletion or provider mutation.
- Connected Setup can run bounded GitHub, Railway and local-host sessions from
  reviewed non-secret connection profiles, then produce an artifact-bound
  Discovery Inbox and stdout-only catalog proposals.
- Verified setup state, incremental refresh and review-only disconnect output
  are available through the same portable CLI used by coding agents.

### Security

- `setup-run` now enforces one planning-inclusive command deadline, bounds
  asynchronous profile validation, and propagates aborts through local-host
  inspection subprocesses. The npm wrapper returns one partial read-only
  review after timeout without `process.exit`, credential echo or late writes.
- Provider adapters use fixed endpoints, external credential references,
  bounded responses and fail-closed unknown results; they never write provider
  or catalog state or retain raw logs, secrets or event content.
- Dashboard/public catalogs and MCP redact external secret-reference locators;
  only reference kind and configured state are presented.
- Reconciliation diffs redact locators; token-shaped references fail closed,
  expired access resolves unknown, and service-level explicit unknowns prevent
  unsafe inheritance of project stewardship defaults.
- Credentials stay behind environment, Keychain or supported secret-manager
  references; setup outputs are bounded, strictly revalidated and never become
  catalog truth without review and merge.

- Added one non-mutating `agent-setup` workflow for Codex, Claude Code, and
  Cursor with client-native MCP and instruction templates.
- Kept credentials in client environment variables and every MCP tool
  read-only; setup files contain no instance secret or private endpoint.
- Made the dashboard handoff and public documentation coding-agent agnostic.

## 0.7.0-alpha.1 — Read-only provider evidence

- Added a normalized read-only evidence-adapter contract with exact service
  identity, freshness and fail-closed unknown results.
- Added CLI collection and Portfolio Guardian review from reviewed binding
  files without changing the catalog or provider.
- Added narrow GitHub Release, Actions deployment and workflow-monitoring
  adapters with fictional tests and a configurable public example.
- Added reviewable deployment drift, stale recovery evidence and possible
  recurring-cost findings without automatic remediation or deletion.

## 0.6.0-alpha.1 — Operational context

- Added profile-specific App Passport expectations without a magic score.
- Added non-secret owner, data, cost, deployment and dependency facts.
- Added a recovery and ownership card to service details.
- Added a read-only Portfolio Guardian CLI and dashboard overview.
- Extended the Codex workflow to gather reviewed operating facts and prioritize
  portfolio evidence gaps without scanning or executing production actions.

## 0.5.0-alpha.1 — Public alpha

- Added the product promise: “Git remembers the code. DevHub remembers how it runs.”
- Added a product-led dashboard introduction for heterogeneous apps, APIs, workers and tools.
- Added typed service entry points for dashboards, documentation, repositories, logs and consoles.
- Added evidence-backed overlay proposals that never write to shared repositories or the live catalog.
- Added a fictional demo catalog and portable self-hosting documentation.
- Added a read-only MCP endpoint with optional bearer authentication.
- Added a portable Codex skill that discovers a user-configured DevHub MCP server.
- Added deterministic, privacy-scanned public source snapshots with fresh Git history.
- Added cross-device canonical/fallback endpoint semantics and honest device placement.
- Added an App Passport preview for evidence-backed operational readiness.
- Added portable Docker/systemd deployment, deterministic source archives, CycloneDX SBOMs, checksums and release evidence.
- Added Linux, macOS, Docker, systemd, clean-room and runtime verification gates.

DevHub is pre-1.0. Manifest, CLI and MCP compatibility changes are called out in release notes.
