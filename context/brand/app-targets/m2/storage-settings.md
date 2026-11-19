# Target: storage and retention (milestone 2, screen 10)

> **Committed image:** `storage-settings.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel.

- **Prompt:** `storage-settings.prompt.txt`. GPT Image 2.6 through Higgsfield, 1 generation. References: `app-targets/m1/models.png` (the closest approved organization page), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`.
- **Route (new):** `apps/web/src/app/(panel)/organization/storage/page.tsx` → `components/organization/storage-view.tsx`.
- **Features:** F-114 (blob storage), F-079 (cleanup and retention). Spec section 12, screen 10. Ticket 31 (`organization.storage`, `instance.saveRetention`), ticket 37 (this screen), ticket 20 (`retention.sweep`), tickets 11 and 12 (the stores).
- **Status:** a proposed target, waiting on the maintainer's approval (ticket 32's `## Comments`). Ticket 37 builds its data and tests until then, not its UI.

> Build it in real HTML/React (app-design.md, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

An instance admin sees where ostra keeps its files (session archives, ticket images, attachments), how much is there, and how to move to an S3-compatible store. They also set how long a finished task keeps its history. Retention is off by default: everything stays while its task exists (F-079, spec section 11, choice 11). Turning it on deletes data every night, so the page says exactly what goes and what stays, and asks once more before saving.

The picture shows the built-in store with demo figures, and the admin about to turn retention on at 90 days, before they press `Save retention`.

## Layout (CSS px at 1440 wide)

| Region | Size | Contents |
|---|---|---|
| Sidebar | 232px, `--side`, 1px `--line` on its right | the shared sidebar. Organization: Runners, Models, GitHub, Linear (screen 1), **Storage** (Lucide `hard-drive`, selected, `--sel`). Build it from `components/shell/sidebar.tsx`, not from the picture |
| Top bar | 44px, 1px `--line` below | breadcrumb `Acme Corp › Storage`; on the right the page's one primary button, `Save retention`, disabled until the retention choice differs from the saved one |
| Page | `1fr`, padding `28px 40px`, content max 720px | title, lede, Blob store, Retention |
| Properties panel | **300px** (the default width: no form in it), 1px `--line` on its left, padding `20px 18px` | Configuration, Sweeps, Last change |

The picture draws the sidebar at about 236px and the panel at about 397px. Build 232px and 300px.

### Heading

- Title `Storage`, Manrope 700 24px, letter-spacing −0.015em. No eyebrow.
- Lede, 13.5px `--muted`, one line: `Where ostra keeps files, and how long it keeps a finished task's history.`

### Blob store

1. **Title line** (`Section`): `Blob store`, inline note `session archives, ticket images and attachments` (12.5px `--muted`).
2. **Key/value rows,** no box: 40px rows, a 1px `--line` hairline above each and under the last; key column 180px, 13px `--muted`; value 13px `--text`.

| Key | Value (the picture) | Notes |
|---|---|---|
| `Store in use` | `Built-in, in Postgres` · at the right a 7px `--green` dot with its halo and `Healthy` | with S3: `S3-compatible`. Health from the store's `health()` (see "Data this screen needs") |
| `Blobs` | `1,284` | Plex Mono 12.5px; this organization's blobs only (ticket 31) |
| `Total size` | `2.31 GiB` | Plex Mono; binary units, two decimals over 1 GiB, whole numbers under (`812 MiB`) |
| `Largest blob allowed` | `64 MiB`, then `OSTRA_BLOB_MAX_MIB` in Plex Mono 11.5px `--faint` | the per-blob cap. Over it, a session archive isn't stored and the next reopen uses the rebuild template |
| `S3-compatible store` | `Not configured` in `--muted` | configured and in use: `Configured, in use`; configured but `OSTRA_BLOB_STORE=postgres`: `Configured, not in use` |

3. **Help,** 10px under the rows, 12.5px `--faint`, max 720px: `To move new blobs to an S3-compatible store, set OSTRA_BLOB_STORE=s3 and its five OSTRA_S3_ settings, then restart. Blobs already stored stay readable where they are.` The setting names in Plex Mono. Then a teal link, no underline, `Configuration reference` with Lucide `arrow-up-right` 12px, to `docs/configuration.md` on the docs site. The store is chosen by a setting, never from the panel (ADR 0043: "the adapter makes the move a setting"), so this section has no controls.

### Retention

1. **Title** `Retention` (600 13px), 32px above. Under it, 13px `--muted`: `How long a finished task keeps its history, archives and blobs.`
2. **`RadioGroup`,** 32px rows, 16px radios (`--line-2` ring; selected: `--text` fill, `--bg` centre), 10px before the label (13px `--text`):
   - `As long as the task exists`, then ` default` in `--faint`
   - `Delete after` [a Plex Mono `Input`, 72×28px, `--surface`, 1px `--line-2`, 7px radius, `90`] `days after the task finishes`. The input is enabled only with this radio selected; a whole number from 1 to 3650.
3. **What will be deleted,** shown only while `Delete after` is selected: 10px down, aligned with the radio labels (26px in), a 2px `--line-2` left rule (never amber: nothing waits on the member yet), 12px left padding, 12.5px `--muted`, line height 20px:
   - `On save, every night ostra deletes these for tasks finished more than 90 days ago:`
   - `events and messages, live text, session archives, ticket images and attachments.`
   - `The task, its repos and its pull request links stay. A reopened task says its history was removed.`

   The number follows the input as it changes. This is ticket 20's list: events, live-text rows, session archives and task blobs; the task row, its task repos and an audit entry stay.
4. **Footnote,** 14px down, 12px `--faint`: `Changes are recorded in the audit log.`

### Properties panel

`PropGroup`s with an 11px 500 `--faint` label, 30px `PropRow`s, 12.5px. This panel needs a **150px key column** (the default 96px can't hold `OSTRA_RETENTION_DAYS`): add a `labelWidth` to `PropRow` rather than a second component.

1. **Configuration:** keys in Plex Mono 12px `--muted`, values in Plex Mono `--text` (`unset` in `--faint`):
   - `OSTRA_BLOB_STORE` · `postgres`
   - `OSTRA_BLOB_MAX_MIB` · `64`
   - `OSTRA_RETENTION_DAYS` · `unset`
2. **Sweeps:** `Retention` · `daily` (sans, not the picture's mono time); `Last ran` · `never` in `--faint`, or a relative time (`6h ago`); `Unfinished uploads` · `deleted after 24 h` (sans).
3. **Last change:** one line, 12.5px `--muted`: `Never changed. Retention is off by default.` Once changed: `Set to 90 days by Alex Kim, 12 Nov` (or `Turned off by …`), from the latest audit entry.

## States and copy

| State | What changes |
|---|---|
| Loading | the rows' values and the panel's values are `Skeleton` bars (80–120px); the radio group is disabled |
| Retention off (the default, saved) | `As long as the task exists` selected; no deletion block; `Save retention` disabled |
| Retention edited (the picture) | `Delete after` selected with a value; the deletion block; `Save retention` enabled |
| Invalid days | the input gets a `--red` border and, under the radio row, 12px `--red`: `A whole number of days, from 1 to 3650.` `Save retention` disabled |
| Confirming | `Save retention` opens an `AlertDialog`. Turning on or shortening: title `Delete history after 90 days?`, body the deletion block's three lines, then `The first sweep runs tonight.`; buttons `Cancel` and `Delete after 90 days` (primary). Turning off: title `Keep history while tasks exist?`, body `Nothing more is deleted. What earlier sweeps deleted stays deleted.`; buttons `Cancel` and `Keep history` |
| Saving | the dialog's button reads `Saving…`, disabled |
| Saved | the dialog closes; under the footnote, `role="status"`, 12.5px `--green` with `check`: `Saved.`; Last change updates |
| Save failed | in the dialog, above its buttons, `role="alert"`, 12.5px `--red`: the error text (`errorText`) |
| Set by the setting | `OSTRA_RETENTION_DAYS` is set and the panel has never saved one: the radio shows its value, and under the radio group, 12px `--faint`: `From OSTRA_RETENTION_DAYS. Saving here overrides it.` |
| S3 in use | `Store in use` reads `S3-compatible`; `S3-compatible store` reads `Configured, in use`; the help becomes `Blobs stored in Postgres before the switch stay readable from there.`; Configuration shows `OSTRA_BLOB_STORE` · `s3` |
| Store unhealthy | the dot is `--red` and the word reads `Unreachable`, with the store's error under the rows in 12.5px `--red`, `role="alert"`. Never amber |
| No blobs yet | `Blobs` · `0`, `Total size` · `0 B`. No empty-state art: the rows are the page |
| Load failed | the error alert in place of both sections |
| Not an instance admin | `AdminOnly` (the page isn't in their sidebar either) |
| Narrow (below 1280px) | the panel drops under the page (`PageFrame`); below 640px the key column shrinks to 140px and the `OSTRA_BLOB_MAX_MIB` hint wraps under its value |

## Components (shadcn/ui names)

`Sidebar` (existing, plus Linear and Storage rows), `PageFrame` with `Breadcrumb` and `properties`, `PageHeading`, `Section`, `PropGroup` / `PropRow` (with the new `labelWidth`), `Button` (default = the Shell primary), `RadioGroup` / `RadioGroupItem` (new), `Input`, `Label`, `AlertDialog` (new), `Skeleton` (new), the panel's `Status` dot (`ui/status.tsx`). Lucide 15px, stroke 1.75: `hard-drive`, `arrow-up-right`, `check`.

## Tokens (`app-concepts/html/graphite.css`)

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | page, panel, the selected radio's centre |
| `--side` | `#0A0B0C` | sidebar |
| `--surface` | `#131416` | the days input, skeletons |
| `--line` | `#1F2023` | row hairlines, panel edge, group lines |
| `--line-2` | `#2A2C30` | input and radio borders, the deletion block's left rule |
| `--text` | `#EDEDEE` | values, radio labels, the selected radio |
| `--muted` | `#9A9DA3` | keys, lede, the deletion block |
| `--faint` | `#64676D` | help, hints, `default`, `unset`, the footnote |
| `--sel` | `#1A1B1E` | the selected Storage row |
| `--green` | `#4FB286` | `Healthy` dot (halo `rgba(79,178,134,0.15)`), `Saved.` |
| `--red` | `#E5675C` | unreachable store, invalid days, errors |
| `--teal` | `#6FB8AA` | `Configuration reference` |
| `--amber` | `#FFB224` | only the sidebar's Needs you count. Nothing on this page is amber |
| `--shell` / `--ink` | `#F3F0E8` / `#0C1D21` | `Save retention`, the dialog's confirm button |

Type: Manrope 700 24px (title); IBM Plex Sans 13px body, 12.5px secondary, 11px panel labels, 600 for section titles, 500 for buttons; IBM Plex Mono for counts, sizes, the days input and setting names.

## Data this screen needs beyond ticket 31

Ticket 31's `organization.storage` returns the store in use, the blob count, the total size, the cap and whether S3 is configured. The picture also shows these; add them to that query (ticket 31) or drop the row:

- **Health** of the store in use, from `BlobStoreAdapter.health()`.
- **The retention source:** the saved instance setting, `OSTRA_RETENTION_DAYS`, or neither. Ticket 20 reads "`OSTRA_RETENTION_DAYS` (or the instance setting)"; this screen assumes the saved setting wins over the env value. The lead should confirm that with the maintainer.
- **The sweep's last run** (from the `retention.sweep` job) and **the last retention audit entry** for the panel.

## Differences from the current code

Checked against `apps/web` on `main` (2026-11-19):

1. **New route and view.** Nothing exists: add `organization/storage/page.tsx` and its view (ticket 37 names `src/app/(panel)/organization/storage/`).
2. **Sidebar.** `components/shell/sidebar.tsx` lists Runners, Models and GitHub. Add Storage (`hard-drive`) for instance admins, after Linear (screen 1).
3. **`PropRow`** has a fixed 96px key column; add `labelWidth`.
4. **New UI pieces:** `RadioGroup`, `AlertDialog` and `Skeleton` aren't in `components/ui/` yet. `radix-ui` is already a dependency.
5. **`AdminOnly`** says "an admin of the organization". If instance admin differs from organization admin by milestone 2, it needs an instance wording; until then it's the same person.
6. **Messages.** New keys under `storage.*` in `messages/en.json`.

## Wrong in the image

Build the copy and details in this file, not these:

- The sidebar is about 236px and the panel about 397px. Build 232px and 300px.
- The Blob store rows are about 35px. They're 40px.
- The Sweeps values are drawn in mono (`daily, 03:00`, `deleted after 24 h`). They're sans, and the schedule reads `daily`: no time is set anywhere.
- The Configuration keys use a wider column than the other groups' keys. One 150px key column for every group of this panel.
- The Linear row's icon is a two-column glyph. Use the icon screen 1 settles on.
- The `Delete after` input is 90px wide and the radio rows are about 36px. Build 72px and 32px.
- The picture has no loading, confirming, saved, S3, unhealthy or read-only states: they're in the table above.

All visible copy in the image is spelled right.
