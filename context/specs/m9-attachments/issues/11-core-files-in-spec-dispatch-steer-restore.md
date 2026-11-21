# 11: Core: files in the spec, the dispatch, the steer and the restore

Status: ready-for-agent
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

- [ ] Tests named for `F-148/c4,c6`: a new task's spec holds its first message's files and `promptFiles`; a reopen on a fresh box holds every earlier file and the reopen's own; a pending message keeps its files; the spec's files are the task's only (another task's file ID is never in it) (break-it: build `files` from the last message alone, and the fresh-box case fails).
- [ ] Tests named for `F-148/c5`: the spec's `inputModalities` for a catalog model with images, one without, a custom one, and each with an admin's override; a steer's `images` follow the decision.
- [ ] Tests named for `F-148/c9`: a task with files isn't offered to a minor-7 runner, with the note's words; a message with files to a minor-7 runner's session is refused before anything is written.
- [ ] Checks for the whole repo pass (spec section 10: the runner protocol).
- [ ] Committed as `✨ send a message's files to the runner`.

## Comments
