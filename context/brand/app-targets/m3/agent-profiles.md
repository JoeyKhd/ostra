# Target: agent profiles (milestone 3, screen 1)

> **Committed image:** `agent-profiles.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel.

- **Prompt:** `agent-profiles.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 1 generation. References: `app-targets/m1/models.png` (the screen this one starts from, spec section 12), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`.
- **Route (new):** `apps/web/src/app/(panel)/organization/agent-profiles/page.tsx` → `components/agent-profiles/agent-profiles-view.tsx`. One profile's editor is the next target, `agent-profile.md`.
- **Features:** F-021 (agent profiles); the list also shows F-026's rules and F-063's plan first. Spec section 12, screen 1. Ticket 34 (`agentProfiles.list`, `.get`), ticket 42 (this screen).
- **Status:** a proposed target, waiting on approval (ticket 41's `## Comments`). Ticket 42 builds its data and tests until then, not its UI.

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

The organization's agent profiles in one list. A profile is the organization's named setup of an agent: the agent, a model, instructions, skills, MCP servers, approval rules, plan first and who may use it (ADR 0049). An admin sees every profile, compares them at a glance (which ones plan first, which ask a person for what, who can pick them, which projects start their tasks with them) and opens one to edit or makes a new one. A member sees the profiles they may use, read-only, so they know what the picker at a task's start offers.

The picture shows an admin with five profiles, `Careful` selected: the profile of the milestone 3 demo (spec section 3, step 1), with plan first, three rules, two listed members, and `calculator`'s default for code tasks.

## Layout (CSS px at 1440 wide)

| Region | Size | Contents |
|---|---|---|
| Sidebar | 232px, `--side`, 1px `--line` on its right | the shared sidebar (`components/shell/sidebar.tsx`). Organization gains **Agent profiles** (Lucide `sliders-horizontal`), selected (`--sel`, `--text`), shown to **every member** (ticket 42), after the admin-only rows. Build it from the shell, not the picture |
| Top bar | 44px, 1px `--line` below | breadcrumb `Acme Corp › Agent profiles` (`Agent profiles` in `--text` 500). Right, admins only: **New profile** with a `plus` icon, the page's one primary button (Shell fill, Abyss text). The panel holds no form, so this is the primary |
| Page | `1fr`, padding `28px 40px` | title, lede, the Profiles section, the archived toggle |
| Properties panel | **300px** (the default: it holds no form), 1px `--line` on its left, padding `20px 18px` | the selected profile, or the hint |

The picture draws the panel at about 362px. Build 300px.

### Heading

- Title **Agent profiles**, Manrope 700 24px, letter-spacing −0.015em. No eyebrow.
- Lede, 13.5px `--muted`, max-width 720px, two lines: `An agent, its model, and what it works with: instructions, skills, MCP servers and the rules that ask a person first. A project picks one per kind of task, and members pick from the ones they may use.`

### Profiles section

- Section head, 26px above: **Profiles** (Plex Sans 600 13px) and the count `5` (Plex Mono 500 11.5px `--faint`). The count is the active profiles; archived ones aren't counted.
- A `Table` with no box, as Models' models table. Header row 30px, labels Plex Sans 500 11.5px `--faint`. Body rows **40px**, a 1px `--line` hairline under each, the first column starting at the title's x.
- Order: the built-in profile first, then by name (what `agentProfiles.list` already does).

| Column | Width | Contents |
|---|---|---|
| Profile | ~190px | Lucide `sliders-horizontal` 15px `--faint`, 10px gap, the name 13px `--text`, truncated. The built-in one adds an outline chip `built-in` (Plex Sans 12px `--muted`, 22px tall, 1px `--line-2`, radius 6px) |
| Agent and model | ~200px | `OpenCode` in `--muted`, ` · `, the model's name in `--text` (`Claude Opus 5.5`). No model: `OpenCode · ` then `No model yet` in `--red` |
| Plan first | 76px | `On` in `--text`, or `–` in `--faint` |
| Rules | 56px | the rule count in Plex Mono 12.5px `--text`; none: `None` in `--faint` |
| Who may use it | ~130px | `Everyone` in `--muted`; listed: up to three 18px avatars (initials, Plex Sans 600 9px, `--raise` fill, overlapping by 4px with a 1.5px `--bg` ring), then `2 members` / `1 member` in `--muted` |
| Default for | flex | each project and kind that defaults to it, `calculator · code`, in `--muted`, comma-separated, one line, truncated, then `+2` in `--faint` for the rest; full list in a `Tooltip`. None: `–` in `--faint` |

- The whole row is the click target and sets the selection (`aria-pressed`); double-click or Enter opens the editor. Hover `--raise`, selected `--sel`.
- Kinds read `refine`, `code`, `review` (the project's `defaultRefineProfileId`, `defaultCodeProfileId`, `defaultReviewProfileId`).

Demo rows in the picture (`OpenCode` is the agent on every row: it's the only adapter until milestone 7):

| Profile | Model | Plan first | Rules | Who may use it | Default for |
|---|---|---|---|---|---|
| OpenCode `built-in` | Claude Sonnet 5.5 | – | None | Everyone | billing-platform, web-storefront +2 |
| Careful | Claude Opus 5.5 | On | 3 | AK SR · 2 members | calculator · code |
| Migrations | Claude Opus 5.5 | On | 2 | Everyone | data-pipeline · code |
| Quick fixes | DeepSeek V4 Flash | – | 1 | Everyone | – |
| Reviewer | GPT-6.2 Sol | – | None | 3 members | mobile-app · review |

### Archived toggle

10px under the table: a ghost button, 24px, `--muted` 12.5px, `chevron-right` 13px (`chevron-down` open): `Show 1 archived profile` / `Show 3 archived profiles`; open, `Hide archived profiles`. Open, an **Archived** section head with its count follows, with the same table; names in `--muted`, and the Default for column reads `Archived 3 Nov` in `--faint`. Hidden when nothing is archived. Members never see archived profiles.

### Properties panel (a profile selected)

`PropGroup`s with an 11px 500 `--faint` label, 30px `PropRow`s with the 96px key column, 12.5px; a 1px `--line` between groups.

1. Eyebrow `Profile` (11px 500 `--faint`); title row: `sliders-horizontal` 15px `--muted` and the name, Plex Sans 600 15px. The built-in one adds its `built-in` chip.
2. **Setup:** `Agent` · `OpenCode`; `Model` · the model's name (or `No model yet` in `--red`); `Plan first` · `On` / `Off`; `Skills` · the names in Plex Mono, comma-separated, or `None` in `--faint`; `MCP servers` · the same.
3. **Approval rules** with the count in Plex Mono `--faint`: one item per rule, 6px apart: the name 12.5px `--text`, an outline chip `preset` at the right for a rule added from a preset; under it, Plex Mono 12px `--faint`, the match in short: up to two globs joined by ` · ` then `+2`; `9 allowed commands`; `pnpm add, npm install +7`; `any URL`; `any server not marked read-only`. None: `No rules: the agent asks nobody.` in `--faint`.
4. **Who may use it:** `Everyone` in `--muted`, or `Only these members` then one 26px row each: an 18px avatar and the name in `--text`.
5. **Default for:** one row per project and kind: the project's 8px colour square, its name in `--text`, the kind at the right in `--muted` (`code tasks`). None: `No project defaults to it.` in `--faint`.
6. 16px down: **Edit profile** (admins; a secondary button, 30px, 1px `--line-2`, `--text`), to the editor; members get **View profile**, the same button opening it read-only. Beside it, 12px `--faint`: `Edited 2h ago by Alex Kim` (from the profile's last audit entry; never edited: `Created 12 Nov`).

## States and copy

| State | What changes |
|---|---|
| Loading | five 40px rows of `Skeleton` bars; the panel shows its group labels with skeleton values |
| Loaded, nothing selected | the panel shows, 12.5px `--faint`: `Pick a profile to see its setup.` |
| A profile selected (the picture) | as above. The selection is in the URL (`?profile=<id>`), so a link opens it selected |
| Only the built-in profile | the one row, then 14px down, 12.5px `--muted`: `Only the built-in profile so far. A profile of your own sets the model, instructions, skills and rules a task starts with.` and, for admins, a teal `New profile` link. No illustration: the list is never empty, since the built-in profile always exists |
| No model on a profile | its row's model reads `No model yet` in `--red`; in the panel, under Setup, 12px `--red`: `A task can't start with it until it has a model.` For the built-in profile the line adds the teal link `Pick one under Models` |
| Archived shown | the Archived section as above; selecting an archived row shows its panel with `Archived 3 Nov by Alex Kim` in `--muted` in place of Default for, and no Edit button (see `agent-profile.md`, open points) |
| A member (not an admin) | the rows are the profiles open to them (`agentProfiles.list` filters); no `New profile`, no archived toggle; `View profile` in the panel. The lede is the same |
| Load failed | under the lede, `role="alert"`, 12.5px `--red`: the error text (`errorText`), in place of the section |
| Narrow (below 1280px) | the panel drops under the page (`PageFrame`). Below 900px the Plan first, Rules and Default for columns leave the table and become a second line under the name, 12px `--faint`: `plan first · 3 rules · calculator · code` |
| Phone (F-075) | one column: each profile a 52px two-line row (name and chip; `Claude Opus 5.5 · plan first · 3 rules` in `--faint`); tapping opens the editor; `New profile` stays in the top bar as an icon button with an `aria-label` |

## Components (shadcn/ui names)

`Sidebar` (existing, plus Agent profiles), `PageFrame` with `Breadcrumb` and `properties`, `PageHeading`, `Section`, `Table` / `TableHeader` / `TableRow` / `TableHead` / `TableCell` (existing `ui/table.tsx`), `Badge` (outline; today `Chip` in `ui/status.tsx`), `Avatar` (existing `ui/avatar.tsx`), `Tooltip` (new), `Button` (default = the Shell primary; secondary; ghost for the toggle), `PropGroup` / `PropRow`, `Skeleton` (existing). Lucide 15px, stroke 1.75: `sliders-horizontal`, `plus`, `chevron-right`, `chevron-down`.

## Tokens (`app-concepts/html/graphite.css`)

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | page, panel, avatar rings |
| `--side` | `#0A0B0C` | sidebar |
| `--surface` | `#131416` | chips, skeletons |
| `--raise` | `#17181B` | row hover, avatar fill |
| `--line` | `#1F2023` | row hairlines, panel edge, group lines |
| `--line-2` | `#2A2C30` | chip and secondary button borders |
| `--text` | `#EDEDEE` | names, models, `On`, counts |
| `--muted` | `#9A9DA3` | `OpenCode ·`, `Everyone`, defaults, keys, lede |
| `--faint` | `#64676D` | header labels, icons, `–`, `None`, the panel's labels and rule matches |
| `--sel` | `#1A1B1E` | the selected row and sidebar item |
| `--red` | `#E5675C` | `No model yet`, errors |
| `--teal` | `#6FB8AA` | inline links (`New profile`, `Pick one under Models`) |
| `--amber` | `#FFB224` | only the sidebar's Needs you count. Nothing on this page is amber |
| `--shell` / `--ink` | `#F3F0E8` / `#0C1D21` | `New profile` |

Type: Manrope 700 24px (title); IBM Plex Sans 13px body, 12.5px secondary, 11–11.5px labels, 600 for section titles and the panel title, 500 for buttons; IBM Plex Mono for counts, skill and server names, and rule matches. Project squares use the project's own colour.

## Data this screen needs beyond ticket 34

Ticket 34's `agentProfiles.list` returns the profiles a member may use (all of them for an admin). The rows also need, per profile:

- `planFirst`, `access` and the listed members' names and initials, `archivedAt`;
- the rules' names, tools, preset origin and a short match summary (or the rules themselves, and the panel summarizes);
- the skill and MCP server names;
- **defaults:** each project and kind that defaults to it (project ID, name, colour, kind), limited to projects the viewer can open;
- the last audit entry's actor and time, for `Edited 2h ago by Alex Kim`.

Archived profiles come only to admins, behind a flag (`includeArchived`), so a member's list never holds them.

## Differences from the current code

Checked against `apps/web` and `packages/api` on `main` (2026-11-19):

1. **New route and view.** Nothing exists under `organization/agent-profiles/`, nor `components/agent-profiles/` (ticket 42 names both).
2. **Sidebar.** `sidebar.tsx` lists Runners for everyone and Models and GitHub for admins. Add **Agent profiles** (`sliders-horizontal`) for every member, after the admin rows (and after Linear and Storage, when milestone 2's rows land).
3. **`agentProfiles.list`** (`packages/api/src/routers/providers.ts`) returns `id`, `name`, `adapter`, `builtIn` and the model only, to every member, with no filter. Ticket 34 moves it to its own router, filters it by `profilesForMember`, and it needs the fields above.
4. **Models page.** It picks the built-in profile's model (`setDefaultModel`) and marks that model `default`. That stays; the built-in profile's model can now also be changed in its editor, and both call the same mutation.
5. **Messages.** New keys under `agentProfiles.*` in `messages/en.json`, and `shell.agentProfiles`.

## Wrong in the image

Build the copy and details in this file, not these:

- The sidebar's **Linear** row has the `sliders-horizontal` icon, the same as Agent profiles. Linear's icon is Lucide `ticket` (`m2/connect-linear.md`).
- The panel is about 362px. Build 300px.
- The first row's Default for wraps to two lines. It's one line, truncated, with `+2`.
- The panel's title icon is drawn at about 20px; it's 15px `--muted`. The panel's key column is about 110px; it's 96px.
- The listed members' avatars sit side by side; they overlap by 4px with a `--bg` ring.
- The selected row's band starts 6px left of the table. It starts at the row's own left edge, as Models' rows do.
- The sidebar shows four projects and no Members or Settings rows: the sidebar is built from the shell, whatever the picture shows.
- The picture has no loading, empty, no-model, archived, member, error or narrow states: they're in the table above.

All visible copy in the image is spelled right.
