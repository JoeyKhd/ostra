# 10: Web: the double-sidebar app shell

Status: ready-for-agent
Builder: web
Blocked by: its targets in `context/brand/app-targets/m8/` approved by the maintainer (a design agent is making them in the `m8-targets` worktree, 2026-11-21)
Features: F-147
Packages: `apps/web` (`src/components/shell/`, the layouts that use it, `messages/en.json`, `e2e/`), `context/brand/app-design.md`
Spec: `../spec.md`, sections 2, 3 (step 1) and 13; `context/brand/app-design.md`, "Layout"
Note: the maintainer likes Multica's layout: "their double sidebar is nice" (2026-11-21). Every other milestone 8 screen is drawn in this shell (ticket 09), so this ticket's targets come first.

## What to build

The app shell's navigation becomes **a narrow icon rail plus a contextual second sidebar**, built to the approved targets. The design agent's targets and their build specs are the source for every size, token, icon, state and word; this ticket doesn't redesign. Where a build spec and this text disagree, the build spec wins, and the difference goes under `## Comments`.

- **The rail,** always there on desktop. Its items, top to bottom, as the targets order them:
  - the organization's mark;
  - search (⌘K) and a new task;
  - Home and the personal views, with **Needs you**'s amber count;
  - the member's pinned projects, each its 8 px colour square, with an amber dot where something waits on the member;
  - the organization;
  - the member's menu at the bottom.

  Each item has a tooltip and an accessible name, and the open place is marked.
- **The context sidebar** beside it lists the open place's pages, the rows `app-design.md`'s "Layout" lists today:
  - **for a project:** Tasks, Inbox, Environment, Boards, Automations, Memory, Repos and Settings, with their counts;
  - **for the organization:** Runner pools, Models, GitHub, Linear, Storage, Agent profiles, the Library (new in milestone 8), Insights, Memory, Members, Audit log, Background work and Settings, each shown only to the roles that see it today;
  - **for the personal views:** Home, Needs you and My tasks.

  "N more" projects opens the full list. The sidebar collapses to the rail alone, and stays as the member left it (a cookie, read on the server, so there's no flash).
- **Routes:** every route of milestones 1 to 7 stays where it is. The shell only changes how it's reached. `destinations.ts` gains each page's place, so the palette, the breadcrumbs and the rail agree, and a test fails for a route with no place.
- **The keyboard:** the rail and the context sidebar are one landmark each. Arrow keys move inside, Tab moves between them and the page, and a shortcut collapses the sidebar, added to milestone 7's one registry and its `?` sheet. ⌘K and every existing shortcut are unchanged.
- **Phone width:** at 390 px the rail and the context sidebar open together as one sheet from the top bar, as the targets draw it, and close on navigation.
- **Both themes,** from the tokens. No new colour: amber stays only for "needs you" (`app-design.md`, "Colours").
- **`app-design.md`:** if the design agent hasn't already, its "Layout" item 1 becomes the rail and the context sidebar, with the sizes of the approved targets, and its rule list keeps "few boxes".
- **Words:** every label through `t`, in `messages/en.json`, and milestone 7's message-file check passes.

## Done when

- [ ] The targets are approved, recorded under `## Comments` with the date and the folder's README.
- [ ] Tests named for `F-147`:
  - every route reachable through the rail and the context sidebar (a Playwright walk over `destinations.ts`, which fails for a page with no place);
  - the collapsed state kept after a reload with no flash;
  - the phone sheet at 390 px opening, navigating and closing;
  - ⌘K and the existing shortcuts unchanged.
- [ ] Milestone 7's keyboard walk and contrast check pass on the shell in both themes, at 1440 px and 390 px, with the shell spec file alone (the full browser suite runs at the milestone's end).
- *Withdrawn 2026-11-21, with the proof files (the maintainer: "keep tests, drop extras"):* screenshots of both themes at both widths are kept in `context/proof/` for F-147's live evidence.
- [ ] Checks for `apps/web` pass. *Changed 2026-11-21: `pnpm check:proof` is gone with the proof files.*
- [ ] Committed as `✨ add the double-sidebar app shell`.

## Comments
