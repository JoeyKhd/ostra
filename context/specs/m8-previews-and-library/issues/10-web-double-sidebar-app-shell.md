# 10: Web: the double-sidebar app shell

Status: ready-for-agent
Builder: web
Blocked by: its targets in `context/brand/app-targets/m8/` approved by the maintainer. *Approved 2026-11-21 ("yes to all"): nothing blocks it now.*
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
  - **Projects,** one space: its panel holds the open project, the member's other projects with their amber dots, and the switcher. No pinned projects sit in the rail (`app-shell.md`, open point 2);
  - the organization;
  - the member's menu at the bottom.

  Each item has a tooltip and an accessible name, and the open place is marked.
- **The context sidebar** beside it lists the open place's pages, the rows the targets list (`app-shell.md`, "The spaces' panels"):
  - **for a project:** Tasks, Needs approval, Inbox, Boards, Environment, Automations, Memory, Insights and Settings, with their counts. Repos stays a tab of the project's Settings, as today;
  - **for the organization:** the rows and groups `app-shell.md` lists, the Library (`Skills and MCP`, new in milestone 8) among them, each shown only to the roles that see it today. There's no Background work row until a route for it exists;
  - **for the personal views:** Home, Needs you and My tasks.

  "N more" projects opens the full list. The sidebar collapses to the rail alone, and stays as the member left it (a cookie, read on the server, so there's no flash).
- **Routes:** every route of milestones 1 to 7 stays where it is. The shell only changes how it's reached. `destinations.ts` gains each page's place, so the palette, the breadcrumbs and the rail agree, and a test fails for a route with no place.
- **The keyboard:** the rail and the context sidebar are one landmark each. Arrow keys move inside, Tab moves between them and the page, and a shortcut collapses the sidebar, added to milestone 7's one registry and its `?` sheet. ⌘K and every existing shortcut are unchanged.
- **Phone width:** below 768 px there's no bottom tab bar (`shell-phone`, `shell-phone-menu`; `app-shell.md`, "Phone").
  - **The top bar** has a menu button, the page's title or breadcrumb, and the page's main action.
  - **The menu button** opens one sheet from the left holding the rail and the context sidebar side by side: the screen's width less 56 px, at most 384 px (334 at 390). It closes on Escape, on a tap outside, on its close button and after a page is chosen. Focus is trapped in it and returns to the menu button.
  - **Needs you stays reachable:** its amber count on the rail inside the sheet, and an amber dot on the menu button while something needs the member.
  - *Changed 2026-11-21. The maintainer: "no need for a bottom tab bar btw".*
- **Both themes,** from the tokens. No new colour: amber stays only for "needs you" (`app-design.md`, "Colours").
- **`app-design.md`:** if the design agent hasn't already, its "Layout" item 1 becomes the rail and the context sidebar, with the sizes of the approved targets, and its rule list keeps "few boxes".
- **Words:** every label through `t`, in `messages/en.json`, and milestone 7's message-file check passes.

## Done when

- [x] The targets are approved, recorded under `## Comments` with the date and the folder's README.
- [ ] Tests named for `F-147`:
  - every route reachable through the rail and the context sidebar (a Playwright walk over `destinations.ts`, which fails for a page with no place);
  - the collapsed state kept after a reload with no flash;
  - the phone sheet at 390 px opening, navigating and closing (Escape, a tap outside, a chosen page), with focus back on the menu button;
  - ⌘K and the existing shortcuts unchanged.
- [ ] Milestone 7's keyboard walk and contrast check pass on the shell in both themes, at 1440 px and 390 px, with the shell spec file alone (the full browser suite runs at the milestone's end).
- *Withdrawn 2026-11-21, with the proof files (the maintainer: "keep tests, drop extras"):* screenshots of both themes at both widths are kept in `context/proof/` for F-147's live evidence.
- [ ] Checks for `apps/web` pass. *Changed 2026-11-21: `pnpm check:proof` is gone with the proof files.*
- [ ] Committed as `✨ add the double-sidebar app shell`.

## Comments

- 2026-11-21, design: the maintainer approved the targets in `context/brand/app-targets/m8/` ("yes to all"), recorded in its README. The same day: "no need for a bottom tab bar btw", so the phone is the menu sheet holding the rail and the panel (`shell-phone`, `shell-phone-menu`). This ticket's text now follows the targets: Projects is one rail space with no pinned projects, Repos stays a tab of the project's Settings, and Background work has no row until it has a route.
