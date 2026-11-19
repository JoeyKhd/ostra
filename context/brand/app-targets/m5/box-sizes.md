# Target: Box sizes (milestone 5, screen 6)

> **Committed image:** `box-sizes.webp`, downscaled from a 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

- **Prompt:** `box-sizes.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 1 generation, kept. References: the approved milestone 2 original `app-targets/m2/storage-settings.png` (the screen this one starts from, spec section 12), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`.
- **Route (new):** `apps/web/src/app/(panel)/organization/box-sizes/page.tsx` → `components/organization/box-sizes-view.tsx`.
- **Features:** F-095 (box sizes: three named sizes per organization, a project's default, `docker` and `kubernetes` enforce a size as a limit, `host` counts slots). ADR 0059 (capacity and sizes); spec sections 3 (step 5), 5.1 (`dispatch.box.size`, minor 4), 5.3 (`BoxSize`), 5.4 (`runnerRoom`, `fits`). Tickets 04 (`BoxSize` and its defaults), 05, 27 (`boxSizes.list`, `boxSizes.update`), 32 (this screen).
- **Status:** a proposed target, waiting on approval (ticket 29's `## Comments`). Ticket 32 builds its data and tests until then, not its UI.

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

An organization admin sets how much CPU and memory each of the three box sizes gets, sees which projects use each as their default and how many boxes of each run now, and learns where a size is a hard limit (`docker`, `kubernetes`) and where it isn't (`host`, which counts slots only, and a runner one minor behind). A size is picked per project, never per task (spec 1, "Not in"); a project's default is set on its Runners tab (`project-runners`), and this page links there.

`box-sizes.webp` shows the demo's step 5 mid-edit: small 2 vCPU · 4 GiB, medium 4 · 8, and large being raised from 16 to 32 GiB, before `Save sizes`. No runner offers 32 GiB yet, and the page says so.

Only organization admins edit. A member sees the page read-only (the inputs as plain mono values, no `Save sizes`): knowing what a box gets is useful to anyone writing an environment.

## Layout (CSS px at 1440 wide)

| Region | Size | Contents |
|---|---|---|
| Sidebar | 234px, the shared shell | Build it from `components/shell/sidebar.tsx`. Organization gains **Box sizes** (Lucide `box`), after Runners, selected here |
| Top bar | 46px, hairline under | Breadcrumb `Acme Corp › Box sizes`. Right: the page's one primary button **Save sizes** (Shell fill, Ink text, 600, 30px), disabled until a value changes and every value is valid. Admins only |
| Page | `1fr`, padding `28px 36px`, content max 760px | Title, lede, Sizes, the room warning, the `host` note, the footnote |
| Properties panel | **320px**, 1px `--line` on its left, padding `20px 18px` | Where sizes apply, Runners, Bounds, Last change |

### Heading

- Title **Box sizes** (`PageHeading`).
- Lede, `text-lede` `--muted`, two lines, max-width 720px: `The CPU and memory a task's box gets on docker and kubernetes runners, enforced as limits. Every task gets its project's default size.`

### Sizes

Section head 28px under the lede: **Sizes** (Plex Sans 600 `text-body`) and the count `3` (mono `--faint`). A `Table` with no box: header row 30px, labels Plex Sans 500 12px `--faint`; body rows **48px** (they hold inputs), a 1px `--line` hairline under each.

| Column | Width | Contents |
|---|---|---|
| Size | 90px | mono `--text`: `small`, `medium`, `large`. Fixed names: they aren't renamed, added or removed |
| vCPU | 86px | an `Input` 72×34px, `--surface`, 1px `--line-2`, radius 7px, mono 14px, `inputMode="decimal"`, step 0.5 |
| Memory | 150px | the same input, then `GiB` in `--faint` 8px after it; an edited value adds mono 12px `--faint` `was 16` after the unit until saved |
| Default for | `1fr` | the projects whose default is this size, `text-sm` `--muted`, the first two by name (each a link to its project's Runners tab), then `+13`, with the full list in a `Tooltip`. None: `No project` in `--faint` |
| Boxes now | 160px | a single-series bar (below), then the count in mono `--text`, right-aligned in 28px |

- **The bar** (`dataviz`: one series, one colour, direct labels, no legend, no axis): 120×6px, radius 3px, track `--line`, fill `--chart` (Mist `#CFD8D4`), scaled to the largest of the three counts so the biggest row is full. The count beside it is the label; the bar has `role="img"` and `aria-label="14 boxes of small running now"`. Zero: the empty track. In a light theme (not built yet; `globals.css` redefines the same variables under `[data-theme="light"]`) the bar reads `--chart` and `--line` there, so nothing on this page hard-codes a colour.
- **Editing:** a changed input gets a 1px `--muted` border (the picture's brighter border on large's memory) and its `was` hint. The focused input has the shared 2px `--muted` focus ring.
- **Validation** (ticket 27's bounds, *working values*): at least 0.5 vCPU and 1 GiB; whole GiB; vCPU in steps of 0.5; at most 256 vCPU and 1,024 GiB. An invalid input gets a `--red` border and, under the table, 12.5px `--red` `role="alert"`: `small: at least 0.5 vCPU.` / `Memory is a whole number of GiB, at least 1.` `Save sizes` stays disabled.
- **Order of sizes isn't enforced:** small may be larger than medium; the names are labels, not a ladder. No warning for it.

### The room warning

Shown under the table (12px down) when an edited or saved size fits no **online, approved** `docker` or `kubernetes` runner's offer (its `resources`, before any box): a 15px `circle-alert` in `--muted` (not red: nothing is broken yet, and not amber: nothing waits on this admin), `text-sm` `--muted`: `No runner offers 32 GiB yet: the most is 30 GiB, on build-01. A task on large would wait.` (`large` in `--text` 500). With projects on that size: `… 3 projects use large, and their tasks would wait.` For CPU: `No runner offers 12 vCPU yet: the most is 15 vCPU, …`. It doesn't block saving: a runner may join later, and the waiting task says `size-too-large` (spec 5.4).

### The `host` note

24px under the table (or the warning): no box, no fill, a 2px `--line-2` left rule, 12px left padding, `text-sm` `--muted`, two lines: `host runners count slots only. A task there gets no CPU or memory limit, so its size is shown but not enforced.` (`host` in mono). It's always shown: it's the page's one rule that differs by executor (ADR 0029's allowed differences).

### Footnote

16px under, 12.5px `--faint`: `A change applies to boxes made after it. Changes are recorded in the audit log.` Running boxes keep the size they were made with.

## The properties panel

`PropGroup` labels 12px 500 `--faint`; `PropRow`s 30px with a **130px** key column (keys `--muted`, values `--text`).

1. **Where sizes apply:** `docker` · `Limits on each box`; `kubernetes` · `Requests and limits`; `host` · `Slots only` in `--faint`. Keys in mono.
2. **Runners:** `Enforce sizes` · mono `18` (online or draining `docker` and `kubernetes` runners at minor 4 or later); `Slots only` · mono `3` (`host` runners, and minor-3 `docker` runners). Under them, 12.5px `--muted`: `2 host runners, and build-03, which is one minor behind.` with each minor-3 runner's name a teal link to its page (`runner`). With none behind: `3 host runners.` With no runner: `No runner yet.`
3. **Bounds:** `Smallest` · mono `0.5 vCPU · 1 GiB`. (A *working value*, ticket 27: the panel reads it from the API, not a constant here.)
4. **Last change:** 13px `--muted`: `Large set to 8 vCPU · 16 GiB by Alex Kim, 12 Nov` (the latest `box-size.updated` audit entry). Never changed: `The defaults: 2 · 4, 4 · 8 and 8 · 16.` Then a teal `Audit log` link filtered to box sizes.

## States and copy

| State | What changes |
|---|---|
| Edited (`box-sizes.webp`) | As above |
| Saved (the defaults) | Inputs hold small 2 · 4, medium 4 · 8, large 8 · 16 (ticket 04's seed); no `was`; `Save sizes` disabled |
| Saving | `Save sizes` reads `Saving…`, disabled. No confirm: the change touches only boxes made after it |
| Saved | Under the footnote, `role="status"`, 12.5px `--green` with `check`: `Saved. New boxes get these sizes.`; Last change updates; the `was` hints go |
| Save failed | `role="alert"`, 12.5px `--red`, `errorText(error)`, under the table; the typed values stay |
| Invalid | As "Validation" above |
| Loading | The table's inputs and counts as `Skeleton` bars (3 rows); the panel's values as skeletons |
| No boxes running | Every bar is the empty track, counts `0` |
| No `docker` or `kubernetes` runner | The warning doesn't show; the panel's Runners reads `Enforce sizes` · `0`, and 12.5px `--muted`: `No runner enforces sizes yet: every runner is host.` |
| A member (not an admin) | Read-only: values as mono text in place of the inputs, no `Save sizes`, no warning |
| Narrow (below `xl`) | The panel drops under the page (`PageFrame`); below 900px the Default for column wraps under the size's name |
| Phone (F-075) | Each size as a block: the name, then vCPU and memory inputs side by side, then Default for and the bar on one line; `Save sizes` stays in the top bar |

## Components (shadcn/ui names)

`Sidebar` (plus Box sizes), `PageFrame` with `properties` (320px), `Breadcrumb`, `PageHeading`, `Table` / `TableHeader` / `TableRow` / `TableHead` / `TableCell` (existing `ui/table.tsx`), `Input` with a suffix, `Tooltip`, `Button` (default = the Shell primary), `PropGroup` / `PropRow` (with `labelWidth`), `Separator`, `Skeleton`. The bar: a plain `div` with `role="img"` (one series, no primitive needed), or `spend-budgets`' `Progress` if it lands first. Lucide 15px stroke 1.75: `box`, `circle-alert`, `check`.

## Tokens (`app-concepts/html/graphite.css`)

> **Scale.** Built at the approved pictures' scale, which wins on size, spacing and contrast: body 14.5px, dense rows 14px, secondary 13px, small 12px, title 26px, `--muted` `#B4B7BB`, `--faint` `#8B8E93`, buttons 30px, a 46px top bar and a 320px properties panel. Measured values: `../m1/README.md`, "Scale".

| Token | Value | Used for |
|---|---|---|
| `--bg` / `--side` | `#0D0E10` / `#0A0B0C` | page, panel / sidebar |
| `--surface` | `#131416` | inputs, skeletons |
| `--sel` | `#1A1B1E` | the Box sizes nav row |
| `--line` / `--line-2` | `#1F2023` / `#2A2C30` | hairlines, bar tracks / input borders, the `host` note's rule |
| `--text` / `--muted` / `--faint` | `#F2F3F4` / `#B4B7BB` / `#8B8E93` | names, values / lede, Default for, keys, the warning / units, `was`, footnote |
| `--chart` | `#CFD8D4` (Mist) | the Boxes now bars |
| `--green` | `#4FB286` | `Saved.` |
| `--red` | `#E5675C` | invalid inputs, errors |
| `--teal` | `#6FB8AA` | project links, `build-03`, `Audit log` |
| `--amber` | `#FFB224` | only the sidebar's Needs you count. Nothing on this page is amber |
| `--shell` / `--ink` | `#F3F0E8` / `#0C1D21` | `Save sizes` |

Type: Manrope 700 26px (title); IBM Plex Sans for copy and keys; IBM Plex Mono for size names, the inputs, counts, executor names and bounds.

## Data this screen needs beyond ticket 27

- `boxSizes.list` → per size: `name`, `cpuMillis`, `memoryMiB`, the projects whose `defaultBoxSize` is it (ID and name), the count of boxes of that size holding a slot now (`Box.size`), and the bounds.
- `boxSizes.update { name, cpuMillis, memoryMiB }` per changed size, or one `boxSizes.updateAll` in one transaction so a save writes one audit entry per size and fails as a whole. Ticket 27 names the first; the build may add the second.
- For the warning and the panel: the largest `cpuMillis` and `memoryMiB` an online, approved `docker` or `kubernetes` runner offers, with its name; counts of runners that enforce sizes and that count slots only, with the minor-3 runners' IDs and names.
- The latest `box-size.updated` audit entry (who, when, the values before).

## Differences from the current code

Checked against `apps/web`, `packages/api` and `packages/db` on `main` (2026-11-19):

1. **New route and view.** Nothing exists under `organization/box-sizes/`.
2. **`BoxSize`** doesn't exist in the schema; `Project.defaultBoxSize` is a free `String?`. Ticket 04 adds the model, seeds the three, and checks the project's value against it.
3. **Sidebar.** `sidebar.tsx` gains **Box sizes** (`box`) for organization admins (members see it too, read-only).
4. **`PropRow`** takes a `labelWidth` (milestone 2's storage page adds it); use 130px here.
5. **Messages.** New keys under `boxSizes.*`: `title`, `lede`, `sizes`, the column heads, `gib`, `was`, `noProject`, `barLabel`, `tooBigMemory`, `tooBigCpu`, `tooBigProjects`, `hostNote`, `footnote`, `save`, `saving`, `saved`, the validation lines, `whereApply`, `docker`, `kubernetes`, `host`, `runners`, `enforce`, `slotsOnly`, `slotsOnlyWho`, `noRunnerEnforces`, `bounds`, `smallest`, `lastChange`, `neverChanged`; `shell.boxSizes`.

## Wrong in the image (build from this file)

All visible copy is spelled right, and the counts match the demo (18 projects: 15 on small, 3 on medium). These differ from what to build:

- **The properties panel** is drawn about 395px wide (from x 1045). It's 320px.
- **`build-03`** in the panel is underlined. Teal links carry no underline.
- **The warning's icon** sits on a line of its own height; build it inline, 15px, centred on the first line.
- **The `host` note** is indented about 28px with its rule; the rule sits at the content's left edge, as `storage-settings`' deletion block, with 12px padding.
- **medium's Default for** wraps onto two lines and lists all three names. It's the first two and `+1`, on one line, with the full list in the `Tooltip`.
- **The `Last change` line** is drawn in `--text`; it's `--muted`.
- **The sidebar** is drawn from the image's own shell (Linear's icon is a guess). Build it from `sidebar.tsx`.
- **The picture has no saved, saving, invalid, loading, member or narrow states:** they're in the table above.
