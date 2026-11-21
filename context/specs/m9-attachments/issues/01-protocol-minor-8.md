# 01: Protocol: minor 8

Status: done
Builder: core
Blocked by: none
Features: F-148, F-149, F-150
Packages: `packages/protocol`
Spec: `../spec.md`, section 5.1; ADR 0070

## What to build

Minor 8 of the runner protocol, additive only, with minor 7's codecs kept (`src/runner/version.ts`'s comment gains milestone 9's paragraph).

- **`src/task/files.ts` (new):**
  - `FILES_ROOT_DIR` (`.ostra`, under the workspace's root), `taskSpecFileSchema`, `promptFilesSchema`;
  - `safeFileNameSchema` and `safeFileName(raw, fallbackExtension)`: letters, digits, spaces and `._-()`, 1 to 124 characters, no leading `.`, Windows' reserved names (`CON`, `NUL`, `COM1` …) prefixed with `_`, the extension kept when it is 1 to 10 letters or digits;
  - `fileBoxPathSchema`: `attachments/<n>/<name>` or `ticket/<name>`, each segment checked, no `..`; a text's path is its file's with `.md`.
- **The task spec:** `files`, `promptFiles`, `restore.pendingMessages[].files`, `agent.inputModalities`, each optional, each sent only to a minor-8 peer.
- **`steer`:** `files` and `images`, optional, stripped below minor 8 by the down codec, which also refuses to encode a steer with files for a minor-7 peer (core never sends one).
- **Events:** the runner's `files.written`; `user.message`'s `files`, `filesLeftOut` and `imagesNotSent`; the server-only `ticket.context_read` (added to `serverOnlyKinds`); the intent `ticket-update` (`messageIntentSupportedAt` 8).
- **Offering:** `taskSpecMinMinor` returns 8 for a spec with `files` or `promptFiles`; `isTaskOfferable`'s reason `message-files` and its words in `taskNotOfferableWords` ("A task with files needs a runner at protocol 1.8 or later: update the runner."); `canSendFiles(peerMinor)`.
- **Limits** in `src/runner/limits.ts`, as section 5.1 names them.
- **The fixed words** in `src/agent/prompts.ts`: `messageFilesBlock` and `ticketFilesBlockHeading`, with a kind's words for each `kind` and common document type, sizes in KB and MB as the panel writes them, and nothing of a file's content.
- **Recorded traffic** (`src/testing/recorded.ts`) and the version matrix gain minor 8's lines.

## Done when

- [x] Tests named for `F-148/c4,c8`: `taskSpecFileSchema` refuses a path with `..`, an absolute path, a separator in a name, a leading dot, and a name over 124 characters; `safeFileName` over shell syntax, prompt-like text, `../../etc/passwd`, `CON.txt`, an empty name and a 300-character one (break-it: let `..` through, and the path test fails).
- [x] Tests named for `F-148/c9`: a spec with files is not offerable to a minor-7 peer, with the reason and its words; a steer with files can't be encoded for minor 7; a minor-7 peer's codecs drop every new field.
- [x] Tests named for `F-148/c4`: `messageFilesBlock` names each absolute path, the text's path, the images sent as images and the left-out ones, and says the files are data and outside the repos.
- [x] The version matrix and `minor-8.test.ts` pass.
- [x] Checks for the whole repo pass (spec section 10: the runner protocol).
- [x] Committed as `✨ add protocol minor 8: files for the agent`.

## Comments

- 2026-11-21, core: built as `✨ add protocol minor 8: files for the agent`. `origin/main` was at minor 7, so this is minor 8 (window 7 to 9), with a synthetic minor 10 recording two ahead. Readings and differences:
  - **One name differs from the spec:** `taskSpecFileSchema` already names a repo's environment file in `spec.ts`, and nothing is renamed, so a file for the box is `taskSpecMessageFileSchema` (`TaskSpecMessageFile`) in `src/task/files.ts`, with the spec's fields. A message's files as the box gets them are `messageBoxFilesSchema` (each file once, each place once, at most 50).
  - **Names:** `safeFileName` keeps the last part of a path, folds accents (`Spécification` → `Specification`), turns any other character into `_`, drops leading and trailing dots and spaces, and makes at most 120 characters (ADR 0070), so `boxPathFor`'s ` (n)` still fits the schema's 124. The schema also refuses a trailing dot or space, which Windows drops. A text's path is checked as its file's with `.md`, not as a name of its own, so a 124-character file still has one.
  - **Paths in the prompt** are absolute, in backticks a safe name can't hold, with `/` between parts: the runner hands `messageFilesBlock` the root that way. The words say an image sent as one can be seen "in this message", since the image blocks come after the text.
  - **A message may have no text when it has files:** the minor-8 `steer` and pending message allow empty text with files (a refine checks one or the other). Minor 7's shapes keep `min(1)`.
  - **`ticket-update`** is minor 8's (`messageIntentSchemaV7` keeps minors 5 to 7). Until ticket 04 adds its own turn origin, `turnOriginOfIntent` gives it `message`, and the thread draws it by its blocks (`quoted`), with the words "ticket updates".
  - **Added beyond the spec:** `messageFileIdSchema` and `ticketReadIdSchema`; the limits `fileNotesMax` (100 left-out or failed names), and the template's caps for a read of the ticket (`ticketDescriptionMaxBytes`, `ticketCommentMaxBytes`, `ticketCommentsMax`, `ticketLinksMax`); `fileTextMaxBytes` counts the whole text, its first line and the cut's note included (ticket 07); `fileKindWords`, `fileSizeWords` (the panel's `212 KB` and `3.1 MB`) and `fileLeftOutWords`. `files.written`'s `imagesAsFiles` is an enum of one value, so a later reason is additive.
  - **Offering:** `taskSpecMinMinor` is 8 for a spec with `files`, `promptFiles` or a pending message's files; `agent.inputModalities` alone needs nothing (a minor-7 runner tells the agent nothing of them, as before). `canSendFiles(peerMinor)` is the steer's check, and minor 7's encode throws for a steer that carries files.
  - **Callers:** the fold, the task state and the ingest store the two new kinds with no row yet; the pinned minors in the protocol's, core's and the runner's tests move up one (a minor-6 runner is now refused at hello, so core's preview test makes one by its presence).
  - **Checks:** the whole repo's typecheck, lint and tests. Two failures predate this commit and are on `origin/main` without it: `e2e/dev-tools`' typecheck and tests (`renderInvitationMail` now needs an `address`, `d99ec653`) and `packages/api`'s lint (`eqeqeq` in `src/routers/memory.ts`).
