# Optional owner-only Sites companion

The Sites companion is an optional read-only view of an already verified,
self-hosted DevHub. It is not the first-run deployment, catalog, MCP server,
monitoring backend or source of truth. Complete the canonical
[community bootstrap](COMMUNITY_BOOTSTRAP.md) first, including dashboard, MCP,
catalog revision and idempotence verification.

Start a Codex task with a request such as:

> Add the optional private Sites companion to my verified DevHub. Reuse my
> existing companion if I have one, show the preview before publishing, and do
> not expose my backend or copy credentials.

Codex does the source, catalog, build and Sites work. The user chooses only
whether to add the companion and whether to publish the shown private preview.
This workflow composes the existing dashboard/status bridge and the installed
Sites building/hosting contracts. `devhub sites-companion` is only a strict
staging helper; it does not implement another setup engine or hosting API.

## Preconditions

Continue only when all of these are already proven:

- one exact annotated public tag in `MrUversky/devhub-core`, its peeled commit,
  release assets, checksums and privacy evidence were verified together;
- the extracted public source matches its exact
  `PUBLIC_EXPORT_MANIFEST.json` and the reviewed manifest digest;
- the canonical self-hosted dashboard and MCP passed the #118 verification;
- the selected user catalog is in a clean Git repository at one exact reviewed
  commit; and
- the canonical backend has one reviewed HTTPS origin reachable by the
  viewer's browser. Loopback from another device is not a usable origin.

Unknown source, mutable branch, dirty catalog, unverified companion binding or
missing private Sites capability stops the optional workflow. It never blocks
or weakens canonical DevHub.

## Phase 1: preview exact staging

Codex reads an optional external binding from the user's DevHub configuration
area. The binding contains only the Sites project ID, exact Site origin and the
current/prior saved version IDs. It is never placed in the public source,
catalog repository, plugin or release artifact. A valid binding means **reuse**;
no binding means **create one Site in this invoking Sites account**. A binding
from another account, another owner's private Site or an unverified project is rejected.

Codex runs the staging helper without `--apply` first. The values below are
internal machine evidence; the user sees the exact release, catalog revision,
create/reuse choice, backend origin and private-access summary rather than a
shell checklist.

```bash
devhub sites-companion \
  --source-dir /absolute/verified/public-source \
  --source-tag <EXACT_ANNOTATED_TAG> \
  --source-manifest-sha256 <VERIFIED_PUBLIC_MANIFEST_DIGEST> \
  --catalog-dir /absolute/reviewed/catalog \
  --catalog-revision <EXACT_CLEAN_CATALOG_COMMIT> \
  --status-api-origin https://canonical-private-devhub.example \
  --staging-dir /absolute/fresh/temporary/sites-companion \
  --binding-file /absolute/private/devhub/sites-companion.json \
  --json
```

The preview is read-only. After **Prepare this private companion** approval,
Codex repeats the exact command with `--apply`. Only the new temporary staging
directory may be written.

The helper copies files exclusively from the verified public manifest, then
applies the bounded companion transform:

- replace the demo catalog with a catalog generated from the exact reviewed
  revision;
- keep project/service identities and placement fields needed by the view;
- remove connection profiles, credentials, credential locators, access facts,
  stewards, workspaces, readiness evidence, URLs, commands, probes and reported
  states;
- remove `/api/context`, `/api/status` and `/mcp` from the Site source;
- record source, catalog, exclusions and required runtime values in
  `SITES-COMPANION-MANIFEST.json`; and
- leave `.openai/hosting.json` absent.

The companion therefore contains no private context route, status worker,
provider relay or control surface. The only changing status data comes later
from the canonical DevHub route in the viewer's browser.

## Phase 2: create or reuse one private Site

Codex uses the installed Sites building/hosting workflow and its currently
callable connector contracts. It does not guess connector arguments. Before
writing, it resolves the invoking Sites account and proves the planned access:

```text
visibility: custom/private
allowed owners: the invoking owner only (1)
allowed groups: 0
external visitors: 0
```

If the connector cannot create or verify that access, stop. Do not substitute
a shared/public deployment. With a valid binding, reuse exactly its project ID;
never search by a common display name and never create a second Site because a
lookup was inconclusive. Without a binding, **Create this owner-only Site** is
a distinct user approval. Creating it establishes the exact Site origin but
does not publish a version.

Only after create/reuse may the Sites workflow add that project's
`.openai/hosting.json` inside the temporary staging tree. The file stores only
the resolved project ID and any connector-owned logical bindings. It is never
copied back to the verified public source or catalog repository.

Configure these non-secret runtime values through Sites, not Git:

```text
DEVHUB_SITES_COMPANION=owner-only
DEVHUB_STATUS_API_BASE_URL=https://canonical-private-devhub.example
```

The second value is an exact origin only. The application derives exactly
`<origin>/api/status`; a path, query, fragment, credentials, wildcard, browser
input, local storage or arbitrary URL is rejected.

The canonical backend separately allows exactly the new Site origin through
`DEVHUB_STATUS_CORS_ORIGINS`. That backend change is its own reviewed operator
boundary. It permits credential-free browser reads only for `/api/status`,
never `/api/context`, MCP or another route. If Codex lacks already approved
backend access, it reports this as a prerequisite instead of creating a tunnel,
Funnel, Worker relay, public ingress, token or provider authorization.

## Phase 3: build and preview

Codex builds the staged source with the Sites workflow. Validation requires:

- the staging manifest still binds the exact public source manifest and exact
  catalog commit/fingerprint;
- generated catalog counts match the sanitized YAML and no forbidden field or
  secret-bearing URL appears in the packaged output;
- `.openai/hosting.json` contains only the current ephemeral Site binding;
- the packaged Worker exposes neither `/api/context`, `/api/status` nor `/mcp`;
- the page performs only
  `fetch(<fixed-origin>/api/status, { credentials: "omit", mode: "cors" })`;
  and
- invalid, unknown, duplicate-key, unavailable and stale status evidence never
  renders as `LIVE`.

Codex shows one private preview before any production Sites version is
deployed. The preview may report **Central LIVE unavailable** until the browser
is on the reviewed private network, local-network access is allowed and the
exact CORS origin is active. That is an honest availability result, not a
deployment failure and never a reason to expose the backend.

## Phase 4: explicit publish and binding

Only **Publish this private companion** authorizes saving and privately
deploying the exact previewed version. Public/shared deployment, automatic
merge/deploy and access broadening remain forbidden. After the connector
reports success, Codex rechecks one owner, zero groups, zero external visitors,
the exact source/version and the live URL without exposing private fingerprints.

Then, and only then, Codex atomically records the external version 1 binding:

```json
{
  "version": 1,
  "kind": "devhub-sites-companion",
  "projectId": "connector-returned-project",
  "siteOrigin": "https://owner-site.example",
  "currentVersionId": "new-saved-version",
  "previousVersionId": "previous-saved-version-or-null"
}
```

The next unchanged run must select `reuse`, return the same project ID and
produce the same sanitized catalog from the same revisions. It may build a new
saved version only when source/catalog evidence changes and the user explicitly
publishes it.

## Rollback, removal and failure

- **Rollback Site version** redeploys only `previousVersionId` through the
  Sites connector after explicit approval, then swaps the binding's current and
  prior IDs after success.
- **Remove companion binding** deletes only the reviewed external binding after
  approval. It does not delete the Site, catalog, canonical DevHub, MCP or
  backend configuration.
- Site deletion, access changes and backend CORS removal are separate explicit
  operations and never inferred from removing the local binding.
- A failed build/publish leaves the prior deployed version and binding
  unchanged. Temporary staging may then be discarded.
- When the browser cannot reach the backend, clear prior live observations and
  show unavailable. Do not reuse a cached `LIVE` label.

This workflow never performs browser OAuth, provider discovery/mutation,
schema-v2 migration, arbitrary scanning, unrelated personal-system changes,
public ingress, daemon installation, automatic release or a hosted DevHub
control plane.
