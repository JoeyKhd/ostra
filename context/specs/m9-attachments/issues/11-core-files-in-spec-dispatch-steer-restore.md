# 11: Core: files in the spec, the dispatch, the steer and the restore

Status: done
Builder: core
Blocked by: 05, 09
Features: F-148
Packages: `apps/core/src/dispatch/`, `apps/core/src/ingest/` (the runner's events), `packages/domain/src/use-cases/sync-provider-models.ts` (the catalog sync), `packages/domain` (the use cases' outbox calls, where they live)
Spec: `../spec.md`, sections 4 and 5.1; ADR 0070

## What to build

- **The spec:** dispatch fills `files` from `taskSpecFilesOf`, `promptFiles` from the first prompt's message (a new task's, or a reopen's when it's the session's first prompt), `restore.pendingMessages[].files` for each pending message that had files, and `agent.inputModalities` from the session's model (`catalogInputModalities`, with `image` added or removed by `adminImageInput`; `["text"]` when nothing is known). Each blob is the task's, so the runner's bulk downloads pass the existing ownership check.
- **The steer:** wherever core enqueues a `steer` for a member's message with files (`sendMemberMessageInTx`'s paths, the app lease's turn, `linear-follow-up`), its body carries the `files` and `images` `bindMessageFilesInTx` returned. A session whose runner is below minor 8 never gets one: the use case refuses first with `runner-needs-upgrade` (`canSendFiles`), which the API turns into the box's words.
- **Offering:** admission and the offer path use `isTaskOfferable`'s `message-files` reason, so a task with files waits for a minor-8 runner, and the dispatch note says why.
- **`files.written`:** stored as the runner's event; a skipped file is shown by the thread from it (no row changes). `imagesAsFiles` set means the agent didn't advertise images: the thread says the images went as files.
- **The catalog sync** writes `Model.catalogInputModalities` from `CatalogEntry.inputModalities` on each sync, and never touches `adminImageInput`.

## Done when

- [x] Tests named for `F-148/c4,c6`: a new task's spec holds its first message's files and `promptFiles`; a reopen on a fresh box holds every earlier file and the reopen's own; a pending message keeps its files; the spec's files are the task's only (another task's file ID is never in it) (break-it: build `files` from the last message alone, and the fresh-box case fails).
- [x] Tests named for `F-148/c5`: the spec's `inputModalities` for a catalog model with images, one without, a custom one, and each with an admin's override; a steer's `images` follow the decision.
- [x] Tests named for `F-148/c9`: a task with files isn't offered to a minor-7 runner, with the note's words; a message with files to a minor-7 runner's session is refused before anything is written.
- [x] Checks for the whole repo pass (spec section 10: the runner protocol).
- [x] Committed as `✨ send a message's files to the runner`.

## Comments

- 2026-11-21, core: built as `✨ send a message's files to the runner`, on tickets 01, 05, 06 and 09. Readings and differences:
  - **The spec** (`apps/core/src/dispatch/files-spec.ts`): `files` is `taskSpecFilesOf` (every sent file of the task, a member's and a ticket's, oldest first), sent only when there is one. `promptFiles` is the first `user.message` of a session that starts new; a reopen's session is never new (the dispatch makes it `resumed`, `restored` or `rebuilt`), so the reopen's message, and any message no turn answered, is a pending message with its own `files`, from `unansweredMessagesInTx`. Every prompt's files are kept to those `files` carries: a file whose blob retention took is never named, and a pending message left with no words and no file is dropped. `agent.inputModalities` is `modelInputModalities` of the session's model row, sent every time (`["text"]` when nothing is known); a minor-7 runner's spec drops it.
  - **Offering:** the dispatch (`dispatchTask`, which admission's walk also calls) needs minor 8 (`FILES_MINOR`) for a task with a file the spec would carry (`taskHasFilesInTx`, the same rows), whatever the dispatch is for, "Start the app" included. When only older runners could take it, the wait is `needs-protocol` with a new optional `reason: "message-files"` (one of `isTaskOfferable`'s reasons, additive), whose note is `taskNotOfferableWords`: "A task with files needs a runner at protocol 1.8 or later: update the runner." The panel's wait line says the same (`waitLine.needsProtocolFiles`), so the thread doesn't blame the agent profile.
  - **The steer:** `sendMemberMessageInTx`'s paths already carried the files (ticket 05). Two fixes: the minor-8 check now comes before the person-action write, so a refused message writes nothing at all (the task row included); and a held message released by its budget (`budget.release`) now carries its files and images, read back from its rows (`steerFilesOfMessageInTx`), and stays owed (replayed at the next reopen) when its runner can't take files or nothing is left to send. `runnerTakesFilesInTx` moved to `files/message-files.ts` for both. A Linear follow-up goes through `sendMemberMessageInTx`: core now hands it `coreMessageFilesDeps(settings.files)` (`apps/core/src/agents/prompt-images.ts`: the settings' limits, and `promptImages` of each shipped agent), ready for ticket 12's follow-up files.
  - **`files.written`** is stored as the runner sent it and changes no row (tested); the thread's reading of it is ticket 16's.
  - **The catalog sync** writes `catalogInputModalities` (`null` when models.dev says nothing) on each sync of a catalog model, and never `adminImageInput`.
  - **Tests:** `apps/core/src/dispatch/message-files.test.ts`, against Postgres with personal runners at minor 8 and 7, through `createPromptTask`, `dispatchTask`, the offer's acceptance, `buildTaskSpec`, `reopenTask`, `sendMemberMessageInTx`, the ingest and `syncProviderModels`; file names hold shell syntax and prompt-like text and reach no log line. The web's wait line in `task-waiting-words.test.ts`.
  - **Checks:** typecheck and lint of the whole repo; tests of `packages/domain`, `apps/core`, `packages/api` and the web's touched words.
- 2026-11-21, the lead: past `taskFilesMax` or `taskFilesTotalBytes`, the spec kept the task's first 500 files, oldest first, so a long task's newest files fell out, and `filesInSpec` then dropped them from a pending message too: on a fresh box a reopen's own files were neither written nor named. Now the newest stay: `taskSpecFilesOf` takes `keep` (the first prompt's files and every pending message's, from `specFileParts`), always carries those, then the others newest first, and leaves out the oldest past a cap; the list stays oldest first. `buildTaskSpec` takes `taskFilesCaps` (the protocol's working values without it), and the test passes small ones: "past the spec's caps the newest files stay" in `apps/core/src/dispatch/message-files.test.ts` (not keyed to F-148/c6, since past a cap not every earlier file is back).
