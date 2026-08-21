# Bounded local discovery

`discover-local` finds review-only project and service candidates inside roots
the operator selected explicitly. It is additive to `inspect-host`:
`inspect-host` still checks only services and workspaces already present in the
reviewed catalog, while `discover-local` is the bounded path for previously
unregistered local candidates.

[`devhub onboard`](ONBOARD.md) can compose the same isolated discovery into one
first-map plan. It never invents a root, and it does not start local discovery
until the host is bound by an explicit argument or reviewed runtime
configuration.

```bash
devhub discover-local developer-laptop \
  --root /absolute/path/to/projects \
  --root /another/absolute/selected/root \
  --json
```

The host ID must already exist in `catalog/hosts.yaml` and must identify the
current supported platform. The command supports macOS and Linux. It rejects
Windows before inspection until Windows path and hostile-filesystem fixtures
pass. Every root must be absolute, present and a directory. Duplicate,
canonical-duplicate and overlapping roots fail during preflight, before any
root contents are enumerated.

## Authority and limits

The selected roots are the complete filesystem authority boundary. Discovery
never adds a home directory, repository parent or another volume implicitly.
It skips symbolic links and never follows one to a file or directory outside a
selected root. Regular evidence files are opened with no-follow semantics in a
killable isolated process.

Defaults are deterministic and may only be lowered or raised within hard
caps:

| Limit | Default | Hard cap |
| --- | ---: | ---: |
| Directory depth | 4 | 12 |
| Directory entries | 10,000 | 100,000 |
| Allowlisted evidence bytes | 1 MiB | 8 MiB |
| Overall deadline | 10 seconds | 30 seconds |

Use `--max-depth`, `--max-entries`, `--max-bytes` and `--deadline-ms` to choose
an explicit bounded run. Entry, byte, candidate, filesystem and deadline
failures return an `unknown` Discovery Inbox scope with no partial candidates.
The parent process terminates and reaps the isolated process group on deadline
or abort.

## Allowlisted evidence

Discovery reads only these shapes:

- `.devhub/project.yaml`: project ID/title/repository and service ID/name/runtime;
- `.git/config`: one credential-free canonical GitHub `origin` identity;
- `package.json`: package name and script names, never script values;
- `compose.yaml`, `compose.yml`, `docker-compose.yaml` or
  `docker-compose.yml`: top-level service names only;
- launchd plists with one safe `Label` plus `Program` or `ProgramArguments`,
  only in `~/Library/LaunchAgents`, `/Library/LaunchAgents` or
  `/Library/LaunchDaemons` when that location is selected;
- systemd service units with a `[Service]` section and `ExecStart` declaration,
  only in `~/.config/systemd/user`, `/etc/systemd/system`,
  `/usr/lib/systemd/system` or `/lib/systemd/system` when selected.

It does not execute Git, package scripts, Compose, launchctl, systemctl or any
discovered command. It does not read environment values, scan ports or
networks, enumerate processes, inspect browser/provider sessions or accept an
arbitrary OS-service location. Values below the allowlisted fields—such as
Compose environments, package script bodies, manifest commands and service
arguments—never enter normalized output.

## Review and privacy boundary

The command returns the existing version 1 `discovery-inbox` contract. Local
workspace and root identities are one-way digests; absolute roots and workspace
paths are not printed. Candidates carry source, observation/freshness,
deterministic bounds and uncertainty. Exact reviewed workspace or repository
identity may classify a known project; name, manifest and service evidence is
supporting evidence only when it is not exact.

New and possible candidates use the existing artifact-bound grouped questions.
An optional review document is supplied with `--review review.json`. Any YAML
proposal remains stdout-only and appears only after the existing candidate and
artifact review gates. Discovery never writes a catalog, project repository,
profile, generated dashboard file or hidden state.

Local metadata does not establish accountable owner, payer, lifecycle mode,
environment, visibility, reachability or `LIVE` state. Package and Compose
shapes may suggest a runtime candidate, but operating intent remains an
explicit review question. Repeated unchanged runs produce the same ordered
candidates and review artifact even though each real run receives its own
short freshness window.
