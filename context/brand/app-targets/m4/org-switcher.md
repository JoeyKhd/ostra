# Target: the organization switcher (milestone 4, screen 6)

> **Committed images,** each downscaled from a 2048×1360 picture to 1440×956, so one image pixel is one CSS pixel:
> - `org-switcher.webp`: the switcher open on Acme Corp's Home.
> - `org-switcher-create.webp`: the `New organization` sheet.
> - `org-switcher-switched.webp`: the new organization's Home, just after the switch, with the `Switched to Second` notice.

- **Prompts:** `org-switcher.prompt.txt`, `org-switcher-create.prompt.txt`, `org-switcher-switched.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high). References: `app-targets/m1/home.png` (the approved page this one starts from, spec section 12) for the first two, the approved `m2/home-first-run` generation for the third, plus `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`. Generations:
  - `org-switcher`: 1, kept as made.
  - `org-switcher-create`: 2. Both squeezed the page behind the sheet into a narrower layout, which a sheet never does. The kept picture is the first generation's sheet pasted over `m1/home.png` darkened to 40% (the overlay), so the page behind is the approved Home, unchanged.
  - `org-switcher-switched`: 1, with the right column asked for empty and then composited with the Deep water illustration exactly as `../m2/home-first-run.md` ("The illustration") says.
- **Where:** the shared sidebar (`components/shell/sidebar.tsx`, its `OrganizationSwitcher`), on every panel page. The sheet and the notice belong to the shell too, not to a route.
- **Features:** F-049 (several organizations). Spec section 12, screen 6; section 3, step 12; section 4, "Switching organizations". Ticket 24 (`organizations.mine`, `.switch`, `.create`, `.resolve`), ticket 33 (this screen). ADR 0053, ADR 0026.
- **Status:** a proposed target, waiting on approval (ticket 31's `## Comments`). Ticket 33 builds its data and tests until then, not its UI.

> Build it in real HTML/React (app-design.md, rule 5), then screenshot the build at 1440×956 and compare it with each picture.

## Purpose

An account can belong to several organizations, which never see each other (ADR 0053). The switcher answers, from any page:

1. **Which organization am I in?** Its name is always at the top of the sidebar.
2. **Which others can I go to?** The menu lists the account's active memberships, the current one marked, each with the account's role there.
3. **Can I make a new one?** The instance admin (or anyone, with open organization sign-up on) gets `New organization`, which opens a sheet.

And when the organization changes without the member choosing it in the menu (after creating one, or by following a link to a record of another of their organizations), the panel says so: `Switched to Second`. A member should never wonder why the projects changed.

## Layout (CSS px at 1440 wide)

The page under the switcher is whatever page is open; the pictures use Home (`../m1/home.md`, and `../m2/home-first-run.md` for a new organization). Only the shell changes.

### The trigger

As today (`OrganizationSwitcher`): the 20px Hinge mark, the organization's name (Plex Sans 600, 15px at the pictures' scale, `--text`, truncated with a `title`), Lucide `chevrons-up-down` 14px `--faint` at the far right. A 6px-radius row, `--sel` on hover and while the menu is open (`data-[state=open]`). It opens on click, Enter or Space; `aria-label` `Switch organization`.

With a single membership and no right to create one, the trigger still opens the menu (one row, marked), so the place never changes behaviour.

### The menu (`org-switcher.webp`)

`DropdownMenu`, `align="start"`, `sideOffset={6}`. **264px wide** (wider than the sidebar's content, so it overlaps the page by a little), `--surface`, 1px `--line-2`, 8px radius, 6px padding, the shadcn menu's soft shadow. The page isn't dimmed. Top to bottom:

1. **Label line,** 28px: `Organizations` (11px, 500, `--faint`) and, at the right, the count in Plex Mono 11px `--faint`.
2. **One row per membership,** 32px, 6px radius, `DropdownMenuRadioGroup` / `DropdownMenuRadioItem` with the active organization's ID as its value:
   - a 20px tile, 5px radius, `--line` fill, 1px `--line-2` border, holding the organization's initial in Manrope 700 11px `--text` (the first letter of its name, upper case; organizations have no logo in milestone 4)
   - the name, 13px `--text`, truncated
   - at the right, the account's role there, 12px `--faint`, Plex Sans: `Admin` or `Member`
   - the active row: `--sel` fill and Lucide `check` 14px `--text` after the role (`aria-checked`)
   - order: the active one first, then by name. Hover and keyboard focus: `--raise`.
3. **A `DropdownMenuSeparator`** (1px `--line-2`, 6px above and below), then **`New organization`**, 32px: Lucide `plus` 15px `--muted`, the words in 13px `--text`, and at the right a `Badge variant="outline"` `instance admin` (11px, `--faint`) when the account is the instance admin. With open organization sign-up on, everyone sees the row, without the badge. Otherwise the row and its separator are absent, not disabled (ticket 33: what a member can't do is absent).

Choosing another organization calls `organizations.switch`, closes the menu, and replaces the page with the same route in the new organization when it exists there (Home, Needs you, My tasks, the organization's pages), or Home otherwise (a project, a task, a setting of a project: they belong to the old organization). No notice: the member chose it. While the switch runs, the trigger's name is replaced by a 12px `Loader` and the row is disabled.

### The create sheet (`org-switcher-create.webp`)

`Sheet` from the right, **380px** (the form width at the pictures' scale; the picture draws about 364px), full height, `--bg`, 1px `--line-2` on its left edge, padding 24px. The page behind is dimmed by the sheet's overlay (black at 60%) and doesn't reflow. Top to bottom:

1. **Header:** `New organization` (Plex Sans 600, 15px, `--text`) and a ghost icon button `x` (`aria-label` `Close`).
2. **Description,** 8px below, 13px `--muted`: `A separate space with its own projects, runners, model providers and members. Nothing in Acme Corp is shared with it.` (the current organization's name).
3. **Name** (24px below): `Field` with `Label` `Name` (12.5px, 500, `--muted`) and an `Input` 36px, full width, autofocused, at most 64 characters. Help under it, 12px `--faint`: `Members see it in the switcher. You can rename it later.`
4. **It starts with** (26px below), `h3` 13px 600, then three 34px rows split by `--line` hairlines, no box: a 15px icon in `--muted`, the label in 13px `--text`, the value right-aligned in 13px `--muted`:

| Icon | Label | Value |
|---|---|---|
| `server` | `Runner pool` | `default` (Plex Mono) |
| `sliders-horizontal` | `Agent profile` | `Built-in` |
| `user-round` | `Admin` | `Alex Kim (you)` |

   These are what `createOrganization` makes in its transaction (ticket 24): the same default pool and built-in profile the first organization got at the seed, and the creator's admin membership.
5. **What it lacks,** 14px below, 12.5px `--faint`: `It has no model provider, GitHub App, Linear connection, member or project yet. Its first-run checklist walks you through them.`
6. **Footer,** pinned to the sheet's bottom: a 1px `--line` hairline, then 16px below, right-aligned, `Cancel` (outline, 30px) and the primary `Create organization` (Shell fill, Abyss text, 30px). It's the only primary button visible while the sheet is open; the top bar's `New task` is under the overlay.

On success, the sheet closes, the panel switches to the new organization and lands on its Home, and the notice says so (below).

### The notice (`org-switcher-switched.webp`)

A toast at the bottom right of the window, 24px from both edges, **360px** wide, `--surface`, 1px `--line-2`, 8px radius, the soft shadow, padding `12px 14px`, `role="status"`:
- Lucide `arrow-left-right` 15px `--muted`, top-aligned with the first line
- line 1, 13px 500 `--text`: `Switched to Second`
- line 2, 12.5px `--muted`: the reason (table below), with at most one teal link
- a ghost `x` 12px `--faint` at the top right (`aria-label` `Dismiss`)

It stays 8 seconds, longer while hovered or focused, and goes with Escape. One notice at a time: a second switch replaces it.

| Why the organization changed | Line 2 |
|---|---|
| The member created it (the picture) | `You're its admin. Acme Corp is in the switcher.` |
| A link to a record of another of the member's organizations (ADR 0053: `organizations.resolve`, then `.switch`) | `The page you opened belongs to it.` then a teal `Back to Acme Corp`, which switches back and returns to the page the member came from |
| The active organization went away (the member was removed from it, ADR 0053) and the panel fell back to another | `You're no longer a member of Acme Corp.` |

The page behind is the new organization's: in the picture, Second's first-run Home (`../m2/home-first-run.md`), with only `Create the first admin` done, `Add a provider →` as the next step's primary button, and the Deep water illustration in the right column.

## States and copy

| State | What shows |
|---|---|
| **One organization, a member** | the menu with one marked row and no separator, no `New organization` |
| **Instance admin** (the picture) | `New organization` with the `instance admin` badge |
| **Open organization sign-up on** | `New organization` for everyone, no badge |
| **Loading** (`organizations.mine` pending, at most on the first open) | the label line and two 32px `Skeleton` rows in the menu; the trigger shows the active organization's name from the session at once |
| **Load failed** | one 32px row in 12.5px `--red`: `Couldn't load your organizations. Retry` with `Retry` as a teal link |
| **Switch failed** (the membership ended in between) | the menu stays open, the row disabled, and a 12px `--red` line under it: `You're no longer a member of Harbor Labs.`; the list refetches |
| **Name empty** | `Create organization` disabled; no message until the member tries |
| **Name taken** | under the field, `role="alert"`, 12px `--red`: `An organization with that name exists on this install.` (only if ticket 24 makes names unique; if not, no check) |
| **Creating** | the button reads `Creating…` and is disabled, the field is read-only, `Cancel` stays. The sheet can't be dismissed by the overlay while it runs |
| **Create failed** | above the footer, `role="alert"`, 12.5px `--red`: `errorText(error)`. The name is kept |
| **Not allowed** (a forged call without the right) | ticket 24 answers `FORBIDDEN`; the panel never shows the row, so the member never reaches this |
| **A link into an organization the member isn't in** | the record's page shows `not found` like any other (ADR 0053). No switch, no notice: the panel never says the organization exists |
| **Narrow (below 768px)** | the sidebar is a sheet already (`app-shell.tsx`); the switcher sits at its top and opens its menu at the sidebar's width minus 16px. The create sheet is full width. The notice is full width minus 16px at the bottom |

The demo data in the pictures (fixtures, not real): `Acme Corp` (active, admin), `Second` (admin), `Harbor Labs` (member); the instance admin `Alex Kim`. The real demo (spec step 12) uses `Demo` and creates `Second`.

## Components (shadcn/ui names)

- `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuLabel`, `DropdownMenuRadioGroup`, `DropdownMenuRadioItem`, `DropdownMenuSeparator`, `DropdownMenuItem` (all in `components/ui/dropdown-menu.tsx` already)
- `Sheet`, `SheetContent`, `SheetHeader`, `SheetTitle`, `SheetDescription`, `SheetFooter` (already in `components/ui/sheet.tsx`); `Field`, `Label`, `Input` (already)
- `Button` (primary, outline, ghost), `Badge` (`instance admin`), `Skeleton`
- The notice: a `role="status"` element the shell renders, not `Sonner`: `sonner` is a package the maintainer hasn't approved (`../m2/project-boards.md`, item 3). One `Notice` component in `components/shell/`, which the panel's other "done" messages can reuse later.
- Icons: Lucide, stroke 1.75: `chevrons-up-down` 14px, `check` 14px, `plus`, `server`, `sliders-horizontal`, `user-round`, `arrow-left-right`, `x`, `loader` 15px.

## Tokens (`app-concepts/html/graphite.css`)

> **Scale.** The sizes and colours below are `graphite.css`'s. The panel is built at the approved pictures' scale, which wins on size, spacing and contrast: body 14.5px, dense rows 14px, secondary 13px, small 12px, title 26px, `--muted` `#B4B7BB`, `--faint` `#8B8E93`, buttons 30px, a 46px top bar and a 320px properties panel (380px with a form, the sheet's width). The measured values are in `../m1/README.md`, "Scale".

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | the sheet |
| `--side` | `#0A0B0C` | sidebar; the right column under the illustration |
| `--surface` | `#131416` | the menu, the notice, inputs |
| `--raise` | `#17181B` | a menu row's hover and focus |
| `--sel` | `#1A1B1E` | the active row, the trigger while open |
| `--line` | `#1F2023` | the tiles' fill, the sheet's hairlines |
| `--line-2` | `#2A2C30` | the menu's, notice's and sheet's borders, the separator |
| `--text` | `#EDEDEE` | names, the check, the notice's first line |
| `--muted` | `#9A9DA3` | descriptions, icons, the notice's second line |
| `--faint` | `#64676D` | the label, roles, help, the badge |
| `--teal` | `#6FB8AA` | `Back to Acme Corp`, `Retry` |
| `--red` | `#E5675C` | errors |
| `--shell` / `--ink` | `#F3F0E8` / `#0C1D21` | `Create organization` |

No amber: switching and creating never wait on anyone. Type: IBM Plex Sans throughout (600 for the trigger's name and the sheet's title, 500 for the notice's first line), Manrope 700 11px for the tiles' initials, IBM Plex Mono for the count and `default`.

## Data this screen needs beyond ticket 24

- `organizations.mine` returns each membership's **organization ID, name and the account's role** there, and which is active. The menu also needs to know **whether the account may create one** (instance admin, or open organization sign-up on): add `canCreate` to its output, or read it from `me.get`.
- `organizations.create` returns the new organization's ID; the panel calls `.switch` with it (or `.create` switches in the same call: ticket 24 decides, and the panel follows).
- The notice's reason travels in the URL after a server-side switch (`?switched=created|link|removed&from=<organizationId>`), read once and cleared, as `account`'s `?github=` is (`../m3/account.md`).

## Differences from the current code

Checked against `apps/web` on `main` (2026-11-19):

1. **`OrganizationSwitcher`** (`components/shell/sidebar.tsx`) is a `DropdownMenu` with one item, the current organization, showing the ostra mark and a check. Target: every membership from `organizations.mine` as a radio item with its initial tile and role, the count, the separator and `New organization`. The rows show the organization's initial tile, not the ostra mark: the mark is ostra's, and two organizations with the same mark can't be told apart.
2. **The trigger's name** is 15px today (the pictures' scale). Keep it.
3. **New:** `components/shell/create-organization-sheet.tsx` and `components/shell/notice.tsx`, and the `switched` reader in `app-shell.tsx`.
4. **Messages:** under `shell.*` in `messages/en.json`: `switchOrganization` and `organizations` exist; add the role words, `newOrganization`, `instanceAdmin`, the sheet's strings, and the notice's lines with the organization's name as a parameter.
5. **Every query depends on the active organization:** after a switch, invalidate the whole tRPC cache (`queryClient.clear()` or reset), not single queries, so no list from the old organization shows for a frame.

## Wrong in the images

Build the copy and details in this file, not these:

- **`org-switcher`: the roles** (`Admin`, `Member`) are drawn in mono. They're Plex Sans 12px `--faint`.
- **`org-switcher`: the `instance admin` badge** is drawn in mono; it's Plex Sans 11px.
- **`org-switcher`: the sidebar's Organization rows** (`Runners`, `Models`, `GitHub`, `Linear`, `Members`, `Audit log`) are flavour. Build the shell's rows.
- **`org-switcher-create`: the page behind** is `m1/home` pasted in at 40% brightness; the sidebar there is milestone 1's flavour (`Runner pools`, `Agent profiles`, `Insights`, …). The shell decides.
- **`org-switcher-switched`:** the sidebar lists `Linear` with a board icon and no `Agent profiles`; the shell decides. The illustration is composited from the real asset, as `../m2/home-first-run.md` says, not drawn.
- **The logo** in all three approximates the Hinge mark. Use `kit/logo/export/ostra-hinge-single-color.svg`, 20px.
- The pictures have no loading, error, one-organization, link or narrow states: they're in the tables above.

All visible copy in the images is spelled right.
