# App design: graphite

How every screen of ostra's panel looks and is laid out. This is the direction the maintainer picked on 2026-11-18 ("B is very nice!"). The logo, type and voice are ostra's own (`brief.md`). The chrome is neutral, and the brand colours are only accents.

**Status:** a chosen direction with six concept screens, built as real HTML (`app-concepts/html/`). These are not approved targets yet. A screen becomes a target, in `app-targets/`, when its milestone starts and the maintainer approves it (`build-order.md`).

## Rules

These come from the maintainer's verdict on round 2 ("the ui is FUCKING ugly") and their answers to Q60–Q63.

1. **Neutral chrome.** The background, panels and lines are near-black graphite with no hue. Brand colours appear only as accents (below). The blue-green Abyss made the whole app look muddy.
2. **Dense, like a tool people work in all day:**
   - body text 14.5px
   - secondary text 13–14px
   - page titles 26px
   - nav rows 28px
   - list and table rows 38–40px

   These are the approved pictures' scale, which wins over `graphite.css` on size, spacing and contrast (`app-targets/m1/README.md`, "Scale", decided 2026-11-19). The concepts were drawn at 13px.
3. **Few boxes.**
   - A section is a title line and rows separated by hairlines.
   - Boxes only for code, form fields, the composer and the selected row.
   - An approval is an amber left rule, not a card.
   - Never a box inside a box.
4. **One meaning per colour** (the table below). Colour never carries meaning alone: a dot or icon always has a label.
5. **Real HTML, never image-model mockups.** Concepts are built with the real fonts, icons and density, then screenshotted (round 3 onward).

## Layout

1. **The double sidebar** (F-147, milestone 8; approved 2026-11-21, `app-targets/m8/app-shell.md`). It replaces the single 234px sidebar. At 1440 wide: rail 64 | panel 240 | page.
   - **The rail, 64px, on `--side`,** never moves and never scrolls. Top to bottom:
     - the organization tile (the Hinge, with a letter chip for a member of more than one organization), which opens the organization switcher;
     - New task (the `--primary` square) and Search (⌘K);
     - the four spaces, each an icon over an 11px label: **Home**, **Needs you** (its amber count, the rail's only amber), **Projects** (one space: no pinned projects in the rail) and **Org**;
     - at its foot, **Settings** and the member's initials, which open the member's menu.
     - The open space is lit (`--sel`). A space opens the last page visited in it this session; the lit one goes back to its home.
   - **The context panel, 240px (200 to 320 by dragging), on `--bg`,** one hairline from the page, no card and no shadow. Its 46px head names the place; its body lists the place's pages as 28px rows, then what's live in it:
     - **Home:** Overview, Board and All tasks; the member's own live tasks; the tasks they opened lately.
     - **Needs you:** the list with its count, then each project where something waits.
     - **A project:** the switcher in the head; Tasks, Needs approval (amber), Inbox, Boards, Environment, Automations, Memory, Insights and Settings, with their counts (Repos is a tab of Settings); its live tasks, needs-you first; the member's other projects, each with its 8px colour square and an amber dot where something waits on them.
     - **Organization:** Insights, Spend, Memory; Fleet (Runners, Box sizes, Registry); Agents (Agent profiles, the Library's `Skills and MCP` once its page exists, Models); Connections (GitHub, Linear); People (Members, Previews for its admins: the organization's public preview links, Audit log); Instance (Accounts, Storage, Email, Previews). Each row shows only to the roles that see it, and a group left empty is hidden.
     - **Settings:** the member's own pages.
     - **Memory** is a page for the project and another for the organization (F-109, ADR 0044). Each carries a count of its proposals (F-111), in the plain count style, never amber.
   - **Collapsing:** `[`, or the head's `panel-left-close`, hides the panel (160ms); the top bar's `panel-left-open` brings it back. The choice is kept in a cookie the server reads, so a reload doesn't flash. While it's collapsed, resting the pointer on a space for 150ms floats that space's panel over the page (the peek). From 1024 to 1279px the panel starts collapsed; from 768 to 1023 the rail stands alone and the panel opens over the page.
   - **Below 768px:** no rail and no tab bar. The top bar's menu button (with an amber dot while something needs the member) opens one sheet from the left holding the rail and the panel side by side, `min(100vw - 56px, 384px)` wide, with 44px rows.
2. **Top bar, 46px** (54px below 768px, the menu button first): breadcrumbs on the left (`calculator › Tasks › CALC-161`), the page's actions on the right. At most one primary (Shell) button per page.
3. **The page:** a title (Manrope 700, 26px), a one-line lede in muted text, optional underline tabs, then sections.
4. **The properties panel, 320px on the right** (380px when it holds a form). Every resource has one: a task, a project, an environment, a pool, a provider. It holds key/value rows, grouped under small labels. A list with a selected row shows that row's properties here.
5. **Lists are grouped by lifecycle state**, in the order of `domain-model.md`: Needs you, Running, Queued, In review. Each group gets a quiet header band with a count. A row shows:
   - state, key, title
   - what the agent is doing now
   - box, driver, age
6. **Charts are small and single-series** where possible: Mist bars or lines, a recessive grid, and direct labels on only the peak and "now". They follow the `dataviz` skill. No categorical palette is defined yet; validate one when the first multi-series chart needs it.

## Colours

The values live in `app-concepts/html/graphite.css` until milestone 1 turns them into the panel's real tokens. `files/tokens/tokens.css` (with `tokens.json` beside it) still holds the brand tokens (Abyss-based) for the social images. The docs site wears the panel's graphite tokens since 2026-11-20 (`app-targets/m7/docs-home.md`, "Tokens"), and so does the README banner (B-025 in `assets.md`).

| Role | Colour |
|---|---|
| Page background | `#0D0E10` |
| Sidebar | `#0A0B0C` |
| Raised surface (inputs, code, group bands) | `#131416` |
| Selected row or nav item | `#1A1B1E` |
| Lines | `#1F2023`; control borders `#2A2C30` |
| Text, sidebar rows, secondary, faint | `#F2F3F4`, `#D6D8DB`, `#B4B7BB`, `#8B8E93` (the pictures' contrast; the concepts used `#EDEDEE`, `#9A9DA3`, `#64676D`) |
| **Needs you** (only this) | Buoy Amber `#FFB224`, with Abyss `#0C1D21` text on amber fills |
| Healthy, success, additions | `#4FB286`, always with an icon or label |
| Errors and deletions | `#E5675C`. Never amber |
| Links and inline actions ("Take over", "Copy") | teal `#6FB8AA` |
| A switch that is on | teal `#6FB8AA` track and edge, with an Abyss `#0C1D21` knob |
| Primary button | filled Shell `#F3F0E8` with Abyss text |
| Charts | Mist `#CFD8D4` |
| Project markers | one colour per project, only on its 8px square |

**Switches are teal (decided 2026-11-21).** The approved targets disagreed on a switch's on state: `--teal` (agent-profile, memory-note), the Shell primary (instance-settings, the pool sheet) and `--green`, which the panel used. The maintainer picked teal, the panel's accent, for every switch in both themes: `--teal` for the track and its edge, and `--on-primary` for the knob (Abyss in dark, the page's near-white in light). Measured against WCAG's 3:1 for controls: the knob against the track is 7.5:1 in dark and 6.1:1 in light, and the track against the page, the sidebar, a surface, a raised panel and a selected row is 7.5:1 to 8.6:1 in dark and 5.2:1 to 6.3:1 in light. The off state is unchanged: a `--surface` track with a `--control-line` edge and a `--text` knob. Green stays for health and success.

The light theme (milestone 7, ticket 18) mirrors this table token for token in neutral greys, with graphite ink and no Abyss: `app-targets/m7/light-home.md`, "The light tokens" (page `#FAFAFB`, text `#141518`, re-based on graphite on 2026-11-20).

## Type

- **Manrope 700:** page titles.
- **IBM Plex Sans:** everything else. Weight 500 for nav and buttons, 600 for section titles.
- **IBM Plex Mono:** keys (`CALC-161`), branches, commits, box and runner names, paths, commands, numbers in tables, times.
- **Icons:** Lucide, 15px, stroke 1.75.

## Concept screens (2026-11-18)

In `app-concepts/html/`, each as `.html` and `.png` (1440×900 at 2×). They share `graphite.css` and `shell.js` (the sidebar). Model names and prices come from models.dev on 2026-11-18. Everything else is demo data.

| Screen | File | Features it shows |
|---|---|---|
| Home (the organization) | `home-graphite` | F-062, F-036, F-108, F-037, F-086 |
| A project's tasks | `project-tasks-graphite` | F-026, F-063, F-086 |
| A task waiting on an approval | `task-b-graphite` | F-023, F-024, F-025, F-026, F-027, F-084 |
| A project's environment | `environment-graphite` | F-050, F-051, F-054, F-094, F-095, F-116 |
| Runner pools | `runner-pools-graphite` | F-091, F-092, F-015, F-014, F-093, F-067 |
| Models and providers | `models-graphite` | F-088, F-089, F-037 |

The decisions behind the screens:

- Projects and access: ADR 0026.
- Runner pools, executors and boxes: ADR 0029. The egress baseline the environment screen shows: ADR 0031. Network allowlists (F-052) come after v1.
- Environments, snapshots and services: ADR 0038.
- Model providers: ADR 0033. Metering and budgets: ADR 0042.

## History

- **Round 1** (`app-concepts/01`–`05`, image model): felt small, single-team.
- **Round 2** (`app-concepts/06`–`11`, image model): Northflank's console structure on Abyss. Rejected: too big and chunky, boxes inside boxes, a muddy background, and image mockups that looked clumsy.
- **Round 3** (`app-concepts/html/`): two directions in real HTML. Direction A (`task-a-northflank`, navy, Northflank's structure) was not picked. Direction B, graphite, was.
