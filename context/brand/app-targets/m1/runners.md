# Runners: target

> **Committed image:** `runners.webp`, downscaled from the 2048×1360 generation to 1440 px wide, so one image pixel is one CSS pixel. Where this file gives sizes in image px at ×1.42, read them as CSS px directly against the WebP.

Organization › Runners (F-013, F-014, F-091, F-092): where tasks run. Picture:
- `runners.webp` (2048×1360, the 1440×956 CSS frame at about 1.42×): an **admin** with two pools, seven pool runners in every state, their own personal runner, and a join token **just made** (shown once).

Prompt: `runners.prompt.txt` (the third and final one; it edits the second render). Made with the `ui-taste` skill, image first, on Higgsfield `gpt_image_2_6` (3:2, 2k, high), from the graphite concepts (`../../app-concepts/html/runner-pools-graphite.png`, `home-graphite.png`, `task-b-graphite.png`) and the Hinge logo. Three generations.

**Status:** a target, not yet approved by the maintainer. The picture is an image-model render: the copy and rules in this file win over the pixels, and the tokens below win over the picture's colours.

## Purpose

The page answers, in this order:
1. Where do tasks run, and is there room? (the lede: runners online, boxes busy)
2. Which pools exist, how full are they, and how do new runners join them? (Pools, the properties panel's join tokens)
3. Which runner is in which state? (Runners)
4. Is my own machine connected, and how do I connect one? (Your machine, the command)

Two audiences, one page:
- **Admin:** everything in the picture.
- **Member who isn't an admin:** only the heading, **Your machine** and the connect command. No properties panel (`content.full`), no **New pool**. The lede becomes the member version (below).

## Layout (1440 px wide, the concepts' frame)

| Region | Size | Contents |
|---|---|---|
| Sidebar | 232px, `--side`, right hairline | The shared sidebar; **Runners** (Lucide `server`) selected, with the busy-box count in the plain count style (`7`), never amber |
| Top bar | 44px, bottom hairline | Breadcrumbs `Acme Corp › Runners`. Right, admins only: one primary (Shell) button `New pool` with Lucide `plus` |
| Page | `1fr`, padding `28px 40px` | `h1`, lede, then the sections **Pools**, **Runners**, **Your machine**, 26px apart |
| Properties panel | 300px, left hairline, padding `20px 18px` | The selected pool: properties, then its join tokens |

No cards. Each section is a `.shead` line (Plex Sans 600, 13px, `--text`, then a faint mono count) and hairline rows. The only boxes are the two code boxes (the command, the token shown once) and the selected pool row's `--sel` fill. At `< xl` the properties panel stacks under the page, as `PageFrame` does already; at phone width the two tables scroll sideways inside their section (the page itself never does), and the pool table keeps Pool, Runners and Busy visible first.

### Heading
- `h1` (Manrope 700, 24px): `Runners`
- Lede (`.lede`, 13.5px, `--muted`):
  - admin: `Where tasks run. {online} of {total} runners online, {busy} of {slots} boxes busy, across {pools} pools and your machine.` Picture: `4 of 8 runners online, 7 of 14 boxes busy, across 2 pools and your machine.` Without a personal runner, the tail is `across {pools} pools.` With one pool, `pool`.
  - member: `Where tasks run. Your machine runs the tasks you send to it.`
- `{slots}` is the summed capacity of runners that are `online` or `draining`; `{busy}` is the boxes in use on them.

## States and copy

### Pools (admin)
`table.t`, header row in faint 11.5px. Columns: **Pool**, **Executor**, **Runners**, **Busy**, **Join tokens**, **Projects**, **Version**.

| Cell | Picture (`build-fleet`, `mac-minis`) | Rule |
|---|---|---|
| Pool | `build-fleet` + chip `default`; `mac-minis` + chip `not isolated` | Name in Plex Sans 500. Chip `default` when `isDefault`. Chip `not isolated` when the pool runs the `host` executor (F-015, F-092). Both chips grey (`.chip`), never amber |
| Executor | `docker`, `host` | Mono. The executors of its runners, joined with `, ` when mixed; `—` with no runner |
| Runners | `2 / 5 online`, `1 / 2 online` | `t("runners.onlineCount")` |
| Busy | meter + `6 / 12`, meter + `1 / 1` | `.meter` (96px, 4px, `--muted` fill on `--line-2`), then mono `busy / slots`. `—` with no slot |
| Join tokens | `2 active`, `1 active` | `activeJoinTokens` + ` active`; `none` in `--faint` at 0 |
| Projects | `3`, `1` | Mono, right side of its column |
| Version | `v0.4.2` | Mono. A range `v0.4.1–v0.4.2` when its runners differ |

- A row is a button: clicking (or Enter on focus) selects the pool for the properties panel. The selected row has the `--sel` fill and `aria-selected`. With nothing picked, the default pool is selected.
- Empty (no pool): one row, `--muted`: `No pools yet. A pool runs tasks on your servers; add one with New pool.`

### Runners (admin)
`.shead`: `Runners` + count; at the right a quiet filter `All pools` with Lucide `chevron-down` (a `DropdownMenu`: All pools, each pool, Personal). Rows are 38px, hairlines between, the same columns in every row:

| Column | Picture | Rule |
|---|---|---|
| State | dot + word | `online`: green `.dot.green`. `draining`: a half-filled grey dot. `joining`: a hollow grey ring. `offline`: `.dot.grey`. `revoked` runners are not listed. The word is always there; colour never stands alone |
| Name | `build-01` | Mono, `--text` |
| Pool | `build-fleet` | `--muted`. A personal runner shows `personal` and the owner's name, `personal · Sam Rivera`, plus the chip `not isolated` |
| Executor | `docker`, `host` | Mono, `--text` |
| Busy | `3 / 4 busy` | Mono, `--muted`. `—` when joining or offline |
| Version | `v0.4.2` | Mono, `--muted` |
| Age (right-aligned) | `just now`, `seen 3h ago`, `seen 2d ago` | `--muted`. Empty while online; `seen {age} ago` when offline (from `lastSeenAt`); `just now` while joining |

Picture rows: `build-01` online 3/4, `build-02` online 2/4, `build-03` draining 1/4, `build-04` joining, `build-05` offline `v0.4.1` seen 3h ago, `mini-01` online 1/1 (`mac-minis`, `host`), `mini-02` offline seen 2d ago.

- Empty: `No runner has joined yet. Start one with a join token from a pool.`
- The admin's own personal runner is listed under **Your machine**, not here; other members' personal runners are listed here.

### Your machine (everyone)
`.shead`: `Your machine` + count. The member's own personal runners, as rows with **the same columns as Runners**: picture `online · alex-mbp · personal [not isolated] · host · 0 / 1 busy · v0.4.2`.

Under the rows:
1. `--muted` 12.5px: `Connect another machine: run this in a clone of ostra, then approve the code it prints.` With no runner yet: `Connect your machine: run this in a clone of ostra, then approve the code it prints.`
2. A code box (`.code`, one line): mono `pnpm ostra runner --server {corePublicUrl}`, with a teal `Copy` text button at its right end (`Copied` for 1.5s).
3. `--faint` 12px with Lucide `shield` (13px): `Personal runners use the host executor: the agent runs as a process on your machine, not isolated.` On Windows, append ` A process the agent detaches isn't contained.` (F-014, Q126).

- Empty (no runner): no row; the section count is `0` and line 1 uses its "Connect your machine" form.
- The list polls every 2s until a runner is online, then every 15s (as today). When a new runner comes online the row appears; no toast.

### Properties panel: the selected pool (admin)
A faint 11px label with the pool's name (`build-fleet`), then `.row2` key/value rows (key `--muted`, value `--text`):

| Key | Picture | Rule |
|---|---|---|
| Executor | `docker` | Mono |
| Runners | `2 / 5 online` | Mono numbers |
| Busy | `6 / 12 boxes` | Mono numbers |
| Projects | `calculator, +2` | Plex Sans (not mono): the first project's name, then `+N` |
| Approval | `Not required` | `Required for each new runner` when `requiresApproval` |
| Max boxes | `No limit` | Or the number, mono |

A `.sep`, then the join tokens:
- Label row: `Join tokens` + faint count of active tokens, and at its right a small secondary button `New token` (`Button size="sm"`, Lucide `plus`).
- **Just made (shown once):** a code box holding the **full** token in mono, wrapping (`break-all`), selectable, with a teal `Copy` at the right; under it `--muted` 12px: `Shown once. Stored only as a hash.` It stays until the pool changes or the page reloads; it is never fetched again. Not amber.
- Token rows (hairlines between): the label (`Join token` when it has none) in `--text`, under it faint mono `expires {date} · used {age} ago` (`never expires`, `never used` as they apply), and a `--muted` ghost `Revoke` at the right. A revoked token: label struck through in `--faint`, under it `revoked {date}`, no button.
- Picture rows: `ci-bootstrap` (expires 2026-12-19, never used: it's the one just made), `bootstrap` (never expires · used 20m ago), `laptop-test` (revoked 18 Nov).
- Revoke asks first: an `AlertDialog`, title `Revoke this join token?`, body `Runners that already joined stay connected. No new runner can join with it.`, buttons `Cancel` and `Revoke` (destructive, `--red` text on `--surface`).
- Errors (create, revoke): one `--red` line under the label row, `role="alert"`, from `errorText()`.

### New pool (admin)
`New pool` opens a `Sheet` from the right (340px, the properties width for a form): fields **Name** (required, ≤64), **Require approval for each new runner** (`Switch`, off), **Max boxes** (number, empty = no limit). Buttons `Cancel` and primary `Create pool`. On success the sheet closes and the new pool is selected. A name clash shows under the field: `A pool with that name exists.`

### Loading
Rows render as 38px hairline rows with a `--surface` bar where each value goes (no spinners); the heading and lede wait for the first answer.

## Components (shadcn/ui names)

| Part | Component |
|---|---|
| Frame, breadcrumbs, heading, sections | the existing `PageFrame`, `PageHeading`, `Section` |
| New pool, New token, Revoke, Copy | `Button` (`variant="primary"` for New pool; `size="sm"` secondary for New token; `variant="ghost"` for Revoke; Copy as a teal link-style `Button variant="link"`) |
| Pools | `Table`, `TableHeader`, `TableRow` (selectable, `data-state="selected"`), `TableCell` |
| Runners, Your machine | `Table` with the same column template, or `.rows` with a shared CSS grid, so columns line up across both sections |
| State | the existing `Status` (dot + label), extended with `draining` (half dot) and `joining` (ring) |
| default, not isolated, personal | the existing `Chip` (shadcn `Badge variant="outline"`) |
| Busy | `Progress` styled as `.meter` |
| Pool filter | `DropdownMenu` |
| Command, shown-once token | the existing `Code` |
| Properties | the properties panel slot of `PageFrame`, `Separator` between groups |
| Revoke confirm | `AlertDialog` |
| New pool | `Sheet`, `Field`, `Input`, `Switch` |
| Loading | `Skeleton` |

## Tokens (from `../../app-concepts/html/graphite.css`)

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | page |
| `--side` | `#0A0B0C` | sidebar |
| `--surface` | `#131416` | code boxes, skeleton bars |
| `--sel` | `#1A1B1E` | selected pool row, selected nav row |
| `--line` | `#1F2023` | hairlines, code box borders |
| `--line-2` | `#2A2C30` | button and chip borders, meter track |
| `--text` / `--muted` / `--faint` | `#EDEDEE` / `#9A9DA3` / `#64676D` | text tiers |
| `--green` | `#4FB286` | the `online` dot only |
| `--teal` | `#6FB8AA` | `Copy` |
| `--red` | `#E5675C` | errors, the destructive Revoke in the dialog |
| `--shell` / `--ink` | `#F3F0E8` / `#0C1D21` | the `New pool` button |
| `--amber` | `#FFB224` | **nowhere on this page** (only the sidebar's Needs you badge) |

Type: `h1` Manrope 700 24px; body Plex Sans 13px; section titles Plex Sans 600 13px; table headers 500 11.5px `--faint`; lede 13.5px; mono (names, executors, numbers, versions, tokens, the command) Plex Mono 12.5–13px. Rows 38px (runners) and 40px (pools, `table.t td`). Icons Lucide 15px, stroke 1.75.

## Differences from the current code

`apps/web/src/components/runners/runners-view.tsx` and `page.tsx`:

1. **Order and grouping.** Today: Connect, Your runners, Pools, Every runner. Target: Pools, Runners, Your machine (with the command under it). Members see only Your machine.
2. **Amber is gone from the page.** Today the host warning, `not isolated` chips, the `draining` dot and the "shown once" line are amber. Target: the warning is a faint line with a shield icon, the chips are grey, `draining` is a grey half dot, "shown once" is muted.
3. **Pools become a table** with Executor, Runners, Busy (meter), Join tokens, Projects and Version, and a selectable row. Today: a name, a `default` chip and `n / m online`.
4. **Join tokens move to the properties panel** of the selected pool, with label, expiry, last use and revoked state. Today they're indented under every pool, show only label and expiry, and list revoked tokens with a live Revoke button.
5. **Revoke asks first** (`AlertDialog`). Today it fires on click.
6. **The shown-once token** shows in full in a code box in the panel with "Shown once. Stored only as a hash." Today: an amber sentence over a code box in the pool row.
7. **A properties panel** exists; today the page has none.
8. **New pool** (top bar + `Sheet`), on `pools.create`, which the API has and the page doesn't use.
9. **Runner rows are a column grid** (state, name, pool or owner, executor, busy, version, age) instead of a wrapping line of chips; state comes first, as a dot and a word. The `personal`/`pool` and executor chips go; `not isolated` stays as the one chip.
10. **The lede counts** runners online and boxes busy instead of the fixed sentence `runners.lede`.
11. **New copy keys** for every string above that isn't in `messages/en.json` (`runners.*`); `runners.hostWarning`, `connectBody` and `connectAfter` are replaced by the shorter lines here. `connectAfter`'s point (the runner makes its own key pair and the sign-in is revoked) moves to the docs.
12. **Data the API doesn't return yet** (add to the routers, typed end to end):
    - busy boxes per runner and per pool (`runners.list`, `runners.mine`, `pools.list`): F-092
    - executor and version range per pool (`pools.list`)
    - `lastUsedAt` and `revokedAt` are returned by `pools.joinTokens` already but not shown
    - the first project's name for `calculator, +2` (`pools.list` returns only `projectCount`)
    - `draining` has no action yet: Drain and Revoke a runner are F-092's, milestone 5. Until then the page shows the state only, with no row actions.

## Text in the picture that's wrong

- **Your machine row:** its columns don't line up with the Runners rows above it (`alex-mbp` sits left of the names column, `personal` is wider). Build it on the same grid.
- **Properties values** `docker`, `2 / 5 online`, `6 / 12 boxes` and `calculator, +2` are rendered in mono while `Not required` and `No limit` are in sans. Use mono for `docker` and the numbers only; `calculator, +2`, `Not required`, `No limit` are Plex Sans.
- **Shown-once token:** the picture shows `ostra-join-q7Hc2x…9fLm`, truncated. Show the full token, wrapped (`ostra-join-` + 43 base64url characters).
- **`ci-bootstrap`** reads `used 2h ago`; it's the token just made, so `expires 2026-12-19 · never used`.
- **The section count** after `Join tokens` (`2`) sits far from its label; put it right after the label, like the section counts.
- **Sidebar:** `Needs you` and `My tasks` aren't in milestone 1's sidebar, and the logo is the model's approximation. The sidebar is the shell's own target; use the real Hinge SVG.
- **Section titles** in the picture are close but slightly larger than 13px; the rule is Plex Sans 600, 13px.
- Everything else (headings, table headers, row values, `New pool`, `New token`, `Revoke`, the command, the shield line, `Connect another machine…`) is spelled right.
