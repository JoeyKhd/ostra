# Research: Multica's double sidebar

**Question:** How does Multica's navigation work, so ostra can take its structure and keep its own look? The maintainer, 2026-11-21: "i like the ux of multica a lot, their double sidebar is nice". In particular: is it an icon rail plus a contextual list, what goes in each, where projects, the board and settings sit, how it collapses, and what it does on a phone.
**Status:** Research, 2026-11-21. Feeds milestone 8's shell target (`brand/app-targets/m8/app-shell.md`) and F-146. It settles nothing.
**Builds on** `research/multica-comparison.md` (2026-11-20), which compares Multica's features with ostra's. This note covers only its navigation, which that one didn't.
**Method:** Tavily search and page reads of multica.ai and its changelog, then the source of [`multica-ai/multica`](https://github.com/multica-ai/multica) at commit [`d405319`](https://github.com/multica-ai/multica/tree/d405319d18fdcbfbca8ed3ae5b19b94cd9ada818) (`main`, 2026-11-20), read file by file. File links below are at that commit. The hosted app wasn't run, so behaviour comes from the code, its comments, its tests and Multica's own screenshots. Anything read only from code is marked *(code)*; my own reasoning is *(inference)*.

---

## Summary

- **Yes: a rail of spaces, then the open space's panel, then the page.** Multica calls them the **app rail** and the **space panel** ([`app-rail.tsx`](https://github.com/multica-ai/multica/blob/d405319d18fdcbfbca8ed3ae5b19b94cd9ada818/packages/views/layout/app-rail.tsx), [`space-panel.tsx`](https://github.com/multica-ai/multica/blob/d405319d18fdcbfbca8ed3ae5b19b94cd9ada818/packages/views/layout/space-panel.tsx)). It shipped in v0.8.0 on 3 November 2026: "A new workspace layout: an app bar for Work, Team, Chat, Inbox, and Auto, plus a side panel you can collapse and resize" ([changelog](https://www.multica.ai/changelog)).
- **The rail is 56px** and holds, top to bottom:
  - the workspace switcher;
  - New issue and Search;
  - the spaces (Work, Docs, Team, Chat, Auto), each an icon with a short label under it and a badge;
  - Help, Settings and the account at the bottom.
- **The panel is 280px**, resizable from 200 to 320, and collapses with one toggle (⌘B). Collapsed, hovering a rail space shows its panel over the page for a moment, a "peek".
- **Each space's panel holds that space's places and its live objects.** Work holds the Inbox, Pinned, Views and Projects; projects expand into their issues. Team holds Needs attention, Working now (each agent with the issue it's on), Agents, Squads & members, and Resources.
- **Below 768px the rail and the panel move into one sheet** from the left, opened from the page header. The native app uses a bottom tab bar instead.
- **What makes it feel good** *(inference, from the code's own comments)*:
  - the rail never moves;
  - each space remembers its last page;
  - badges only for things you can clear;
  - the panel shows what's live, not only links.

## 1. The rail

From [`app-rail.tsx`](https://github.com/multica-ai/multica/blob/d405319d18fdcbfbca8ed3ae5b19b94cd9ada818/packages/views/layout/app-rail.tsx) *(code)*:

- **What it is:** "The app rail: workspaces, New issue and search, the four spaces in the user's order (drag to reorder), then help, settings and the account. It sits on the app shell, outside the content card, and stays put while the panel beside it collapses."
- **Size:** `w-14` (56px). A space is a 48×48 link (`size-12`) with a 20px icon and a micro label under it. A label the item can't fit gets a tooltip with the full name ("Auto" stands for Autopilots, [`layout.json`](https://github.com/multica-ai/multica/blob/d405319d18fdcbfbca8ed3ae5b19b94cd9ada818/packages/views/locales/en/layout.json)).
- **The spaces:** `RAIL_SPACES = ["work", "docs", "team", "chat", "autopilots"]`, and "Settings lives in the rail footer rather than the space list" ([`spaces.ts`](https://github.com/multica-ai/multica/blob/d405319d18fdcbfbca8ed3ae5b19b94cd9ada818/packages/core/paths/spaces.ts)). Every route maps to one space: `issues`, `projects`, `views`, `my-issues` and `inbox` to Work; `agents`, `squads`, `members`, `skills`, `runtimes` and `usage` to Team.
- **Badges:** Work counts unread inbox items, Chat counts unread messages, Team shows a dot when an agent's tasks wait on an offline runtime. The rule in the code: "A dot must be something the user can clear, so a failed autopilot run is shown in the Autopilots panel only."
- **Memory per space:** a rail item leads to "the last page visited in that space of this workspace, or `home` for the current space and spaces not yet visited" ([`app-shell-context.tsx`](https://github.com/multica-ai/multica/blob/d405319d18fdcbfbca8ed3ae5b19b94cd9ada818/packages/views/layout/app-shell-context.tsx)).
- **Order:** the spaces can be dragged into a new order, kept per device, with "Reset to default order" in a right-click menu ([`rail-order-store.ts`](https://github.com/multica-ai/multica/blob/d405319d18fdcbfbca8ed3ae5b19b94cd9ada818/packages/core/navigation/rail-order-store.ts)). The menu also has "Open in new tab", "Copy link" and "Mark all as read".
- **The workspace switcher:** "one tile for the current workspace, whatever the workspace count, so the spaces below never move." Its menu lists every workspace, pending invitations and "Create workspace". The tile carries a dot when another workspace has unread items ([`rail-workspaces.tsx`](https://github.com/multica-ai/multica/blob/d405319d18fdcbfbca8ed3ae5b19b94cd9ada818/packages/views/layout/rail-workspaces.tsx)).

## 2. The space panel

- **What it is:** "a column on the card's leading edge, separated from the page by one hairline. Spaces without a shell panel (Chat, Settings) render their own `ListColumn` instead" ([`space-panel.tsx`](https://github.com/multica-ai/multica/blob/d405319d18fdcbfbca8ed3ae5b19b94cd9ada818/packages/views/layout/space-panel.tsx)). Chat's and Settings' list columns are 320px by default, 280 to 480 ([`sidebar.tsx`](https://github.com/multica-ai/multica/blob/d405319d18fdcbfbca8ed3ae5b19b94cd9ada818/packages/ui/components/ui/sidebar.tsx)).
- **Its header:** 48px, the space's name as the title, with icon actions at the right. It's "the title band of every left column … so the space name reads the same in all of them" ([`panel-nav.tsx`](https://github.com/multica-ai/multica/blob/d405319d18fdcbfbca8ed3ae5b19b94cd9ada818/packages/views/layout/panel-nav.tsx)).
- **Work's panel:** the Inbox section, Pinned, Views and Projects ([`work-panel.tsx`](https://github.com/multica-ai/multica/blob/d405319d18fdcbfbca8ed3ae5b19b94cd9ada818/packages/views/layout/panels/work-panel.tsx)). A project expands into its issues in place, as Multica's own screenshot shows ([`workspace-overview.webp`](https://github.com/multica-ai/multica/blob/d405319d18fdcbfbca8ed3ae5b19b94cd9ada818/apps/docs/public/images/docs/workspace-overview.webp)). v0.10.0 (16 November 2026) moved the Inbox to the panel's top ([changelog](https://www.multica.ai/changelog)).
- **Team's panel:** Needs attention ("1 task waiting on an offline runtime", in the warning colour), Working now (each agent with the issue it runs, two lines), Agents, Squads & members, and Resources (Skills, Runtimes, Analytics) ([`team-panel.tsx`](https://github.com/multica-ai/multica/blob/d405319d18fdcbfbca8ed3ae5b19b94cd9ada818/packages/views/layout/panels/team-panel.tsx), [`team-preview.png`](https://github.com/multica-ai/multica/blob/d405319d18fdcbfbca8ed3ae5b19b94cd9ada818/docs/assets/mul-8713/team-preview.png)). Sections fold to their header line ([`team-collapsed.png`](https://github.com/multica-ai/multica/blob/d405319d18fdcbfbca8ed3ae5b19b94cd9ada818/docs/assets/mul-8713/team-collapsed.png)).
- **Where the board and settings sit:**
  - **The board** is a view of Work's issue list, not a place of its own.
  - **Settings** is the rail's gear. It opens a list-and-detail page whose sections are "Personal, Workspace, Issue configuration, Connections & extensions, and Desktop app" (v0.4.41, 7 September 2026, [changelog](https://www.multica.ai/changelog)).
- **Width:** 280px by default, 200 to 320 by dragging its edge, the width kept in local storage ([`sidebar.tsx`](https://github.com/multica-ai/multica/blob/d405319d18fdcbfbca8ed3ae5b19b94cd9ada818/packages/ui/components/ui/sidebar.tsx)).

## 3. Collapsing, and the peek

- **One toggle,** ⌘B (`toggleSidebar: primary("B")`, [`definitions.ts`](https://github.com/multica-ai/multica/blob/d405319d18fdcbfbca8ed3ae5b19b94cd9ada818/packages/core/shortcuts/definitions.ts)), collapses the panel and the list columns together: "whatever the current space shows decides the direction" ([`app-shell-context.tsx`](https://github.com/multica-ai/multica/blob/d405319d18fdcbfbca8ed3ae5b19b94cd9ada818/packages/views/layout/app-shell-context.tsx)). The panel's width animates to 0, with reduced motion respected.
- **The peek:** while collapsed, resting the pointer on a rail space shows its panel over the page's leading edge. It opens after 150ms "so sweeping across the rail does not flash every panel", and closes 200ms after the pointer leaves. It's mouse only: "a touch tap navigates" ([`app-rail.tsx`](https://github.com/multica-ai/multica/blob/d405319d18fdcbfbca8ed3ae5b19b94cd9ada818/packages/views/layout/app-rail.tsx)). Following a link out of the peek closes it.
- **Auto-collapse between 768 and 1023px:** the window is "wide enough to keep a two-pane list/detail surface, too narrow to also spend the panel's width on the nav by default". Only the crossings are automated. A manual re-open holds until the next crossing, and the open state is never persisted ([`sidebar.tsx`](https://github.com/multica-ai/multica/blob/d405319d18fdcbfbca8ed3ae5b19b94cd9ada818/packages/ui/components/ui/sidebar.tsx), [`sidebar-auto-collapse.test.tsx`](https://github.com/multica-ai/multica/blob/d405319d18fdcbfbca8ed3ae5b19b94cd9ada818/packages/views/layout/sidebar-auto-collapse.test.tsx)).

## 4. On a phone

- **Web, below 768px:** "the rail and the current space's panel move into one sheet, opened by the page header's nav trigger." The sheet holds the rail and a 260px panel side by side, and closes on any navigation ([`compact-nav-sheet.tsx`](https://github.com/multica-ai/multica/blob/d405319d18fdcbfbca8ed3ae5b19b94cd9ada818/packages/views/layout/compact-nav-sheet.tsx)). The bottom status bar is gone, and quick chat becomes a floating button ([`bottom-bar.tsx`](https://github.com/multica-ai/multica/blob/d405319d18fdcbfbca8ed3ae5b19b94cd9ada818/packages/views/layout/bottom-bar.tsx)).
- **The native app** (Expo, `apps/mobile`) uses a bottom tab bar instead: Inbox, My issues, Chat and More ([`(tabs)/_layout.tsx`](https://github.com/multica-ai/multica/blob/d405319d18fdcbfbca8ed3ae5b19b94cd9ada818/apps/mobile/app/(app)/%5Bworkspace%5D/(tabs)/_layout.tsx)).

## 5. The rest of the frame

- **The content card:** on desktop the panel and the page share one rounded surface with a ring, inset 8px from a tinted app-shell background, with the rail outside it ([`dashboard-layout.tsx`](https://github.com/multica-ai/multica/blob/d405319d18fdcbfbca8ed3ae5b19b94cd9ada818/packages/views/layout/dashboard-layout.tsx)). This is Multica's look, not its structure.
- **A 32px status bar** under the card: the plan's trial, stuck work ("N tasks waiting on an offline runtime", linking to Team) and quick chat ([`bottom-bar.tsx`](https://github.com/multica-ai/multica/blob/d405319d18fdcbfbca8ed3ae5b19b94cd9ada818/packages/views/layout/bottom-bar.tsx)).
- **Object pages** (an issue, an agent): a breadcrumb header, the document, and a properties panel on the right that ⌘/ toggles ([`issue.webp`](https://github.com/multica-ai/multica/blob/d405319d18fdcbfbca8ed3ae5b19b94cd9ada818/docs/assets/readme/issue.webp), [`team.webp`](https://github.com/multica-ai/multica/blob/d405319d18fdcbfbca8ed3ae5b19b94cd9ada818/docs/assets/readme/team.webp), [`definitions.ts`](https://github.com/multica-ai/multica/blob/d405319d18fdcbfbca8ed3ae5b19b94cd9ada818/packages/core/shortcuts/definitions.ts)). ostra's task page has had the same three parts since milestone 1.

## 6. Licence: take the idea, never the code

Multica's licence is Apache 2.0 plus additional conditions ([`LICENSE`](https://github.com/multica-ai/multica/blob/d405319d18fdcbfbca8ed3ae5b19b94cd9ada818/LICENSE)). Condition 1b defines "a Multica user interface" as "any user interface derived, in whole or in substantial part, from the user interface code in this repository", naming `packages/views/` and `packages/ui/`. It says that user interface's logo, name and copyright can't be removed without a waiver.

So ostra reimplements the pattern from this description and its own design spec, and copies no code, class names or assets from Multica *(inference)*. A navigation layout itself is a common pattern: VS Code, Slack and Linear all have a rail of spaces.

The screenshots linked above are Multica's. Copies for the maintainer's review sit with the lead, and none are committed to this repo.

## What this means for ostra

**Take (the structure):**
- **A rail of spaces** with short labels and badges. The badges show only what someone can clear, and amber stays on Needs you.
- **A contextual panel** per space. It holds the place's pages and its live objects: a project's live tasks, as Team's "Working now" holds agents and their issues.
- **One key to collapse** the panel, a hover peek while it's collapsed, an auto-collapse band, and a resizable width.
- **A last page per space.**
- **One sheet on a phone.**

**Leave (the skin):**
- the inset rounded content card on a tinted background, and the bottom status bar;
- Multica's colours, its brand-tone badges, its fonts and its floating chat button;
- dragging the spaces into a new order (*(inference)* little value with four spaces).

ostra keeps its flat graphite chrome: the rail on `--side`, and the panel on the page's own surface, one hairline from it (`app-design.md`).

**Differences for ostra's domain** (the target's choices; `app-shell.md`):
- **The spaces:** Home, Needs you, Projects and Org, with Settings and the account at the rail's foot.
- **A project's panel** drills into that project, with its pages and live tasks, rather than a tree of every project's issues.
- **The collapse key** is `[`, since ostra's shortcuts are single keys and `g` sequences (`app-targets/m7/shortcut-sheet.md`).
- **On a phone,** a bottom tab bar holds the spaces, and the panel is a sheet. That's Multica's native-app pattern rather than its web sheet. ostra's phone use is mostly answering Needs you (F-075).

## Unconfirmed

- Whether the hosted multica.ai runs the code read here at `d405319`. The app wasn't signed into.
- The exact micro label size (`text-micro`) and the colour tokens: read as class names, not resolved to pixels.
- The peek's and the auto-collapse's behaviour in a browser: read from code and tests, not run.
