# 10: Core: uploads and the unsent sweep

Status: ready-for-agent
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

- [ ] Tests named for `F-148/c7`: an unsent upload is gone after 24 hours on the test clock, blobs and text with it, and a sent one stays (break-it: sweep by `createdAt` alone, and the sent case fails).
- [ ] Tests named for `F-150/c1,c3`: a `.docx` upload answers `ready` with its words and its text blob; the encrypted PDF answers `failed` with its reason and is still stored; with extraction off, `off`.
- [ ] Tests named for `F-148/c8`: a forged token, an expired one, a wrong size and a wrong digest are refused; a name with shell syntax is stored safe; no file name or content in a log line, checked by value.
- [ ] Tests named for `F-148/c3`: the blob is the project's and, once sent, the task's, on Postgres and on the fake S3 store.
- [ ] Checks for the whole repo pass (spec section 10: credentials and untrusted input).
- [ ] Committed as `✨ take uploads in core and sweep unsent ones`.

## Comments
