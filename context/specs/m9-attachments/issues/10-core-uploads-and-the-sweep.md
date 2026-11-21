# 10: Core: uploads and the unsent sweep

Status: done
Builder: core
Blocked by: 05, 07
Features: F-148, F-150
Packages: `apps/core/src/blobs/` (the panel's endpoints), `apps/core/src/files/` (new), the job's registration beside `blob.gc`'s
Spec: `../spec.md`, sections 4, 5.4 and 5.5; ADR 0070; ADR 0043

## What to build

- **`POST /panel/v1/files`:** the web app's upload, as one request body of the file's bytes, with the panel's file token (ticket 05) in its header naming the organization, project, member, size and SHA-256. Core:
  - verifies the token, the size and the digest against the bytes it got, and refuses anything else with a code and no content;
  - tells the kind with `fileKindOf`;
  - stores the blob (`message-file`) through the blob service, in whichever store is the default;
  - for a document, and unless `OSTRA_FILE_TEXT_EXTRACTION` is off, reads its text with ticket 07's pool and stores it (`message-file-text`);
  - writes the `MessageFile` (`recordUpload`: `uploaded`, the member's, the project's, no task), and answers `{ fileId, name, kind, contentType, size, text: { state, reason, words } }`.
  A file whose text failed is still stored and answered, with its reason.
- **The member's unsent cap:** at most twice `OSTRA_MESSAGE_FILES_MAX` unsent uploads per member and project at once *(working value)*, so the tray can't fill the store; the next is refused with its words.
- **`files.sweep-unsent`:** registered hourly; deletes every `uploaded` file older than 24 hours, its blob and its text's blob with it, marking the row `expired`. A sweep that meets a store that doesn't answer leaves the rest for the next hour.
- **Logs:** IDs, sizes, kinds and states only.

## Done when

- [x] Tests named for `F-148/c7`: an unsent upload is gone after 24 hours on the test clock, blobs and text with it, and a sent one stays (break-it: sweep by `createdAt` alone, and the sent case fails).
- [x] Tests named for `F-150/c1,c3`: a `.docx` upload answers `ready` with its words and its text blob; the encrypted PDF answers `failed` with its reason and is still stored; with extraction off, `off`.
- [x] Tests named for `F-148/c8`: a forged token, an expired one, a wrong size and a wrong digest are refused; a name with shell syntax is stored safe; no file name or content in a log line, checked by value.
- [x] Tests named for `F-148/c3`: the blob is the project's and, once sent, the task's, on Postgres and on the fake S3 store.
- [x] Checks for the whole repo pass (spec section 10: credentials and untrusted input).
- [x] Committed as `✨ take uploads in core and sweep unsent ones`.

## Comments

- 2026-11-21, core: built as `✨ take uploads in core and sweep unsent ones`, on tickets 05, 07 and 11. Readings and decisions:
  - **Where:** the endpoint is `apps/core/src/blobs/panel-file-endpoint.ts` (`handlePanelFileEndpoint`), beside the panel's blob endpoint; the step a member's upload and a ticket's file share is `apps/core/src/files/store-file.ts` (`storeFile`, and `ticketFileStore`, the domain's `TicketReadPorts.storeFile` on it, for ticket 12); the sweep is `apps/core/src/files/sweep-unsent.ts`. `core.ts` makes the one text reader of the process (`createDocumentTextReader`, closed at stop), registers the endpoint, and works and schedules `files.sweep-unsent` beside `blob.gc`. The tests are `apps/core/src/files/uploads.test.ts`, over HTTP on a real database, both blob stores (the fake S3 server for S3) and the real text reader.
  - **The request:** `POST /panel/v1/files`, the body the file's bytes, `Authorization: Bearer <the file token>`, and the member's name for the file percent-encoded in `x-ostra-file-name` (`PANEL_FILE_NAME_HEADER`; missing, the name is `file` with the detected extension). The name is never in a URL and never logged; `fileKindOf` makes it safe.
  - **The answer:** `panelFileResponseSchema` (domain): `{ fileId, name, kind, contentType, size, text: { state, reason, words } }`, `reason` the reader's code for `failed`, `words` for `ready`; `recordUpload`'s answer gained `reason`. A refusal is `panelFileErrorSchema`, `{ error: { code, message } }`, no content: `unauthorized` 401 (no token, forged, or past its minute), `empty` 400, `too-large` 413 (a token for more than `OSTRA_MESSAGE_FILE_MAX_MIB`, or over the blob cap), `not-found` 404 (the project or the member isn't the organization's), `too-many-unsent` 409, `size-mismatch` 400, `digest-mismatch` 400, `bad-request` 400 (a body that didn't arrive, a name header that doesn't decode), `unavailable` 503 (the store didn't answer: nothing is kept).
  - **The unsent cap:** `unsentUploadsMax` is twice `OSTRA_MESSAGE_FILES_MAX` a member and project. Core counts before it reads the body, and again in the transaction that records the file, under an advisory lock on the member and project (`recordUploadWithinCapInTx`), so uploads at once can't pass it; a refused one's blobs are deleted. `unsentUploadsOfInTx` is there for ticket 14's own check.
  - **The project's blobs:** the blob service now takes a blob of a project with no task (`BlobScopeOwner`'s `projectId`, and the built-in store's rows bound to a project), so an upload's blob and its text's carry the project from the start, on both stores; ticket 05's bind makes them the task's at send.
  - **Text:** a document is read before the answer; a text the store refuses drops the file's blob too and the upload answers `unavailable`, and a text over the blob cap is `failed` with `too-big`.
  - **The sweep:** it marks every member's `uploaded` file with no task and older than `UNSENT_UPLOAD_TTL_MS` `expired` first (guarded on the state, so a send a moment before keeps its file, and an expired one can't be sent), then deletes each expired file's blob and text blob, page by page by ID, at most 2,000 files a pass *(working value)*. The first delete a store refuses ends the pass: those files stay `expired` with their blobs named, and the next hour deletes them. The row stays as the record, its blob columns cleared by their foreign keys. A ticket's file and a sent one are the task's, and go only with it.
  - **Fixed in ticket 07's pool:** a Node `Buffer` (the body core reads) couldn't be moved to a worker (`DataCloneError`: a small `Buffer`'s `slice` is a view on Node's shared pool), so every upload's text was `busy`. The pool copies the bytes into a fresh buffer; `pool.test.ts` has the case.
  - **The keys:** the extraction-off case is named `F-150/c4`, the switch's condition, though the box lists it with c1 and c3; the cap's and a refusing store's cases are named `F-148`. No break-it ran (AGENT-RULES): the sent file's case is a real assertion, which a sweep by `createdAt` alone fails.
  - **For ticket 14:** the route checks the member, the project, the size and the cap first, as section 4 says; its call to core must wait for a document's text (30 s a file and 30 s for a worker at most, the pool's working values).
  - **Checks:** the whole repo's typecheck and lint; the tests of `packages/domain`, `apps/core` and `packages/api`.
