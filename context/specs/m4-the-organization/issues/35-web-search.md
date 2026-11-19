# 35: Web: search

Status: ready-for-agent
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

- [ ] Playwright, named `it("F-080: ...")`: the palette opens with the keys, finds a task by a word from its agent message, filters by `repo:`, and Enter opens the task at the matched event; the page's filters round-trip through the URL.
- [ ] Each screen checked by eye against its target, dark and light, at 1440 px and phone width.
- [ ] Committed as `✨ add search to the panel`.

## Comments
