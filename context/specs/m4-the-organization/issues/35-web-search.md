# 35: Web: search

Status: resolved
Builder: web
Blocked by: 26, 31
Features: F-080
Packages: `apps/web` (`src/components/search-palette.tsx`, `src/app/(panel)/search/`)
Spec: `../spec.md`, sections 3 (step 11) and 12; targets `search-palette`, `search`

## What to build

- **The palette** to the `search-palette` target: Ctrl+K or ⌘K on every panel page, and a search field in the top bar that opens it; filter tokens as chips; the top results from `search.suggest` with their snippets (matches marked); arrows, Enter, Escape; "See all results".
- **The search page** (`/search?q=…`) to `search`: the query, the filters as controls kept in the URL, results as tasks with snippets linking to the matched event in the thread, and the empty state.
- **Snippets are text,** never HTML from the server: the API returns ranges to mark, and the panel renders them as React text.

## Done when

- [x] Playwright, named `it("F-080: ...")`: the palette opens with the keys, finds a task by a word from its agent message, filters by `repo:`, and Enter opens the task at the matched event; the page's filters round-trip through the URL.
- [x] Each screen checked by eye against its target, dark and light, at 1440 px and phone width.
- [x] Committed as `✨ add search to the panel`.

## Decided 2026-11-19

Settled by the target's recommendation, on the maintainer's delegation (ticket 42, step 5); the maintainer may reopen any.

- **Search stays in the sidebar** (`search-palette.md`, open point 1): the sidebar's search box, as `app-design.md` and every approved picture draw it, opens the palette; the top bar's field of this ticket is a second way in to the same palette.
- **`status:` values** (open point 2): hyphenated and snake case alike (ticket 26).

## Comments

- 2026-11-20, builder: the palette (`components/search-palette.tsx`, one per page in the app shell) on Ctrl+K or ⌘K, the sidebar's box and a new top-bar field on every page; tokens become chips and Backspace turns the last back into text, a key with no value lists its values, results from `search.suggest` with marked snippets, `See all` and the pages as `Go to`. `/search` (`components/search/`): the query, its filters as controls in the URL (a typed token moves into its control), results with snippets, the panel with every match, and the empty state's illustration. Snippets are React text and `mark` elements from the API's parts, never HTML. A result opens `/tasks/[id]?event={seq}`, and the thread scrolls to and marks the message holding that event (`apps/web/src/task/task-thread.tsx`). Proved in `apps/web/e2e/13-search.spec.ts` and `components/search/search-query.test.ts`; break-its in `context/proof/F-080.md`.
- 2026-11-20, builder, by-eye check at 1440 px and Pixel 7 width (the finals are `m4-<screen>-final.png` and `m4-<screen>-phone-final.png` in the builder's scratchpad `ui-check` folder). The panel has no light theme yet (`apps/web/src/app/globals.css` leaves it for later), so each screen was checked dark only. Differences left, for want of data in `search.suggest` and `search.tasks`: the palette has no `Recent` section with an empty query (it lists the pages) and no age column; `repo:` and `ticket:` offer no values; the page's State filter takes one state, it shows the first 100 results, and the panel has no Repo, Driver, PR or Updated rows. The one-line snippets cut their text before the first match so the match shows.
- 2026-11-20, builder: the app shell's commit also carries the sidebar rows of tickets 32 to 34 (Members, Audit log, the Instance group) and the panel's message keys for all four tickets, since the palette moved into the shell that those rows share.
