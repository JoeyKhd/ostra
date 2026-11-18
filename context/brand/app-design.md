# App design: graphite

How every screen of ostra's panel looks and is laid out. This is the direction the maintainer picked on 2026-11-18 ("B is very nice!"). The logo, type and voice are ostra's own (`brief.md`). The chrome is neutral, and the brand colours are only accents.

**Status:** a chosen direction with six concept screens, built as real HTML (`app-concepts/html/`). These are not approved targets yet. A screen becomes a target, in `app-targets/`, when its milestone starts and the maintainer approves it (`build-order.md`).

## Rules

These come from the maintainer's verdict on round 2 ("the ui is FUCKING ugly") and their answers to Q60–Q63.

1. **Neutral chrome.** The background, panels and lines are near-black graphite with no hue. Brand colours appear only as accents (below). The blue-green Abyss made the whole app look muddy.
2. **Dense, like a tool people work in all day:**
   - body text 13px
   - secondary text 12–12.5px
   - page titles 24px
   - nav rows 26px
   - list and table rows 38–40px
3. **Few boxes.**
   - A section is a title line and rows separated by hairlines.
   - Boxes only for code, form fields, the composer and the selected row.
   - An approval is an amber left rule, not a card.
   - Never a box inside a box.
4. **One meaning per colour** (the table below). Colour never carries meaning alone: a dot or icon always has a label.
5. **Real HTML, never image-model mockups.** Concepts are built with the real fonts, icons and density, then screenshotted (round 3 onward).

## Layout

1. **Sidebar, 232px, always there:**
   - The organization switcher, then search (⌘K) and a "+" for a new task.
   - Personal views: **Home**, **Needs you** (an amber count) and **My tasks**.
   - **Projects:** the member's pinned projects, each with an 8px colour square. An amber dot marks a project where something waits on them. The open project expands into Tasks, Inbox, Environment, Automations, Memory, Repos and Settings. "N more" opens the full list.
   - **Organization:** Runner pools (busy count), Models, Agent profiles, Insights, Memory, Members, Audit log, Background work and Settings. Agent profiles are F-021. Background work lists queues and stuck jobs, with retry and cancel (ADR 0037).
   - **Memory** is a page for the project and another for the organization (F-109, ADR 0044). Each carries a count of its proposals (F-111), in the plain count style, never amber.
   - The signed-in member at the bottom.
2. **Top bar, 44px:** breadcrumbs on the left (`calculator › Tasks › CALC-161`), the page's actions on the right. At most one primary (Shell) button per page.
3. **The page:** a title (Manrope 700, 24px), a one-line lede in muted text, optional underline tabs, then sections.
4. **The properties panel, 300px on the right** (340px when it holds a form). Every resource has one: a task, a project, an environment, a pool, a provider. It holds key/value rows, grouped under small labels. A list with a selected row shows that row's properties here.
5. **Lists are grouped by lifecycle state**, in the order of `domain-model.md`: Needs you, Running, Queued, In review. Each group gets a quiet header band with a count. A row shows:
   - state, key, title
   - what the agent is doing now
   - box, driver, age
6. **Charts are small and single-series** where possible: Mist bars or lines, a recessive grid, and direct labels on only the peak and "now". They follow the `dataviz` skill. No categorical palette is defined yet; validate one when the first multi-series chart needs it.

## Colours

The values live in `app-concepts/html/graphite.css` until milestone 1 turns them into the panel's real tokens. `files/tokens/tokens.css` (with `tokens.json` beside it) still holds the brand tokens (Abyss-based) for the docs, README and social images.

| Role | Colour |
|---|---|
| Page background | `#0D0E10` |
| Sidebar | `#0A0B0C` |
| Raised surface (inputs, code, group bands) | `#131416` |
| Selected row or nav item | `#1A1B1E` |
| Lines | `#1F2023`; control borders `#2A2C30` |
| Text, secondary, faint | `#EDEDEE`, `#9A9DA3`, `#64676D` |
| **Needs you** (only this) | Buoy Amber `#FFB224`, with Abyss `#0C1D21` text on amber fills |
| Healthy, success, additions | `#4FB286`, always with an icon or label |
| Errors and deletions | `#E5675C`. Never amber |
| Links and inline actions ("Take over", "Copy") | teal `#6FB8AA` |
| Primary button | filled Shell `#F3F0E8` with Abyss text |
| Charts | Mist `#CFD8D4` |
| Project markers | one colour per project, only on its 8px square |

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
