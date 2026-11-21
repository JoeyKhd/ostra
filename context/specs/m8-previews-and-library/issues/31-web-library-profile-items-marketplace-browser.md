# 31: Web: the library, the profile's items and the marketplace browser

Status: done
Builder: web
Blocked by: 09, 30
Features: F-145, F-146
Packages: `apps/web`
Spec: `../spec.md`, section 13 (targets 10 to 15)

## What to build

To the approved targets `library`, `library-install`, `library-update`, `library-suggestions`, `library-browse` and `agent-profile-library`:
- **Organization → Library** (a row in the context sidebar, ticket 10):
  - skills and MCP servers, each with its source, pin, hash, "Every profile", the profiles it's on, an update waiting, and a source no longer allowed;
  - the suggestions' count for admins, never amber;
  - the empty state;
  - a member's read-only view with "Suggest".
- **Install by reference:**
  - the reference field;
  - the skills found in a repo to pick from;
  - the commit, the files with their sizes and the script files pointed out, and the hash;
  - "Allow this source";
  - for a server, its remote, the inputs with the secret ones masked, "Test" with the tools' names, and the OAuth and packages-only refusals in the target's words.
- **An update:** a skill's changed files with their diff, or a server's changed fields and tools, with "Accept" and "Dismiss".
- **Suggestions:** the member's form, and the admins' list with "Install" and "Dismiss".
- **The marketplace browser:**
  - the search and the skills and servers tabs;
  - results with their source, installs or version, and whether the source is allowed, each with "Install", which opens the same install dialog;
  - the off state with the switch and its words, and "search unavailable".
- **The profile editor:** the profile's own skills and servers, the attached library items with their pins, the inherited every-profile ones, the attach picker, and the limit's refusal.
- **Organization settings:** "Marketplace search", with its words on what it sends where.
- **Words** through `t`.

## Done when

- [x] The targets' approval is recorded in ticket 09's `## Comments` before the UI is built.
- [x] Tests named for `F-145` (this ticket's browser spec file only, against the fakes):
  - a skill installed by reference and attached to a profile;
  - a server installed with a secret input that never shows again;
  - an update's diff accepted;
  - a member's suggestion installed by an admin.
- [x] Tests named for `F-146`: a search and an install from a result; the off state.
- [x] Milestone 7's keyboard walk and contrast check pass on the new pages and dialogs, in both themes, and they work at 390 px.
- [x] Checks for `apps/web` pass (spec section 10).
- [x] Committed as `✨ add the library and the marketplace browser`.

## Comments

- 2026-11-21, web: committed as `✨ add the library and the marketplace browser`, on ticket 30 (`6d11103b`) and `✨ list a member's own library suggestions` (`1a291df2`), to the approved targets (both batches, the README's approval sections). Built.
  - **Pages** (`apps/web/src/app/(panel)/organization/skills/`): the library (`page.tsx`, `?tab=all|skills|mcp|updates`, the install sheet from `?add=skill|mcp&source=`, a member's Suggest sheet from `?suggest=1`), one item (`[item-id]`), the marketplace (`marketplace`) and the admins' suggestions (`suggestions`). The Organization panel's `Skills and MCP` row (`blocks`, every member's) and the four pages' places are in `components/shell/places.ts`.
  - **Components** (`components/library/`): `library-model.ts` (what every row, chip, band, refusal and pick says, pure), `library-parts.tsx`, `library-page.tsx` (the table with its bands, the suggestions band, the properties panel with the policy, the switch and its words, `Calls out to`), `add-from-source-sheet.tsx` (560 wide: a skill's look with its skills to pick, files, scripts, checks and hash, `Allow this source` and the whole owner; a server's registry, remote, inputs with the secret masked, the test call's tools or the OAuth mark, `Read-only`; the packages-only, SSE-only, inactive and no-remote refusals), `sources-sheet.tsx` (the allowlist: who added each entry and how many items it allows), `item-page.tsx` and `item-diff.tsx` (the update's head, Keep and Accept, the two-pane diff with hunks and a Unified/Split toggle, a server's changed fields and tools; SKILL.md, Files, Server, Tools and Used by tabs; Check for updates asks again every 2 s while core's job runs), `marketplace-view.tsx`, `suggestions-page.tsx` and `suggest-sheet.tsx`. The profile editor (`components/agent-profiles/profile-library.tsx`) groups each section by origin (its own, from the library, on every profile), counts it against 50 skills and 20 servers, picks both kinds from one picker, and applies on Save; every-profile rows have no remove, and a pick past a limit is refused under the section in the target's words.
  - **API gap filled:** `library.suggestions.mine` (any member, their own only), with `F-145/c9` in `routers/library.test.ts` and the isolation matrix's lines.
  - **Differences from the targets:** no audit verdicts (Q319). A skill's row and item page have no front-matter description in the list (the API keeps none), so the row's second line is its files and size, and the item page reads it from `SKILL.md` for an admin. The member's Suggest sheet doesn't look the reference up (`library.resolve` is an admin's), so the allowlist answer comes when it's sent; there's no `Withdraw` and the dismissal takes no reason (the domain has neither). The server's test call runs right after the install (`library.testServer` takes an installed item), and the sheet then shows the tools or the OAuth mark before `Done`; `Name in the library` is shown, not edited (the install names it). The marketplace has no `first seen` column and no SKILL.md excerpt beyond the front matter (search answers don't carry them). Below 1024 px the marketplace's detail stacks under the results rather than opening a sheet. `Add from a source` and `Browse the marketplace` aren't palette actions yet. `Previews` under Instance lands with its page (ticket 26); `app-shell.md` lists it.
  - **Tests:** `components/library/library-model.test.ts` (15, `F-145/c1`, `c4` to `c10`, `F-146/c2`, `c3`), and `e2e/24-library.spec.ts` (6, against the stack's fakes): `F-145/c1`/`c7` (a skill installed by reference from the fake GitHub's public skills repo, its source allowed in the sheet, attached on Save), `c4` (a registry server with its secret header, its tools listed, the token in no page or answer), `c10`/`c11` (a push to the fake repo, core's update check, the diff accepted, the pin moved), `c9` (a member's suggestion installed by an admin, the member reading the answer), `F-146/c3` (off by default for an admin and a member, then the switch with its words) and `F-146/c1` (a search and an install from a result). The e2e stack's panel loads `e2e/library-fetch.ts`, which sends every https call off the machine to the API's fake library (`@ostra/api/testing/library-fakes`), so no spec reaches a registry or skills.sh; `fakes.ts` adds the skills repos and a loopback control for the push. The routes' world seeds a library (`e2e/seed-library.ts`) and `routes.ts` names the four pages. Milestone 7's walk and contrast check pass on the four pages, their sheets, menus and popovers, and the profile editor's picker, in both themes at 1440 and 390 (`OSTRA_A11Y_ROUTES` narrows a local run).
  - **Checks:** typecheck and lint of `apps/web` and `packages/api`; the tests of `apps/web`, and of `packages/api`'s library router and isolation suite; the two browser spec files above, locally. F-145 and F-146 are `done` in `context/features.md`: every condition has its passing test, and the spec's section 9 names no live check for either.
