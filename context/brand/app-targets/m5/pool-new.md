# Target: New pool (milestone 5, screen 2)

> **Committed image:** `pool-new.webp`, downscaled from its 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel.

- **Prompt:** `pool-new.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 1 generation. References: `app-targets/m4/member-invite`'s 2048 original (the screen this one starts from: its sheet, fields, radio rows, checkbox rows and footer), `app-targets/m1/runners.png` (the page behind), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`. The page behind the sheet was dimmed afterwards by a script (×0.6 left of the sheet's edge), as `member-invite`'s was.
- **Route:** none of its own. A `Sheet` on `/organization/runners`, opened by the top bar's **New pool** (admins only). `?new-pool=1` opens it, so a link can too. The pool page's Settings `Edit` opens the same sheet in edit mode (below).
- **Features:** F-091 (named pools with their settings, the token lifetime). Spec section 12, screen 2; section 3, step 1. Ticket 25 (`pools.create { name, requiresApproval, maxBoxes, joinTokenDays, projectIds }`), ticket 30 (this sheet).
- **Status:** a proposed target, waiting on approval (ticket 29's `## Comments`). Ticket 30 builds its data and tests until then, not its UI.

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

An organization admin makes a pool: its name, whether each new runner waits for approval, a cap on its boxes, how long its join tokens last, and which projects may use it. `pools.create` writes the pool, its first join token (hashed) and an audit entry in one transaction and answers the token once (spec section 4, "A pool and its tokens"). The sheet then swaps to `pool-join`, which shows that token.

The picture shows Alex Kim making `build-fleet` as the spec's demo does (step 1): approval on, at most 3 boxes, tokens that last 30 days, for `calculator` and `web-storefront`.

## Layout (CSS px at 1440 wide)

| Region | Size | Contents |
|---|---|---|
| The page behind | the Runners page | dimmed by the sheet's overlay, `bg-black/60` (`ui/sheet.tsx`), and inert |
| Sheet | **450px**, full height, from the right, `--bg`, 1px `--line-2` on its left, no radius | padding `24px 28px`. A body that scrolls, and a footer pinned to the bottom with a 1px `--line` above it. The same sheet as `m4/member-invite` |

Inside the sheet, top to bottom, one left edge for everything:
- **Header:** `New pool`, Manrope 700 19px, and the close `X` (Lucide `x` 16px `--faint`, a 28px ghost button) at the top right. Under it, 6px, 14px `--muted`: `Runners join a pool with a token, then take its projects' tasks.`
- **Fields** 20px apart. Labels Plex Sans 500 13px `--muted`, 8px above their control. Controls 34px, `--surface`, 1px `--line-2`, radius 7px.

1. **Name.** `Input`, the sheet's full width, Plex Mono 14px, autofocused, required, at most 64 characters, `autocomplete="off"`.
2. **Require approval for new runners.** A 52px row with hairlines above and below: the label in `--text` 14px, under it 12.5px `--faint` `An admin approves each runner before it takes a task.`, and a `Switch` at the right (off by default; Shell track with an Abyss knob when on). The whole row toggles it.
3. **Max boxes.** `Input inputMode="numeric"`, about 120px, Plex Mono, empty by default (placeholder `No limit` in `--faint`). To its right, 12.5px `--faint`: `Across the pool. Empty for no limit.` Digits only; `0` is refused (`Enter 1 or more, or leave it empty.`).
4. **Join tokens last.** A `RadioGroup` as three 40px rows with hairlines between:
   - `30 days` (default) and, after it in `--faint`, `the default`. The number is the instance's `OSTRA_JOIN_TOKEN_DAYS` (30 unless set), so it reads `{n} days` and `joinTokenDays` is sent as `null` (spec section 5.3).
   - `Another`, then a 30px numeric `Input` about 70px wide with the placeholder `days`, disabled until the radio is picked, then focused. 1 to 3650; out of range: `Between 1 and 3650 days.`
   - `No expiry`, then in `--faint` `until someone revokes it`. Sends `0`.
5. **Projects** (section head, Plex Sans 600 14px) and `optional` in 12.5px `--faint`. Under it, 13px `--muted`: `Each project picks its pools' order and its share in its own settings.`
   - Every project of the organization, open and restricted, as 44px rows with hairlines above and below, no box: a 14px `Checkbox` (Shell fill and an Abyss tick when checked), the project's 8px colour square, its name in `--text`, and for a restricted project Lucide `lock` 13px `--faint`. A checked row has the `--sel` fill. Nothing is checked at first.
   - Checking a project appends this pool to the end of that project's list (`ProjectPool.position`); its share stays none. The footer of the list says nothing more: the project's own settings hold the order and the share (`m5/project-runners`).
   - The list scrolls inside the sheet's body past 8 rows.
   - No project yet: one `--faint` line, `No project yet. A project lists its pools in its settings.`
6. **Footer**, pinned: a 13px `--muted` line with Lucide `key-round` 14px: `Its first join token is shown once, on the next step.` Then 14px below, the sheet's one primary `Create pool` (34px, Shell fill, Abyss text, 600) and a secondary `Cancel`.

### Edit mode (from the pool page's Settings `Edit`)

The same sheet with the pool's values: title `Edit {pool}`, line `Changes apply to runners and tokens from now on.`, no Projects section, no footer line, and the buttons `Save` and `Cancel`. The lifetime applies to tokens made after the change; existing tokens keep their expiry (the line under the radios says so in `--faint`: `Tokens already made keep their expiry.`). Saving calls `pools.update`.

## States and copy

| State | What changes |
|---|---|
| Open | the form, the name focused, approval off, no cap, `30 days`, nothing checked |
| Filled (the picture) | `build-fleet`, approval on, `3`, `30 days`, `calculator` and `web-storefront` checked |
| Name empty | on submit, under the field, 13px `--red`, `role="alert"`: `Enter a name.`; the field gets a `--red` border. Nothing is sent |
| Name taken | from the server (`CONFLICT`): `A pool with that name exists.` under the field (the existing `runners.poolNameTaken`) |
| Max boxes 0 or not a number | `Enter 1 or more, or leave it empty.` under the field |
| `Another` with no number | `Between 1 and 3650 days.` under the radio rows |
| Creating | `Create pool` reads `Creating…` with a 14px spinning `loader-circle`; every control disabled; the overlay doesn't close the sheet |
| Create failed (other) | one `--red` line above the footer's buttons, `role="alert"`, from `errorText()`; the form keeps its values |
| Created | the body swaps to `pool-join` in the same sheet; the Runners page's list refreshes behind it. Nothing re-fetches the token |
| A member (not an admin) | never sees `New pool`; `?new-pool=1` does nothing for them. The server refuses with `FORBIDDEN` anyway |
| Phone (F-075) | the sheet takes the full width, the footer stays pinned above the safe area, the `Max boxes` help line wraps under its input |

## Components (shadcn/ui names)

`Sheet` / `SheetContent` (the 450px sheet with the pinned footer that `m4/member-invite` adds to `ui/sheet.tsx`), `Field` / `Label` / `Input`, `Switch`, `RadioGroup` / `RadioGroupItem`, `Checkbox`, `Button` (default = Shell primary; secondary), `Separator`. Lucide 15px, stroke 1.75: `x`, `lock`, `key-round`, `loader-circle`.

## Tokens

At the approved pictures' scale (`../m1/README.md`, "Scale"; the colours `app-design.md` lists).

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | the sheet |
| `--surface` | `#131416` | inputs, the switch's track when off |
| `--sel` | `#1A1B1E` | a checked project row |
| `--line` | `#1F2023` | row hairlines, the footer's rule |
| `--line-2` | `#2A2C30` | the sheet's left edge, control borders, `Cancel` |
| `--text` | `#F2F3F4` | values, names, row labels |
| `--muted` | `#B4B7BB` | field labels, the line under the title, the footer line |
| `--faint` | `#8B8E93` | descriptions, `optional`, `the default`, placeholders, locks |
| `--red` | `#E5675C` | field errors |
| `--shell` / `--ink` | `#F3F0E8` / `#0C1D21` | `Create pool`, the switch when on, checked checkboxes, the selected radio |
| `--amber` | `#FFB224` | nowhere in the sheet |

Type: Manrope 700 19px (the title); IBM Plex Sans 14px controls and rows, 13px labels and lines, 12.5px descriptions; IBM Plex Mono for the name and the numbers.

## Differences from the current code

Checked against `apps/web` and `packages/api` on `main` (2026-11-19):

1. **`new-pool-sheet.tsx` exists** with Name, the approval switch and Max boxes, in a narrower sheet with its buttons in the body. It grows to this layout: the 450px sheet with a pinned footer, the switch's description, the lifetime radios and the projects list.
2. **`pools.create`** (`packages/api/src/routers/runners.ts`) takes `{ name, requiresApproval, maxBoxes }` and answers `{ poolId }`. Ticket 25 adds `joinTokenDays` and `projectIds`, and makes the first token in the same transaction, answering it once.
3. **After creating,** the sheet today closes and selects the pool. Here it swaps to `pool-join`.
4. **The edit mode** is new; `pools.update` exists and gains `joinTokenDays` (ticket 25).
5. **Messages.** New keys under `runners.newPool.*` in `messages/en.json`; `runners.poolRequiresApproval` becomes `Require approval for new runners`.

## Wrong in the image

Build the copy and details in this file, not these:

- **The page behind** already lists a pool named `build-fleet`, the name being typed. It's `m1/runners`' picture; on a real install that name would be refused as taken.
- **The page behind** has the overlay darkened by script. Build `bg-black/60`, as `ui/sheet.tsx` has.
- **The help beside Max boxes** sits about 20px right of the input; it's 12px from it, on the input's centre line.
- **The sidebar** is milestone 1's; build it from the shell, whatever it shows. The logo is the model's approximation; use the real Hinge SVG.

All visible copy is spelled right.
