# 11: Core: search entries and their backfill

Status: resolved
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

- [x] Tests named `it("F-080: ...")` find a task by ticket, by repo, by member, by state and by a word in a message, a command and a path, each with a near miss that must not match; a hidden project's task and another organization's are never returned, ranked or counted; the backfill run twice writes each entry once.
- [x] Break-it: the visible-projects filter dropped fails the access test; recorded in `context/proof/F-080.md`.
- [x] A query with 10,000 tasks' entries answers within 300 ms on the dev database, measured and recorded in `## Comments` *(working value)*.
- [x] Committed as `✨ add search entries at ingest`.

## Comments

- 2026-11-19: `packages/domain/src/search/entries.ts` (the entries, their 8 KiB cut, a tool call's input as text, the backfill) and `query.ts` (`searchTasks`, one statement, bound parameters only). The writers: `ingestEvents` after its `createMany`, `appendServerEvent` (every member message, whichever writer), `createPromptTask` and `startTaskFromTicket` (title, prompt, ticket key and title), the PR opener (its title, on its repo), and the ticket cache (a new title updates its tasks' entries). Postgres reads a path as one token, so a tool call's entry gets a last line with each path's segments and dotted parts as words ("schema.prisma" and "prisma" both find `packages/db/prisma/schema.prisma`), and the prefix word may hold `.` and `-`. `searchTasks` takes two optional filters beside the signature's, a project and a period, and returns each task's rank and up to three snippets as parts (text, never HTML), with the entry's kind and its event's sequence. `search.backfill` runs per task in batches of 500; core's boot enqueues it for each task with no entry yet, so it runs once per task; its progress is its log line (IDs and counts). The setting `OSTRA_SEARCH_ENTRY_MAX_KIB` keeps its default: the column holds 8 KiB, and the writers cut at that. **Measured:** 10,000 tasks in one project with 60,000 entries, on the embedded Postgres the dev stack runs: a common word (2,000 matching tasks) 63 ms median, a prefix 54 ms, two words 59 ms, a rare word 5 ms, filters only 6 ms (six runs each, limit 20). The first version, which made every matching task's snippets before the limit, took 270 ms; the query now picks the top tasks first. Commit: 693b6d7.
