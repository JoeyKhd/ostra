# 26: API: search

Status: ready-for-agent
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

- [ ] Tests named `it("F-080: ...")`: each filter token; text with a prefix match; results only from visible projects of the active organization, for a member, a project member of a restricted project and an organization admin; a hidden task's text never appears in a snippet or a count.
- [ ] Committed as `✨ add search`.

## Comments
