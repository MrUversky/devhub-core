# Host monitoring

DevHub models services by capability, not by a fixed machine layout. A user can
have no workstation, several Macs or Windows PCs, Linux machines, VPS hosts,
and any mix of managed platforms. Every service still has one reviewed host,
lifecycle, visibility, and observation method.

## Capability matrix

| Runtime | Inventory | Runtime evidence | Private publication | Typical setup |
| --- | --- | --- | --- | --- |
| Managed platform such as Vercel, Railway, Cloud Run or Sites | Provider connector when available; otherwise reviewed catalog | Direct HTTPS health probe; provider evidence is complementary | Not normally needed | Register the canonical deployment URL and a cheap public health route. An accepted 401/403 proves only `PROTECTED` reachability, not LIVE application health. |
| VPS or server such as Hetzner | Reviewed host plus provider inventory when available | Direct HTTPS or tailnet health probe; process evidence can supplement it | Existing reverse proxy or Tailscale Serve | Keep one stable health URL per independently operated service. |
| macOS, Windows or Linux workstation | Reviewed host and project/service registration | Direct tailnet health probe while the machine and service are online | Path-scoped Tailscale Serve publisher | Add a minimal loopback health endpoint, preview `setup-host-monitoring`, then apply the reviewed routes. |
| Internal process without an HTTP endpoint | Reviewed service registration | Supervisor/provider evidence, reported observation, or `unknown` | None until a safe health contract exists | Do not turn a stale report into LIVE. Add a minimal health contract when it materially helps operations. |

Current bounded provider connectors cover Vercel and Railway. Google Cloud is
planned; Cloud Run, Sites and Hetzner resources otherwise use reviewed catalog,
direct probes and explicitly sourced evidence. See [Provider inventory](PROVIDER_INVENTORY.md)
for the current connector boundary.

Provider inventory answers “what is deployed and where.” A health probe answers
“does the reviewed endpoint respond now.” A publisher only makes a private
loopback health endpoint available inside the reviewed tailnet; it does not by
itself prove that the central DevHub host has the required DNS and ACL access. Remote
maintenance tools answer a different question and do not establish health by
themselves.

## Self-service onboarding

1. Register the host and each separately operated service.
2. Prefer a cheap, side-effect-free health endpoint that reveals no operator or
   customer data.
3. For managed/cloud services, point the reviewed probe at the canonical HTTPS
   endpoint. No workstation setup is involved.
4. For a private workstation endpoint, declare `probe.publish` and preview the
   exact device-local plan. Run this from a compatible DevHub runtime/checkout
   that contains the current reviewed catalog; the guidance plugin and MCP do
   not install this mutating CLI:

   ```bash
   npm run devhub -- setup-host-monitoring developer-workstation
   ```

5. Apply only after reviewing the exact paths and local target state:

   ```bash
   npm run devhub -- setup-host-monitoring developer-workstation --apply
   ```

6. Verify the published URL from the central monitoring host. `applied` means
   the device-local route and target were verified; `centralVerification`
   remains `pending` until this end-to-end probe succeeds. A browser refresh is
   not a substitute for that check.

The command is dry-run by default and fail-closed. It reads only reviewed
catalog routes, checks the local Tailscale identity, preserves unrelated Serve
handlers, never enables Funnel, never stores credentials, and never installs a
resident agent. Apply is protected by a lock and removes only newly added paths
if device-local verification fails.

If a crashed apply leaves a host-monitoring lock in the operating system's
temporary directory, first confirm that no setup process for that host is
running, then remove only that exact lock file. DevHub deliberately does not
reclaim stale locks automatically because two operators must never be allowed
to mutate the same Serve routes concurrently.

Prerequisites are an online Tailscale client, MagicDNS and HTTPS certificates
for the tailnet name, and ACL/grant policy that permits the central DevHub host
to reach the published HTTPS route. Setup does not modify any of these controls.
Use a current Tailscale CLI whose `tailscale serve --help` includes `--set-path`;
on Windows, run the required Tailscale/terminal setup with Administrator rights
as documented by Tailscale. Linux service users also need permission to use the
local Tailscale daemon.

From the central DevHub host, verify each reviewed URL exactly:

```bash
curl --fail --show-error --max-time 8 https://workstation.example.test/health/example
```

Then wait for the configured backend probe interval and confirm the service is
`LIVE` with `source=probe` and a fresh `checkedAt` in the DevHub status view.
See the [Serve CLI reference](https://tailscale.com/docs/reference/tailscale-cli/serve)
and [Windows Serve example](https://tailscale.com/docs/reference/examples/serve).

## Remote access is separate

Codex Remote Connections, SSH, Screen Sharing and RDP can help an operator set
up or repair a machine. None of them is required for steady-state monitoring.
The finished setup is a reviewed health endpoint plus an observation path, so
DevHub continues to behave honestly when no coding agent is running there.
