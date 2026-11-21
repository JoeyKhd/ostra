# 14: API: uploads, sending with files, downloads and the ticket's context

Status: ready-for-agent
Builder: api
Blocked by: 10, 11, 12
Features: F-148, F-149, F-150
Packages: `packages/api`, `apps/web/src/app/api/projects/[project-id]/files/` and `apps/web/src/app/api/tasks/[task-id]/files/[file-id]/` (the route handlers, new), `packages/task-view` (folding files into a message), the isolation matrices
Spec: `../spec.md`, sections 4 and 5; ADR 0070

## What to build

- **The upload route** (`POST /api/projects/<projectId>/files`, `FormData` with `file` and an optional `taskId`): a signed-in member who can open the project, and, with a task, may send on it (the driver, or a reopen's sender); the size against `OSTRA_MESSAGE_FILE_MAX_MIB` before reading on (a declared `content-length` over it is refused at once); the SHA-256; then core's `POST /panel/v1/files` with the file token. It answers core's view. An empty file, a refusal and a core out of reach each answer their words (the box's notes, ticket 15).
- **`files.discard({ fileId })`:** the member's own unsent upload.
- **`files.limits`:** the three message limits, for the box.
- **Sending:** `tasks.create`, `tasks.send` and `tasks.reopen` take `fileIds` (at most `OSTRA_MESSAGE_FILES_MAX`), and text may be empty when files come. `tasks.send`'s own transaction calls `bindMessageFilesInTx` and puts the files on the steer it enqueues; `runner-needs-upgrade` is `PRECONDITION_FAILED` with the box's words.
- **The download route** (`GET /api/tasks/<taskId>/files/<fileId>`), after the member's project access: through core's blob read (`coreBlobReader`), with the headers of section 5 of ADR 0070: an image's detected type (never SVG), `application/octet-stream` otherwise, `Content-Disposition: attachment` with the safe name (`filename` and `filename*`), `nosniff`, `default-src 'none'; sandbox`, `same-origin`, `private, no-store`; the same 404 for another organization, a restricted project, another task's file and an unknown one.
- **The thread:** `tasks.history` and the live stream fold `user.message`'s `files`, `filesLeftOut` and `imagesNotSent`, and the runner's `files.written`, into the message (`packages/task-view`), each file with its `downloadPath`.
- **The model's image input:** `tasks.get` and the new-task page's profile and runner query gain `model.imageInput` (`yes`, `no`, `unknown`) and the model's name, for the box's note. The providers router lists each model's catalog image input and `adminImageInput`, and `providers.setModelImageInput` lets an organization admin set or clear it, with an audit entry.
- **The ticket's context:** `tasks.ticketContext` gives each `ticket.context_read` round (what the agent got, left out and failed); `tasks.ticketUpdates` and `tasks.retryTicketFiles`, for the driver, enqueue the job and answer at once; the answer of "nothing new" comes as the round's event.
- **Access:** every procedure checks the organization and the project's access. Milestone 4's write matrix and query matrix get a row for each.

## Done when

- [ ] Tests named for `F-148/c1`: a message with files and no words is sent; files sent with `create`, `send` (queue and interrupt) and `reopen`; a file another member uploaded can't be sent.
- [ ] Tests named for `F-148/c2`: an upload over the per-file limit is refused before core is asked; a send over a limit leaves out what's over and the thread's message says so.
- [ ] Tests named for `F-148/c3`: the download's headers for a PNG, an SVG, a `.docx` and a `.html`; the same 404 for each outsider case (break-it: serve the stored type, and the `.html` case fails).
- [ ] Tests named for `F-148/c5`: `model.imageInput` for each case, and an admin's override changing it; a member who isn't an admin can't set it.
- [ ] Tests named for `F-148/c9`: a send with files to a minor-7 runner's session is refused with the box's words.
- [ ] Tests named for `F-149/c3,c5,c8`: `ticketContext` shows the rounds; Retry and Send ticket updates by the driver only.
- [ ] Tests named for `F-150/c1`: a document's file view says `text: ready` with its words.
- [ ] The isolation matrices' new rows pass.
- [ ] Checks for `packages/api` and `apps/web`'s typecheck and lint pass (spec section 10).
- [ ] Committed as `✨ add file uploads, sends and downloads`.

## Comments
