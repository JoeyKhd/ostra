# 16: Web: files in the thread, the ticket's context and a model's image input

Status: done
Builder: web
Blocked by: 14; the targets in `context/brand/app-targets/m9/` approved by the maintainer (being made now by a design agent, in the `m9-targets` worktree)
Features: F-148, F-149, F-150
Packages: `apps/web` (`src/task/` the thread's `MessageView` and renderers, `src/components/tasks/attachments/`, `src/components/tasks/task-ticket.tsx`, the provider's models page), `apps/web/messages/`
Spec: `../spec.md`, sections 1, 4 and 13; ADR 0070
Targets: `context/brand/app-targets/m9/message-attachments.md` (with `message-attachments-viewer`) and `ticket-context.md` (with `ticket-context-skipped` and `ticket-context-failed`)

## What to build

Built to the approved targets, at their sizes, in both themes and at the phone width. Their build specs hold the layout, the states and the words.

- **A member's message with files:** the images in milestone 8's strip opening its viewer (titled as the target says), the other files as chips that download from `GET /api/tasks/<taskId>/files/<fileId>`, "text extracted" with its tooltip, the model's line when images went as files (`imagesNotSent`), and a note for what was left out or skipped (`filesLeftOut`, `files.written`'s skips).
- **The properties panel's `Attachments` group,** for captures and files together, as the target draws it.
- **"What the agent got":** a ticket task's first message from `tasks.ticketContext`'s first round: the description, the files, the links ("Link · not fetched"), the comments, the box's place and "Show the prompt"; left out and failed files with their reasons, and Retry (`tasks.retryTicketFiles`) for the driver. An adapter that declared `none` shows "The ticket's files weren't fetched: {tracker} doesn't offer them."
- **A `ticket-update` message:** its marker, its text (the changes) and its files; the ticket card's "Send ticket updates" (`tasks.ticketUpdates`) for the driver, and its "Nothing new on the ticket since the agent read it."
- **The provider's models:** each model's image input from the catalog, and the organization admin's "Reads images" switch (`providers.setModelImageInput`), built against the provider page as it is, listed in `## Comments` as the screen's change.
- **The thread's old `Ticket files ready` row** goes for tasks with `MessageFile`s, as the target says; tasks started before keep it.
- **Messages:** every word in `apps/web/messages/`. The keyboard walk and contrast check stay green on the task page.

## Done when

- [x] The targets are approved, recorded under `## Comments` with the date and the maintainer's words.
- [x] Tests named for `F-148/c3`: a message's thumbnails open the viewer, its chips download, after a reload and on a reopened task on a fresh box.
- [x] Tests named for `F-148/c5`: the model's line under a message whose images went as files.
- [x] Tests named for `F-149/c5`: "What the agent got" shows the description, files, links and comments of the fake ticket.
- [x] Tests named for `F-149/c3,c6,c8`: left out and failed with Retry; the `none` line; Send ticket updates and its "nothing new".
- [x] Tests named for `F-150/c1`: "text extracted" under a `.pdf`'s chip in the thread.
- [x] A Playwright spec (run once at the milestone's end) over a ticket task's first message and a message with files.
- [x] Screenshots at 1440 px and 390 px, both themes, compared with the targets, under `## Comments`.
- [x] Checks for `apps/web` pass (spec section 10).
- [x] Committed as `✨ show a task's files and what the agent got`.

## Comments
- 2026-11-21, lead: the maintainer approved the m9 targets ("yes to all"), recorded in `context/brand/app-targets/m9/README.md`. This ticket waits only for ticket 14 now.
- 2026-11-22, web (phase B): the thread draws the fold's `data-message-files` part under a member's message (`attachments/thread-files.tsx`): pictures in milestone 8's strip opening the viewer on `?file=` (titled `Attachments`, the ticket's `The ticket's attachments`; Copy link `messageFileLinkPath`), chips that download from `/api/tasks/<taskId>/files/<fileId>`, `text extracted` and `no text` with their tooltips, the model's line (`imagesNotSent`), what was left out and what the box couldn't save; `removedFiles` from `tasks.files` take a gone file's link away, and a message shows its files at once from the browser's copies while it sends (`OptimisticMessage.files`, `packages/task-view`). Milestone 8's viewer frame is shared (`viewer-frame.tsx`). The properties panel's one `Attachments` group counts people's files (`tasks.files`' `people`) beside the captures; milestone 8's `Widths` row went with it.
- 2026-11-22, web: "What the agent got" is a ticket task's first message, in place of its `user.message` (or at the thread's start while the ticket is read), from `tasks.ticketContext`'s first round: the description (its stored pictures open the viewer), the files in the ticket's order, given, left out with why, or failed with ostra's tries and Retry for the driver (a failed file a Retry fetched shows as given), the links not fetched, the comments, the box's place and the prompt. The Ticket group gains `Context` and, for the driver, "Send ticket updates", whose answer is the next round ("Nothing new on the ticket since the agent read it." for a round with `nothingNew`). The header's old `What the agent got` row, the phone's, and the thread's `Ticket files ready` row go for such a task and stay for one started before. A `ticket-update` message wears the intent's existing `ticket updates` mark and its files. The provider's model editor gains `Images`: the catalog's word and an admin's "Reads images" (`providers.setModelImageInput`); the screen's change is that one group under `Reasoning`.
- 2026-11-22, web: the tests. `F-148/c3`, `F-148/c5`, `F-149/c3`, `c5`, `c6`, `c8` and `F-150/c1` are `apps/web/e2e/26-attachments.spec.ts` on the real panel and core with the world `e2e/seed-files-world.ts`; a press of Retry or "Send ticket updates" is answered as core's `ticket.read-changes` job answers it (the seed's `round`), since the fake tracker isn't connected in this world (core's side is ticket 12's tests). `F-148/c3`'s "on a reopened task on a fresh box" is the runner's and core's (tickets 11 and 13); the web's part is after a reload. The pure parts have unit tests with plain names (`attachments/*.test.ts*`). The keyboard walk and the contrast check pass on the thread's files and on "What the agent got" in both themes.
- 2026-11-22, web: the screenshots at 1440 and 390 px, both themes, beside the targets: `_lead/ui-check/m9/message-attachments*.png` and `ticket-context*.png`, raw shots in `_lead/ui-check/m9/live/`; every remaining difference with its reason in `_lead/ui-check/m9/phase-a.md`, "Phase B". Phase B went as one commit for tickets 15 and 16, `✨ attach files and show what the agent got`: the task's thread (`apps/web/src/task/task-thread.tsx`) holds both the box and the files it draws.
