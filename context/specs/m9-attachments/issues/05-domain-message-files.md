# 05: Domain: message files, the limits and the image decision

Status: done
Builder: core
Blocked by: 01, 04
Features: F-148, F-150
Packages: `packages/domain`, `docs/configuration.md`, `context/domain-model.md`
Spec: `../spec.md`, sections 4, 5.4 and 5.6; ADR 0070

## What to build

- **Detection:** `fileKindOf(bytes, name)` as section 5.4 says, from the bytes alone; the browser's type is never read.
- **Names and places:** `boxPathFor(origin, seq, names)` on the protocol's `safeFileName`, deduplicating within a folder (`name (2).ext`).
- **Limits:** `checkMessageFiles` and `checkTicketFiles`, each returning what's kept and what's left out with its reason (`too-big`, `too-many`, `total-too-big`).
- **The image decision:** `modelImageInput(model)` and `promptImagesFor(files, { agentTakesImages, modelImageInput })`, as section 5.4 says. `agentTakesImages` is the session's adapter's `promptImages`.
- **The upload token:** `createPanelFileTokens`, beside `panel-blob-token.ts`, with its prefix added to the log guard's redactions.
- **Lifecycles:** a member's file, a ticket's file and a file's text, each a discriminated union with exhaustive tests; drawn in `context/domain-model.md`.
- **Use cases:**
  - `recordUpload` (the row core's endpoint writes, ticket 10) and `discardUpload` (the member's own `uploaded` file only; the blobs go with it);
  - `bindMessageFilesInTx`, which takes only the sender's own `uploaded` files of that project, checks the limits again, sets each one's task, message, position and `boxPath`, makes its blob and its text's blob the task's (`Blob.taskId`, so they follow the task's retention), decides `asImage`, flips it to `sent`, and returns the event's `files`, `filesLeftOut` and `imagesNotSent` and the steer's `files` and `images`;
  - `createPromptTask`, `sendMemberMessageInTx` and `reopenTask` gain `fileIds`, allow empty text when files come, and call it in their own transaction, writing the fields into the `user.message` they write;
  - `taskSpecFilesOf(tx, taskId)`: every `sent` file of the task with its blob and text, oldest first, within `taskFilesMax` and `taskFilesTotalBytes`.
- **Jobs:** `files.sweep-unsent`, its payload and key (`jobs.ts`).
- **Settings:** the seven of section 5.6 in `settings.ts`, each validated with its ceiling, and each with its line in `docs/configuration.md`'s server table.

## Done when

- [x] Tests named for `F-148/c2`: each limit leaves out what's over with its reason, at the defaults and at other settings; another member's upload, another project's and a `sent` one can't be bound (break-it: skip the owner check, and its case fails).
- [x] Tests named for `F-148/c1`: a message with files and no text is written; one with neither is refused.
- [x] Tests named for `F-148/c5`: the decision for each mix of agent, model input (`yes`, `no`, `unknown`, an admin's override) and image size and count; `imagesNotSent` says which.
- [x] Tests named for `F-148/c8`: detection ignores a lying name and type (a PNG named `.exe`, a script named `.png`); an SVG is a file; names with shell syntax and `..` become safe places.
- [x] Tests named for `F-150/c4`: with `OSTRA_FILE_TEXT_EXTRACTION=false`, a document's text state is `off`.
- [x] Every lifecycle's transitions, exhaustively. The settings' defaults and ceilings.
- [x] Checks for `packages/domain` and its direct consumers (`packages/api`, `apps/core`) pass (spec section 10).
- [x] Committed as `✨ add message files to the domain`.

## Comments

- 2026-11-21, core: built as `✨ add message files to the domain`, on tickets 01 and 04. Readings and differences:
  - **Where:** `packages/domain/src/files/` (`detect.ts`, `places.ts`, `limits.ts`, `images.ts`, `panel-file-token.ts`, `message-files.ts`) and `src/lifecycles/m9-files.ts`; the use cases' tests that need a database are in `packages/api/src/files/message-files.test.ts` (the domain has no database harness), the pure ones in `packages/domain/src/files/files.test.ts`.
  - **Detection** is async (`fileKindOf(bytes, name)` and `fileTypeOf(bytes)`): the repo's rule wants Node's async APIs, and a `.docx`'s `[Content_Types].xml` is inflated with `zlib`'s `inflateRaw`, read by the zip's central directory with every bound checked, at most 256 KiB inflated and 5,000 entries; an encrypted, zip64 or damaged zip is a file. `fileKindOf` also gives the safe name, the detected type's extension added when the name has none (`screenshot` → `screenshot.png`); the name never decides the kind. An SVG is told by its start (`<?xml`, comments, a DOCTYPE, then `<svg`), so it's a file, not text.
  - **Places:** `boxPathFor(origin, seq, names, taken?)`; names are unique in a folder without case (Windows' and macOS's disks), `name (2).ext` cut in its stem to fit 124; `taken` holds the ticket folder's earlier names (ticket 06's later reads).
  - **Limits:** `checkMessageFiles` and `checkTicketFiles` take files in order: over one file's size is `too-big`, past the count `too-many`, past the total `total-too-big`; a ticket's file of unknown size counts toward the number only.
  - **The image decision:** the model first: a model that doesn't (or isn't known to) see images gives `imagesNotSent: "model"` whatever the agent; then the agent (`agent`). `modelInputModalities(model)` gives the spec's `agent.inputModalities` (the catalog's known words, `text` always, `image` as the admin says).
  - **The upload token:** `createPanelFileTokens`, prefix `ostra-panel-file-`, under the `ostra-panel-` the logger already redacts (a test shows it), so the adapter SDK's logger needs no change; `PANEL_FILE_PATH` is `/panel/v1/files`.
  - **Binding:** `bindMessageFilesInTx` refuses the whole message (`file-not-found`) when any ID isn't the sender's own unsent upload in the task's project, binds nothing then, and its callers check the uploads (`uploadsOfInTx`) before they write anything, so a refusal never leaves half a start. A file over a limit stays an upload (the sweep takes it). The message's number comes first: `appendServerEventNumbered` takes it under the task row's lock and builds the event with the files bound to `attachments/<n>/`; `appendMemberMessageInTx` wraps it for each writer.
  - **The use cases:** `createPromptTask` (and `startTask`, `fileIds` on its input), `reopenTask` and `sendMemberMessageInTx` take `fileIds`; files alone make a message (`prompt-required` and `text-required` when neither). A task started from files alone is titled by its first file's name. `sendMemberMessageInTx` puts the files in the steer and refuses `runner-needs-upgrade` for a box whose runner is below minor 8 (`canSendFiles`), before it writes anything; the provider-change restart and the held turn carry the files too. `unansweredMessagesInTx` carries a message's files (`files`, and the event's for its replay), and a message of files alone is owed. The new refusals are in the API's maps (`file-not-found`, `prompt-required`: `BAD_REQUEST`; `runner-needs-upgrade`: `PRECONDITION_FAILED`).
  - **Settings:** the seven, each with its ceiling (`runnerLimits`'); a file's limit is never past `OSTRA_BLOB_MAX_MIB`; `OSTRA_TICKET_FILES_MAX` may be `0` (fetch none), the message's may not. Resolved as `settings.files`.
  - **Jobs:** `files.sweep-unsent`, an hourly pg-boss schedule (`FILES_SWEEP_CRON`), payload `{}` and key `files:sweep-unsent`, as the other sweeps; `UNSENT_UPLOAD_TTL_MS` is the day. Its worker is ticket 10's.
  - **Not here:** core's endpoint (`recordUpload`'s caller) and the sweep's worker (ticket 10), the spec's `files` and `promptFiles` in the dispatch (`taskSpecFilesOf` is ready for ticket 11), and `tasks.send`'s own transaction (ticket 14).
  - **Checks:** typecheck, lint and tests of `packages/domain` and its dependents (`packages/api`, `apps/core`, `packages/jobs`, `apps/web`).
