# 26: API: search

Status: resolved
Builder: api
Blocked by: 11
Features: F-080
Packages: `packages/api` (`src/routers/search.ts` (new))
Spec: `../spec.md`, section 4 ("Search"); ADR 0054

## What to build

- **`search.tasks`** (any member): a query string and filters. The string's tokens `repo:`, `project:`, `ticket:`, `status:`, `by:`, `after:` and `before:` become filters (a strict parser with its own tests; an unknown token stays text), and the rest is text. Calls ticket 11's `searchTasks` with the member's scope. Returns tasks with their project, state, key, title, the snippets with what matched and the event's sequence to link to, and a total count.
- **`search.suggest`** for the palette: the top 8, with the same access, within 150 ms on the dev database *(working value)*, debounced by the panel.
- **No search text in a log line;** a query's length and the result count may be logged.

## Done when

- [x] Tests named `it("F-080: ...")`: each filter token; text with a prefix match; results only from visible projects of the active organization, for a member, a project member of a restricted project and an organization admin; a hidden task's text never appears in a snippet or a count.
- [x] Committed as `✨ add search`.

## Decided 2026-11-19

Settled by the target's recommendation, on the maintainer's delegation (ticket 42, step 5); the maintainer may reopen any.

- **`status:` values** (`search-palette.md`, open point 2): the parser accepts the task list's words hyphenated (`in-review`, `needs-you`) and in snake case (`in_review`, `needs_you`) alike; the panel writes the hyphenated form.

## Comments

- 2026-11-19: `search.tasks` and `search.suggest` (`packages/api/src/routers/search.ts`) over ticket 11's `searchTasks`, with the query's tokens parsed by `packages/api/src/search/parse-query.ts`. `repo:` takes a full name or the repo's name, `project:` a slug or a name, `by:` a username or `me`, `after:` the day after the date and `before:` the day itself (UTC); a name that matches nothing the member can see finds nothing. The total is the count of matching tasks up to 100 (`totalCapped` past it). Log lines carry the query's length and the count only. Tests: `packages/api/src/routers/search.test.ts` (5) and `src/search/parse-query.test.ts` (2); break-its in `context/proof/F-080.md`. The palette's 150 ms on the dev database is ticket 35's to measure with the panel; here a suggestion answered within 2 s in the test database. Committed as `✨ add search`; checks: typecheck, lint and the two test files of `packages/api`, then the whole-repo checks before the push.
- 2026-11-19: the commit is cf4d54fe (`✨ add search`). Whole-repo typecheck, lint, test, `check:licenses` and `check:proof` were green through turbo before the push.
