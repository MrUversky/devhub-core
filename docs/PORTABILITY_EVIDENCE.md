# Portability Evidence

## Purpose

This document provides a practical, reusable evidence-collection guide and template for operators testing the DevHub public alpha across diverse platforms, operating systems, and architectures.

The public alpha CI matrix validates Linux Node 22/24, macOS CLI workflows, Docker Compose containers, and systemd units. Real-world operator evidence expands portability confidence beyond this core matrix.

**Core rule:** Record actual, empirical test results from your environment. Do not make unsupported claims or assume an installation method succeeds on an untested system.

## Environment

Use the platform-appropriate commands below to capture precise environment metadata before running verification checks.

### Linux (bash)

```bash
uname -a
cat /etc/os-release
node -v
npm -v
git rev-parse HEAD
docker compose version 2>/dev/null || true
```

### macOS (zsh)

```zsh
sw_vers
uname -m
node -v
npm -v
git rev-parse HEAD
docker compose version 2>/dev/null || true
```

### Windows (PowerShell)

```powershell
[System.Environment]::OSVersion.VersionString
$env:PROCESSOR_ARCHITECTURE
node -v
npm -v
git rev-parse HEAD
docker compose version 2>$null
```

## Installation Path

Record which installation path was evaluated in your test session:

- **Source checkout**: Running directly from source via `npm ci`, `npm run devhub -- init --catalog`, `npm run devhub -- validate --check`, `npm run build`, and `npm test` or `npm run dev`.
- **Docker Compose**: Containerized execution via `docker compose -f deploy/docker/compose.yaml up --build -d`. (Supported on Linux and macOS; Windows Docker Desktop environments should note container mode).
- **systemd**: Service execution via the portable systemd unit (`deploy/systemd/`). (Supported on systemd-enabled Linux distributions).

Do not assume or claim that all installation paths function identically across every operating system unless verified directly on that target platform.

## Verification and Smoke Tests

Run these standard, read-only checks to gather diagnostic evidence:

### 1. Catalog Validation Check

Verifies that the compiled catalog JSON matches source YAML manifests:

```bash
npm run devhub -- validate --check
```

### 2. Catalog Doctor Audit

Generates machine-readable catalog health findings:

```bash
npm run devhub -- doctor --json
```

### 3. Dashboard HTTP Smoke Test

Verifies loopback HTTP accessibility:

- **Linux / macOS (bash / zsh)**:
  ```bash
  curl --fail --silent --show-error http://127.0.0.1:3000/ >/dev/null
  ```
- **Windows (PowerShell)**:
  ```powershell
  (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3000/).StatusCode
  ```

### 4. Read-Only MCP Initialization Test

Verifies MCP endpoint response without altering application state:

- **Linux / macOS (bash / zsh)**:
  ```bash
  curl --fail --silent --show-error \
    --header 'accept: application/json, text/event-stream' \
    --header 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":"install-check","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"install-check","version":"1.0.0"}}}' \
    http://127.0.0.1:3000/mcp
  ```
- **Windows (PowerShell)**:
  ```powershell
  Invoke-RestMethod -Uri http://127.0.0.1:3000/mcp -Method Post -ContentType "application/json" -Headers @{ "accept" = "application/json, text/event-stream" } -Body '{"jsonrpc":"2.0","id":"install-check","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"install-check","version":"1.0.0"}}}'
  ```

## Evidence Record Template

Copy and fill out the template below when recording testing evidence for a platform:

```text
Environment:
  OS / Distro:
  OS Version:
  Architecture:
  Node.js Version:
  npm Version:
  Container Runtime:
Installation:
  Path Used: [Source / Docker Compose / systemd]
  Commit Hash:
Commands Executed:
  -
Expected Result:
Observed Result:
  Dashboard Result:
  MCP Result:
  CLI Validation Result:
  Doctor Result:
Unexpected Behavior:
  [Describe any non-fatal ambiguities or unexpected output]
Reproducible Failure:
  [Describe exact error, exit code, or failure if applicable]
Relevant Logs:
  [Paste sanitized log snippet]
Additional Notes:
```

> [!IMPORTANT]
> **Sanitization Requirement:** Before submitting evidence, carefully remove all passwords, auth tokens, bearer credentials, private keys, secret-bearing URLs, internal IP addresses, personal identifiers, or sensitive host information.

## Portability Findings

Categorize observed findings under the following standard headings:

- **Installation failures**: Build, dependency installation, or execution failures during setup.
- **Platform-specific behavior**: Differences in shell syntax, file paths, environment variable handling, or line endings.
- **Node/runtime compatibility**: Behavior under specific Node.js or runtime versions.
- **Architecture differences**: Behavior specific to `x64`, `arm64`, or Apple Silicon architectures.
- **Docker/container behavior**: Container volume mounting, port binding, non-root user permission, or health check behavior.
- **systemd behavior**: Unit execution, path resolution, environment file sourcing, or permissions under systemd.
- **Device matching ambiguity**: Issues or edge cases when matching local hardware/host identity.
- **Endpoint resolution ambiguity**: Issues resolving canonical endpoints versus host fallbacks.
- **Status/evidence semantics**: Inconsistencies in reported service health, drift status, or overlay proposals.
- **Documentation gaps**: Missing steps, unclear instructions, or inaccurate prerequisites in repository docs.

## Reproducible Failures

If you encounter a reproducible installation or runtime failure, structure your report with these six items:

1. **Environment details**: Exact OS, architecture, Node.js version, and installation path.
2. **Exact command executed**: Full command line invocation.
3. **Expected behavior**: What should have happened according to repository documentation.
4. **Actual behavior**: Exit code, error message, or symptom observed.
5. **Relevant sanitized output**: Un-truncated error trace with secrets and personal data removed.
6. **Reproduction steps**: Step-by-step instructions to reproduce the failure on a clean environment.

> [!WARNING]
> Do not upload raw environment files, unedited diagnostic logs containing tokens, or private network details.

## Submission Guidance

To submit portability evidence or report findings:

1. Open a new issue or discussion item in the repository issue tracker.
2. Use the title format: `Portability Evidence: [OS / Environment] - [Summary]`.
3. Paste your completed, sanitized **Evidence Record** into the issue body.
4. Categorize any findings using the **Portability Findings** categories listed above.
