# 05: Domain: message files, the limits and the image decision

Status: ready-for-agent
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

- [ ] Tests named for `F-148/c2`: each limit leaves out what's over with its reason, at the defaults and at other settings; another member's upload, another project's and a `sent` one can't be bound (break-it: skip the owner check, and its case fails).
- [ ] Tests named for `F-148/c1`: a message with files and no text is written; one with neither is refused.
- [ ] Tests named for `F-148/c5`: the decision for each mix of agent, model input (`yes`, `no`, `unknown`, an admin's override) and image size and count; `imagesNotSent` says which.
- [ ] Tests named for `F-148/c8`: detection ignores a lying name and type (a PNG named `.exe`, a script named `.png`); an SVG is a file; names with shell syntax and `..` become safe places.
- [ ] Tests named for `F-150/c4`: with `OSTRA_FILE_TEXT_EXTRACTION=false`, a document's text state is `off`.
- [ ] Every lifecycle's transitions, exhaustively. The settings' defaults and ceilings.
- [ ] Checks for `packages/domain` and its direct consumers (`packages/api`, `apps/core`) pass (spec section 10).
- [ ] Committed as `✨ add message files to the domain`.

## Comments
