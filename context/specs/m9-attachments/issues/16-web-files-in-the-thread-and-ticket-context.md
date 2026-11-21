# 16: Web: files in the thread, the ticket's context and a model's image input

Status: ready-for-agent
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

- [ ] The targets are approved, recorded under `## Comments` with the date and the maintainer's words.
- [ ] Tests named for `F-148/c3`: a message's thumbnails open the viewer, its chips download, after a reload and on a reopened task on a fresh box.
- [ ] Tests named for `F-148/c5`: the model's line under a message whose images went as files.
- [ ] Tests named for `F-149/c5`: "What the agent got" shows the description, files, links and comments of the fake ticket.
- [ ] Tests named for `F-149/c3,c6,c8`: left out and failed with Retry; the `none` line; Send ticket updates and its "nothing new".
- [ ] Tests named for `F-150/c1`: "text extracted" under a `.pdf`'s chip in the thread.
- [ ] A Playwright spec (run once at the milestone's end) over a ticket task's first message and a message with files.
- [ ] Screenshots at 1440 px and 390 px, both themes, compared with the targets, under `## Comments`.
- [ ] Checks for `apps/web` pass (spec section 10).
- [ ] Committed as `✨ show a task's files and what the agent got`.

## Comments
