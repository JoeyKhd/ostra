# 12: Core: a ticket's files, its changes and Retry

Status: ready-for-agent
Builder: core
Blocked by: 06, 07, 10, 11
Features: F-149, F-150
Packages: `apps/core/src/tracker/` (`context.ts`, the new `ticket.read-changes` handler), `apps/core/src/linear/agent-mode/` (the follow-up), `apps/core/src/dispatch/restore-spec.ts`
Spec: `../spec.md`, sections 4 and 5.4; ADR 0070

## What to build

- **`ticket.fetch-context`** (F-064's job) becomes round 1 of `readTicketForTask`:
  - reads the context through the adapter, as now, and the files with `ticketFilesToFetch`;
  - fetches each with `downloadFile` and the ticket's per-file cap, stores it as a `ticket-file` blob of the task, tells its kind, reads a document's text with ticket 07's pool, and writes its `MessageFile` (`origin: ticket`), `left_out` and `failed` ones with their reasons and no blob;
  - renders the prompt with the changed template, and in one transaction writes it, the first `user.message` with its files (each at `ticket/<name>`), `ticket.context_read` (round 1, reason `start`), the `TaskTicketRead`, and `task.dispatch`.
  A retry of the job after a partial run reuses the files it already stored, as today's images are reused. A tracker that doesn't answer retries the job, as now.
- **`ticket.read-changes`:** the handler for a reopen, a member's press and Retry, calling `readTicketForTask` with its reason. For a reopen whose tracker doesn't answer after the job's tries, it dispatches without the changes, and the thread's line says the ticket couldn't be read.
- **F-064's old path** (`contextFiles` under the session's `.ostra/ticket/`) stays only for a task whose first prompt was rendered before this ticket: `restore-spec.ts` keeps sending its `ticket-file` blobs as `contextFiles` when the task has no `MessageFile`.
- **The follow-up** (`linear.agent-event`'s `prompted`): the comment's files from `filesInText`, fetched as above, bound to the follow-up's message.
- **An adapter that declares `none`:** its tasks start from the text, and `ticket.context_read` notes `not-fetched`, which the task page shows.

## Done when

- [ ] Tests named for `F-149/c1,c2`: against the fake Linear, a ticket's inline image, linked `.docx`, attached PDF and comment's `.xlsx` become the first message's files, written to the task's blobs; the Figma link is in `links`, not fetched; no request carried the token off Linear's file host.
- [ ] Tests named for `F-149/c3`: a 22-file ticket gives 20, names the one over 10 MiB and the one past the limit; a failed download is named and the task dispatches; Retry fetches it and sends it with ostra's message.
- [ ] Tests named for `F-149/c4,c5`: the files are at `ticket/<name>` in the spec, documents with their text; `ticket.context_read` holds what the agent got.
- [ ] Tests named for `F-149/c6`: with the tiny adapter (`none`), the task starts from the text and the event says `not-fetched`.
- [ ] Tests named for `F-149/c7,c8`: a reopen after a new comment and an edited description sends both; a press with nothing new sends nothing.
- [ ] Tests named for `F-149/c9`: a follow-up's screenshot reaches its message's files.
- [ ] Tests named for `F-150/c1`: a ticket's `.docx` and `.pdf` have their text beside them in the spec.
- [ ] Checks for the whole repo pass (spec section 10: credentials and untrusted input).
- [ ] Committed as `✨ give the agent every file of its ticket`.

## Comments
