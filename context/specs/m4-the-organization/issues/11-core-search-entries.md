# 11: Core: search entries and their backfill

Status: ready-for-agent
Builder: core
Blocked by: 06
Features: F-080
Packages: `apps/core` (`src/ingest/`), `packages/domain` (`writeSearchEntries`, `searchTasks`, the store), `packages/api` (the task and message writers)
Spec: `../spec.md`, section 4 ("Search"); ADR 0054

## What to build

- **At ingest:** in the transaction that stores them, each `user.message`, `agent.message` and `tool.called` writes its `SearchEntry` (a tool call's title and its input as text: the command and folder, the paths, the URL), cut at 8 KiB with the cut marked. A task's creation writes its title, prompt and ticket key and title; a PR's opening writes its title. Thoughts, tool output and partial text write nothing.
- **The query** (`searchTasks`): one SQL statement with bound parameters only, filtering by organization, the member's visible projects (from `visibleProjects`), and the filters as columns (project, repo, ticket key, member, task state, period); text through `websearch_to_tsquery('simple', …)` with the last word as a prefix; grouped by task, ranked by the best `ts_rank`, the top three `ts_headline` snippets per task with the entry kind and its event's sequence. A query that is only filters and no text lists tasks by recency.
- **`search.backfill`:** a job, in batches of 500 events, idempotent by `(taskId, eventSeq, kind)`, enqueued once by the migration's first boot, with its progress in the job's state.
- **Ticket text** stays as it is in the ticket cache; a ticket's new title updates its entry.

## Done when

- [ ] Tests named `it("F-080: ...")` find a task by ticket, by repo, by member, by state and by a word in a message, a command and a path, each with a near miss that must not match; a hidden project's task and another organization's are never returned, ranked or counted; the backfill run twice writes each entry once.
- [ ] Break-it: the visible-projects filter dropped fails the access test; recorded in `context/proof/F-080.md`.
- [ ] A query with 10,000 tasks' entries answers within 300 ms on the dev database, measured and recorded in `## Comments` *(working value)*.
- [ ] Committed as `✨ add search entries at ingest`.

## Comments
