# 12: Core: a ticket's files, its changes and Retry

Status: done
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

- [x] Tests named for `F-149/c1,c2`: against the fake Linear, a ticket's inline image, linked `.docx`, attached PDF and comment's `.xlsx` become the first message's files, written to the task's blobs; the Figma link is in `links`, not fetched; no request carried the token off Linear's file host.
- [x] Tests named for `F-149/c3`: a 22-file ticket gives 20, names the one over 10 MiB and the one past the limit; a failed download is named and the task dispatches; Retry fetches it and sends it with ostra's message.
- [x] Tests named for `F-149/c4,c5`: the files are at `ticket/<name>` in the spec, documents with their text; `ticket.context_read` holds what the agent got.
- [x] Tests named for `F-149/c6`: with the tiny adapter (`none`), the task starts from the text and the event says `not-fetched`.
- [x] Tests named for `F-149/c7,c8`: a reopen after a new comment and an edited description sends both; a press with nothing new sends nothing.
- [x] Tests named for `F-149/c9`: a follow-up's screenshot reaches its message's files.
- [x] Tests named for `F-150/c1`: a ticket's `.docx` and `.pdf` have their text beside them in the spec.
- [x] Checks for the whole repo pass (spec section 10: credentials and untrusted input).
- [x] Committed as `✨ give the agent every file of its ticket`.

## Comments

- 2026-11-21, core: committed as `✨ give the agent every file of its ticket`, on tickets 06, 07, 10, 11 and 13. Readings and differences:
  - **Where:** core's ports for the domain's reads (`readTicket`, `downloadFile`, `storeFile`), `ownWritesOf` and `fetchFollowUpFiles` are `apps/core/src/tracker/ticket-reads.ts`; the start is `context.ts`; the new job is `read-changes.ts`, registered in `core.ts`. Each file is stored by ticket 10's `ticketFileStore` (`apps/core/src/files/store-file.ts`) through core's one text reader (`documentText`). The domain's `read-ticket.ts` gains `fetchTicketFiles` (the fetch every read and a follow-up share), `writeTicketStartInTx` (round 1's transaction) and `ticketFilesLeftOutLines`.
  - **Limits as a file downloads:** Linear gives no file's size, so a file is held to what's left of the ticket's limits as it downloads; one over a file's size (`too-big`) or the total (`total-too-big`) takes none of the count's places, and a failed download keeps its place. A 22-file ticket with one of 12 MiB and one failing download gives 20 places: 19 in the box and the failed one, the 12 MiB one `too-big`, the last `too-many`.
  - **The prompt names what the agent doesn't have** (left out and failed, with `fileLeftOutWords`) under "## The ticket's files you don't have", since the runner's block names only the files it got; a ticket update carries the same lines. A tracker that fetches none (`none`) adds "ostra doesn't fetch this tracker's files: you have the ticket's text only."
  - **Protocol, additive and server-only:** `ticket.context_read` gains `filesNotFetched: true` (the tracker's `ticketFiles` is `none`: the tiny adapter has no file to name `not-fetched`) and `unreadable: true` (spec section 5.1 now says so; fixtures `filesNotFetchedRead` and `unreadableRead`). Every read is a round with its event, so the panel gets its answer: nothing new is the protocol's `noChangeRead` shape (every list empty, `description: null`); a tracker that doesn't answer retries the job, and on its last try (`lastTry`, from the job's `retryCount`), or at once for a ticket or connection that's gone, the round is `unreadable` (its record the last one again) and a reopen dispatches without the changes.
  - **The reopen switch is on:** `reopenTask` sends `ticket.read-changes` for a code ticket task unless `readTicketChanges: false`. `sendMemberMessageInTx` now passes a follow-up's files on to the reopen it makes.
  - **The template:** the built-in one drops `## Images` and gains `## Links` (`{{#links}}`, the link attachments' title and URL, both marked as the ticket's text, never fetched); the editor's help lists `{{#links}}`. A project's own `{{#images}}` gets `.ostra/ticket/<name>`.
  - **ostra's own writes:** core now passes `OwnWrites` to `getTicketContext` (its app user, the progress and parent comments' markers, and a draft's attachment marker, `DRAFT_ATTACHMENT_MARKER`), so their files are `byOstra` and left out.
  - **Images at the start** are decided for the profile's model, since the dispatch writes the session's model after the start's read.
  - **An outside start** (F-012, no creator) has no member's message: its files are bound under the read's own number (`ticket-start-<taskId>`), and the spec's `promptFiles` falls back to the start's `ticket.context_read` (`files-spec.ts`).
  - **A retry after a partial run** takes again a blob of the task with the same purpose and bytes that no file holds yet, a file's and its text's alike (`blobsOnce`, around the blob store ticket 10's step writes to): it downloads again, and stores nothing twice.
  - **F-064's old path:** `contextFiles` only for a task with no `start` round, and only its `ticket-file` blobs no message file holds.
  - **The dev stack's fake Linear:** with `OSTRA_LINEAR_API_URL` set, its origin is a file host too (as the token already goes to it), so the scripted demo's ticket files come from the fake.
  - **The follow-up:** its files are fetched only once the sender matched a member; on a runner below minor 8 it goes with its words alone, as before.
  - **Tests:** `apps/core/src/tracker/ticket-files.test.ts` (the fake Linear through core's shipped adapter, a recording host for every other origin, the tiny tracker, which `@ostra/adapter-sdk/testing` now exports): `F-149/c1,c2`, `c3` (twice: the limits, failure and Retry; the partial run), `c4,c5`, `c6`, `c7` (twice: the changes; the unreadable last try), `c8`, `F-150/c1`; `F-149/c9` in `agent-mode.test.ts`; `context.test.ts`'s F-064 cases moved to message files, with the old path's; the template's in `milestone-2.test.ts`; the protocol's markers in `minor-8.test.ts`.
  - **Checks:** the whole repo's typecheck and lint; tests of `packages/protocol`, `packages/domain`, `packages/api`, `apps/core` and the web's template editor.
