# Target: the registry (milestone 5, screen 8)

> **Committed image:** `registry.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel.

- **Prompt:** `registry.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 1 generation, kept as made. References: `app-targets/m2/storage-settings`' 2048 original (the approved page this one starts from, spec section 12), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`.
- **Route (new):** `apps/web/src/app/(panel)/organization/registry/page.tsx` → `components/organization/registry-view.tsx`.
- **Features:** F-120 (the snapshot registry); F-093 and F-051 for the pools and snapshots it lists. Spec section 12, screen 8; section 3, steps 12 and 13; section 11, item 11. Ticket 17 (`setRegistry`, `registry.check`, the credentials), ticket 28 (`registry.get`, `registry.set`, `registry.clear`, `registry.check`), ticket 33 (this screen). ADR 0060, ADR 0038, ADR 0030.
- **Status:** a proposed target, waiting on approval (ticket 29's `## Comments`). Ticket 33 builds its data and tests until then, not its UI.

> Build it in real HTML/React (app-design.md, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

An organization admin tells ostra where to keep environment snapshots, so pool runners build once and pull by digest. The page answers five questions, in this order:

1. **Where is it?** The registry's address and the repository prefix ostra names images under: `<address>/<prefix>/<projectId>:<snapshotId>`, always pulled by digest (spec section 5.4).
2. **What may ostra do there?** A push credential and a pull credential, which may differ (the docs recommend a pull-only one), or, for pulls on `kubernetes`, the cluster's own identity with no credential in ostra (Q240). A credential is shown only as set or not set. Its value never reaches the browser after it's sent (ticket 28: "never its value").
3. **Does it work?** "Check" asks core to sign in, start and cancel an upload, and read a manifest. It pushes nothing (ticket 17), and its result has three outcomes: both allowed, pull only, refused.
4. **Who needs it?** Every `kubernetes` pool needs it: without one it builds nothing and its tasks wait with `needs-registry`. A `docker` pool uses it when it's set and builds locally without (milestone 3's path, kept).
5. **What's in it?** The organization's snapshots pushed there, each with its project, digest, where it was built and when.

The picture shows Alex Kim with a registry set, both credentials set, a passing check, two pools that use it and four snapshots.

## Layout (CSS px at 1440 wide)

| Region | Size | Contents |
|---|---|---|
| Sidebar | 232px, `--side`, 1px `--line` on its right | the shared sidebar. Organization gains **Registry** (Lucide `container`), admins only, selected here (`--sel`). Its place: after Box sizes (`m5/box-sizes`). Build it from `components/shell/sidebar.tsx`, not from the picture |
| Top bar | 44px, 1px `--line` below | breadcrumb `Acme Corp › Registry`; on the right the page's one primary button, `Save`, disabled until the address, prefix, pull mode or a credential differs from the saved one |
| Page | `1fr`, padding `28px 40px`, content max 720px | title, lede, Address, Credentials, Check, Pools that need it, Snapshots |
| Properties panel | **300px**, 1px `--line` on its left, padding `20px 18px` | Registry, Credentials issued, Last change |

### Heading

- Title `Registry`, Manrope 700 24px, letter-spacing −0.015em.
- Lede, 13.5px `--muted`, one line: `Where ostra keeps environment snapshots, so pool runners pull them by digest.`

### Address

1. **Title** `Address` (`Section`, 600 13px).
2. **Key/value rows,** no box: 40px rows, a 1px `--line` hairline above each and under the last; key column 180px, 13px `--muted`.

| Key | Control | Notes |
|---|---|---|
| `Registry` | a Plex Mono `Input`, 320×28px, `registry.acme.dev` | a host with an optional port (`localhost:5000`), no scheme; `https://` pasted in is stripped. `http://` is refused unless the host is `localhost` (the dev registry, ticket 36) |
| `Repository prefix` | a Plex Mono `Input`, 160×28px, `ostra/` | one or more path segments ending in `/`; the trailing `/` is added on blur. Lowercase letters, digits, `.`, `_`, `-` and `/` (the distribution spec's name rule) |

3. **Help,** 10px under the rows, 12.5px `--faint`: `Images are named registry.acme.dev/ostra/<project>:<snapshot> and always pulled by digest.` The name in Plex Mono, built live from the two inputs.

### Credentials

1. **Title** `Credentials`, inline note 12.5px `--muted`: `kept in the secret store, never shown again`.
2. **Rows,** as above:

| Key | Value | Right |
|---|---|---|
| `Push credential` | Lucide `check` 13px `--muted` and `Set` (13px `--text`), then 12.5px `--faint` `by Alex Kim, 12 Nov` (who set it, when). Not set: `Not set` in `--muted`, and no meta | an outline `Button` 28px: `Replace`, or `Add` when not set |
| `Pulls with` | a `RadioGroup`, inline, 16px radios: `A pull credential` and `The cluster's own identity`, the second followed by 12.5px `--faint` `kubernetes pools only` (`kubernetes` in Plex Mono) | – |
| `Pull credential` | as the push row; its meta adds `pull-only` when the last check found push refused for it. Hidden when `The cluster's own identity` is chosen | `Replace` / `Add` |

3. **The credential form.** `Replace` or `Add` opens the row in place (the row grows to 112px; no dialog): `Username` (`Input`, 240px) and `Password or token` (`Input type="password"`, 240px, `autocomplete="off"`), then ghost `Cancel`. The values stay in the form until `Save` in the top bar sends them with the rest (`registry.set`); a credential left out keeps the stored one (ticket 28). After a save the fields are cleared from the page's state and the row shows `Set` again. Nothing ever fills these fields from the server.
4. **Help** under the rows, 12px `--faint`, only while `A pull credential` is chosen and no pull credential is set: `Pulls use the push credential until a pull credential is set. A pull-only token is safer.` (Recommended, not decided by ticket 17: see open point 1.)
5. **Clear,** a ghost `Button` in `--muted` under the section, `Remove registry`, opens the clear dialog (below). Not drawn in the picture.

### Check

One row, 32px: an outline `Button` 28px with Lucide `refresh-cw` 13px, `Check`, then 12px right the last result as one line and its age in Plex Mono 12.5px `--faint`. Under it, 12px `--faint`: `The check signs in and starts and cancels an upload. It pushes nothing.`

| Result | Icon and colour | Copy |
|---|---|---|
| both allowed (the picture) | Lucide `circle-check` 15px `--green` | `Push and pull both allowed for ostra/` |
| pull only | Lucide `circle-alert` 15px `--muted`; text `--text` | `Pull allowed, push refused for ostra/. Snapshots can't be pushed until the push credential can write there.` |
| refused | Lucide `circle-x` 15px `--red`; text `--red` | `Refused: <the registry's answer, from the stored result's message>`, e.g. `Refused: 401 Unauthorized from registry.acme.dev` |
| unreachable | as refused | `Couldn't reach registry.acme.dev: <reason>` |
| checking | a 13px `Loader` in the button, the button disabled | `Checking…` in `--muted` |
| never checked | – | `Not checked yet.` in `--faint` |

The prefix in the result is Plex Mono. The check runs on the **saved** settings: with unsaved changes the button is disabled with a `Tooltip` `Save first: the check uses the saved settings.` Saving queues a check by itself (ticket 17's `registry.check` job, once per settings' version), so the row shows `Checking…` right after a save. The result arrives by the page's live updates; no polling.

### Pools that need it

Title `Pools that need it`, the count in faint mono. 40px hairline rows, grid `220px 1fr`:
- the pool's name (Plex Sans 500 13px `--text`, a link to its page, `m5/pool`) and an outline `Badge` in Plex Mono 11px `--faint` with its executor
- 12.5px `--muted`, one line: `kubernetes`: `pulls every snapshot from here; can't start a box without it`. `docker`: `pushes and pulls here; builds its own without a registry`.

`host` pools aren't listed (they keep a host cache, milestone 3). No pool on `kubernetes` or `docker`: one row in `--faint`, `No pool uses a registry yet. kubernetes pools need one; docker pools use it when it's set.`

With no registry set, a `kubernetes` pool's row reads in `--red`: `needs it: its tasks wait until a registry is set`, and the row keeps the pool link.

### Snapshots

Title `Snapshots`, the count in faint mono. A `Table`, no box: header row 30px, 11.5px `--faint` 500; body rows 40px with hairlines. Grid `1fr 130px 170px 160px 72px`.

| Column | Contents |
|---|---|
| `Project` | the project's 8px square and its name, a link to its Environment page (`m3/environment-services`) |
| `Snapshot` | the snapshot's ID, Plex Mono 12.5px `--text` |
| `Digest` | Plex Mono 12.5px `--faint`, `sha256:` and the first 6 and last 4 hex characters with `…`; hover shows the whole digest in a `Tooltip`, and a ghost copy icon (Lucide `copy` 13px) appears on row hover, which copies the full reference `registry.acme.dev/ostra/<projectId>@sha256:…` |
| `Built on` | 12.5px `--muted`: the runner's name and the builder, `k8s-east, BuildKit` or `build-02, docker` |
| `Pushed` | Plex Mono 12.5px `--faint`, right-aligned, relative (`2h ago`) |

Rows sort newest first; 20 per page with the `m4/audit-log` pager when there are more. Only snapshots with `pushedAt` are listed (one kept on a `docker` host without a push isn't in the registry). No snapshots yet: one row in `--faint`, `Nothing pushed yet. A snapshot is pushed here when an environment's next build finishes.`

### Properties panel

`PropGroup`s with an 11px 500 `--faint` label, 30px `PropRow`s, key column 104px, 12.5px.

1. **Registry:** `Status` · a 7px dot and the check's short form: `--green` `Push and pull allowed`, `--muted` `Pull only`, `--red` `Refused`, or `--faint` `Not checked`. `Auth` · `Basic` or `Cluster identity`. `Images` · the snapshot count (Plex Mono). `Last check` · relative time (Plex Mono) or `never` in `--faint`.
2. **Credentials issued:** `Pulls today` and `Pushes today` (Plex Mono): the day's `registry.credential-issued` audit entries (ticket 17), by kind. A pull with the cluster's identity issues nothing, so `Pulls today` reads `–` in that mode.
3. **Last change:** the newest `registry.set` or `registry.cleared` entry as one 12.5px `--muted` sentence (`Alex Kim replaced the pull credential`, `Alex Kim set the address to registry.acme.dev`, `Alex Kim switched pulls to the cluster's own identity`), its age in Plex Mono `--faint` at the right, then a teal `Audit log →` to the audit log filtered to `registry.*`.

## States and copy

| State | What changes |
|---|---|
| **Set, checked** (the picture) | as above |
| **No registry** (a fresh install) | the Address inputs empty with placeholders `registry.example.com` and `ostra/`; both credential rows `Not set` with `Add`; the Check row reads `Save a registry to check it.` and the button is disabled; Pools that need it lists `kubernetes` pools in `--red` (above); Snapshots shows its empty row. The panel's `Status` · `Not set` in `--faint`. `Save` enables once the address is filled |
| **Editing** | `Save` enabled, and nothing else: the button's state is the cue. Leaving the page with unsaved changes asks the browser's leave prompt |
| **Invalid address or prefix** | the input gets a `--red` border and, under its row, 12px `--red`: `A host and optional port, like registry.acme.dev or localhost:5000.` / `Lowercase letters, digits, ., _, - and /, ending in /.` `Save` disabled |
| **Saving** | `Save` reads `Saving…`, disabled. On success, 12.5px `--muted` under the Credentials section, `role="status"`, Lucide `check`: `Saved. Checking the registry…`; the Check row shows `Checking…` |
| **Save failed** | above the Address section, `role="alert"`, 12.5px `--red`: `errorText(error)`. The typed credential fields keep their values so nothing is typed twice |
| **Cluster's own identity** | the Pull credential row is hidden; the panel's `Auth` reads `Cluster identity`; a 12px `--faint` line under the radio: `docker pools still pull with the push credential.` (open point 1) |
| **Pull only** / **Refused** | the Check row's copy (above); the panel's dot follows. No banner elsewhere: the pools' tasks carry their own waiting line (`m1/task`) |
| **Remove registry** | `AlertDialog`: title `Remove the registry?`, body `kubernetes pools stop starting boxes until another is set: k8s-east. docker pools build their own snapshots again. Images already pushed stay in registry.acme.dev; ostra forgets both credentials.` (the `kubernetes` pools by name); buttons `Cancel` and `Remove` (destructive). Calls `registry.clear` |
| **Loading** | title and lede at once; the inputs and credential rows as `Skeleton` bars; the snapshots table three 40px skeleton rows; the panel's values skeleton bars |
| **Load failed** | the error alert in place of the sections |
| **Not an organization admin** | `AdminOnly`; the page isn't in their sidebar |
| **Narrow (below 1280px)** | the panel drops under the page (`PageFrame`). Below 640px the key column shrinks to 140px, the inputs go full width, the radio options stack, and the Snapshots table keeps Project, Snapshot and Pushed, with Digest and Built on as a second line under each row |

The demo data in the image (fixtures, not real): `registry.acme.dev` with the prefix `ostra/`; the pools `k8s-east` (`kubernetes`) and `build-fleet` (`docker`); the runners `build-01` and `build-02`; four snapshots with made-up IDs and digests. The real demo (spec step 13) uses `pnpm dev:registry`'s address and the prefix `ostra-dev/`, and its check answers `Push and pull both allowed for ostra-dev/`.

## Components (shadcn/ui names)

`Sidebar` (plus Registry), `PageFrame` with `Breadcrumb` and `properties`, `PageHeading`, `Section`, `Input` (address, prefix, the credential form), `Label`, `RadioGroup` / `RadioGroupItem`, `Button` (default = the Shell primary; `outline` Replace, Add and Check; `ghost` Cancel, Remove registry and copy), `Badge` outline (executors), `Table` and its parts, `Tooltip` (digest, the disabled Check), `AlertDialog` (remove), `Skeleton`, `PropGroup` / `PropRow`, `Separator`, the `Status` dot (`ui/status.tsx`). Lucide 15px, stroke 1.75: `container`, `check`, `refresh-cw`, `circle-check`, `circle-alert`, `circle-x`, `copy`, `arrow-right`, `loader`.

## Tokens (`app-concepts/html/graphite.css`)

> **Scale.** The sizes and colours below are `graphite.css`'s. The panel is built at the approved pictures' scale, which wins on size, spacing and contrast: body 14.5px, dense rows 14px, secondary 13px, small 12px, title 26px, `--muted` `#B4B7BB`, `--faint` `#8B8E93`, buttons 30px, a 46px top bar and a 320px properties panel (380px with a form). The measured values are in `../m1/README.md`, "Scale".

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | page, panel, the selected radio's centre |
| `--side` | `#0A0B0C` | sidebar |
| `--surface` | `#131416` | inputs, skeletons, the destructive button's fill |
| `--sel` | `#1A1B1E` | the selected Registry row |
| `--line` | `#1F2023` | row hairlines, panel edge, group lines |
| `--line-2` | `#2A2C30` | input, radio and outline-button borders, executor badges |
| `--text` | `#EDEDEE` | values, `Set`, pool names, snapshot IDs, the check's result |
| `--muted` | `#9A9DA3` | keys, lede, notes, `Built on`, the pull-only result's icon |
| `--faint` | `#64676D` | help, meta, digests, ages, table heads |
| `--green` | `#4FB286` | the passing check's icon, the `Status` dot (halo `rgba(79,178,134,0.15)`), always with its words |
| `--red` | `#E5675C` | a refused or unreachable check, a `kubernetes` pool with no registry, invalid fields, errors |
| `--teal` | `#6FB8AA` | `Audit log →` |
| `--amber` | `#FFB224` | only the sidebar's Needs you count. Nothing on this page is amber |
| `--shell` / `--ink` | `#F3F0E8` / `#0C1D21` | `Save` |

Type: Manrope 700 24px (title); IBM Plex Sans 13px body, 12.5px secondary, 11px panel labels, 600 section titles, 500 buttons and pool names; IBM Plex Mono for the address, prefix, image name, executors, snapshot IDs, digests, counts and ages.

## Data this screen needs beyond ticket 28

Ticket 28's `registry.get` returns the address, prefix, auth kind, whether each credential is set, the last check's result and time, the pools that need it and the snapshots. The picture also shows these; add them there or drop the row:

- **Who set each credential, and when** (from the audit log's `registry.set` entries, or `updatedByMemberId` and a time per credential).
- **The snapshot's runner name and builder** (ticket 28 returns the builder and the runner for the environment's section; the list needs the same per row).
- **The day's credential issuances by kind** for the panel, from `registry.credential-issued` audit entries.
- **The last change**, from `audit.list` filtered to `registry.*`, limit 1.

## Open points (the build takes the recommendation and records it in ticket 33's `## Comments`)

1. **What pulls with when no pull credential is set, or when pulls use the cluster's identity, on a `docker` pool.** ADR 0060 doesn't say. Recommended: a `docker` runner pulls with the push credential in both cases (it has no cluster identity), and the page says so (the two help lines above). Ticket 17 would issue the push credential for pulls then, still to the lease holder only.
2. **Whether "Check" is allowed with unsaved changes.** Recommended: no, as above: the check is a job over the saved settings (ticket 17), and checking typed-but-unsaved credentials would send them somewhere before they're kept.
3. **Pruning old snapshots.** Nothing in milestone 5 deletes an image from the registry. Recommended: the page says nothing about pruning until a ticket adds it.

## Differences from the current code

Checked against `apps/web` on `main` (2026-11-19):

1. **New route and view.** Nothing exists: add `organization/registry/page.tsx` and its view (ticket 33's path).
2. **Sidebar.** `components/shell/sidebar.tsx` gains Registry (`container`) for organization admins, after Box sizes.
3. **No credential value in the page.** Ticket 33's Playwright check reads the page's HTML for every credential's value; the form never receives one, and the `password` input is cleared after a save.
4. **Messages.** New keys under `registry.*` in `messages/en.json`, the check's results among them (never the server's text, except the registry's own error message inside `Refused: …`).

## Wrong in the image

Build the copy and details in this file, not these:

- **The sidebar** is about 236px and the panel about 395px. Build 232px and 300px. The sidebar's Organization rows and icons come from the shell, not the picture; Box sizes' icon is `m5/box-sizes`'.
- **The pool names** under Pools that need it are drawn in mono. They're Plex Sans 500, as everywhere pools are named.
- **The section gaps** are about 20px. They're 28px, as `m2/storage-settings`' sections.
- **The panel's values** start about 140px right of the keys' left edge; the key column is 104px.
- **The `Remove registry` button** and the credential form aren't drawn: they're described above.
- **The logo** approximates the Hinge mark. Use `kit/logo/export/ostra-hinge-single-color.svg`, 20px.
- The picture has no empty, editing, invalid, saving, failed, pull-only, refused, cluster-identity, remove, loading or narrow states: they're in the table above.

All visible copy in the image is spelled right.
