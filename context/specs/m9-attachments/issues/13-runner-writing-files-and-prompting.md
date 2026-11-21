# 13: Runner: writing the files and prompting with them

Status: done
Builder: runner
Blocked by: 01, 02
Features: F-148, F-149, F-150
Packages: `apps/runner/src/task-host/` (a new `message-files.ts` beside `ticket-files.ts`, `task-run.ts`, the steer path), `packages/adapter-sdk/src/testing/executor-suite.ts`
Spec: `../spec.md`, sections 4, 5.1 and 6; ADR 0070

## What to build

- **Writing:** before a session starts, every file of the spec's `files`, and before a steer reaches the agent, the steer's own files, are written under `<workspace root>/.ostra/<path>`, with their text at `<path>.md`:
  - downloaded on the bulk path, checked against size and SHA-256 (a mismatch is never written);
  - the path checked again with the protocol's schemas, and the resolved target required to sit inside the root's `.ostra/` (a link or `..` that leaves it is `path-refused`);
  - written with mode `0644`, never executable, and a file already there with the same digest isn't written again;
  - the same code on `docker`, `kubernetes` and `host`, as `writeTicketFiles` is.
- **Prompting:** the message's text, then `messageFilesBlock` with the absolute paths as the agent sees them, then, for the files in `images` (or `promptFiles.images`), their bytes as `AgentPromptInput.images` when the adapter declares `promptImages` and the agent advertised images; otherwise the block says they went as files and `files.written` says why.
- **`files.written`:** once per prompt or steer that carried files, and once per fresh box, as section 5.1 says.
- **A file that fails** is skipped and named in the block; the turn starts anyway.
- **The executor suite** gains the case section 6 describes, run on the fakes and live on `host`.
- **Logs:** IDs, counts and reasons; never a name, a path's name part or content.

## Done when

- [x] Tests named for `F-148/c4`: the executor suite's case on the `docker` and `kubernetes` fakes and live on `host`: files under the root's `.ostra/`, outside every repo, readable by the agent's user, absent from each repo's `git status`, gone with the box; a path that would leave `.ostra/` is refused (break-it: write under the session's folder, and the `git status` case fails on a one-repo task).
- [x] Tests named for `F-148/c5`: with the scripted fake that advertises images, the image reaches the stub model; with the one that doesn't, the block names the path and `files.written` says `agent-did-not-advertise`.
- [x] Tests named for `F-148/c6`: on a fresh box every file of the spec is back at its place before the session starts.
- [x] Tests named for `F-149/c4`: a ticket's files land under `.ostra/ticket/`, named in the first prompt's block.
- [x] Tests named for `F-150/c1`: a document's `.md` lands beside it and the block names both.
- [x] Tests named for `F-148/c8`: a digest mismatch isn't written; no file name or content in a log line.
- [x] Checks for the whole repo pass (spec section 10: what runs agent output). The `live-docker` and `live-kind` runs of the case wait for the launch-gate Proof run, with a dated note.
- [x] Committed as `✨ write a message's files into the box`.

## Comments

- 2026-11-21, runner: committed as `✨ write a message's files into the box`, after ticket 09 (`caebbb7f` maps the spec's `inputModalities` into `prepareLaunch`, which this commit doesn't repeat; `1e5a3dca` turns on OpenCode's `promptImages`) and ticket 05 (`8ea34ff9`). What it holds, and the calls it made:
  - **One writer for the runner and the executor suite:** `placeBoxFile`, `readBoxFile`, `boxFilesDir` and `boxFilePath` in `packages/adapter-sdk/src/executor/box-files.ts`, since an adapter's contract test can't import the runner. The runner's `message-files.ts` downloads each blob on the bulk path, checks it against the spec's size and SHA-256 (and the digest core's header names), and hands it to `placeBoxFile`; the suite's case calls the same function on each executor's box.
  - **How a file is placed:** the place checked again with `fileBoxPathSchema` or `fileTextPathSchema` (and the whole file with `taskSpecMessageFileSchema`); each folder under the root made part by part and checked with `lstat` (a real folder, never a link or a junction), then resolved with `realpath` inside the root's `.ostra/`; the bytes written to a new `wx` file beside the place and moved onto it, so a link at the place is never followed (a link there is `path-refused`), with the folder checked again just before the move; `0644` and `0755` set with `chmod`, whatever the umask. A file already there with its size and digest is neither downloaded nor written again (`readBoxFile`), so a kept box, and a prompt naming files the box's start wrote, cost a hash, not a download.
  - **Protocol, additive:** `messageFilesBlock` gains `notSaved` (`FileNotSaved`: a safe name and a `FileSkipReason`) with `fileSkipWords`, so a file the runner couldn't save is named under "Not saved in your workspace:" with why. `leftOut`'s reasons are core's (over a limit, the tracker's download), and none fits a runner's skip.
  - **`files.written`:** once after the spec's files are written at a session's start, on a fresh box and on a kept one alike (`imagesSent: 0`), and once per prompt or mid-turn steer that carried files. `imagesAsFiles` is `agent-did-not-advertise` when core marked images, the spec's model takes images and the session can't carry them (the adapter's `promptImages` or the agent's advertisement). The block's `imagesNotSent` is `model` when the spec's model takes no images, `agent` when the session can't carry them, and nothing when an image went as a file for another reason (past `promptImagesMax`).
  - **Which turn gets which files:** `promptFiles` goes with the turn whose text is the spec's `prompt` (a new or a rebuilt session's first); a resumed or restored session's pending messages carry their own `files`. Messages queued while a turn ran each keep their own block after their own text, joined as before, with at most `promptImagesMax` images in the whole prompt, in order.
  - **Whose block:** files placed under `ticket/` are named under `ticketFilesBlockHeading` with the ticket's words; files under `attachments/` under the member's heading; a message holding both gets both blocks, the member's first.
  - **Images are read back from the box** and checked against the spec's digest just before they go, so the model sees what the spec names; one the agent changed since goes as a file only.
  - **A mid-turn steer** writes its files before `agent.steer`; if the turn ended meanwhile, the message becomes the next turn, which names them again.
  - **The model's inputs reach the session too:** the runner passes the spec's `agent.inputModalities` to `startSession` as `modelInputModalities` (ticket 09 passes them to `prepareLaunch`), so `promptsImages` answers for the task's model.
  - **Tests:** the executor suite's two `F-148/c4` cases (the files case, which needs the fixture's `app` and `workInProgress` and so skips the tiny executor; and the refusals: a climb, an absolute path, a junction or link in `.ostra/`, a link at the file's place where the account can make one) pass on the `docker` and `kubernetes` fakes and live on `host`. `message-files.test.ts` runs the runner on `host` with the scripted fakes: `F-148/c4`, `F-150/c1`, three `F-148/c5` cases (the rich fake in the prompt and a mid-turn steer, the plain fake, a text-only model), `F-148/c6` (a rebuilt session on a fresh runner, whose pending message's turn reads an earlier message's file at the path it was given), `F-149/c4` and `F-148/c8` (a corrupted copy, a wrong digest in the spec, a failed download and a text that doesn't match, with hostile names and contents searched for in every log line). `message-files.opencode.test.ts` runs the pinned OpenCode in both API formats, with ticket 09 in: the marked screenshot reaches the stub model in the prompt as an image part (an Anthropic `image` block, an OpenAI `image_url`), and the agent reads a file of the message at the absolute path the block named, with no approval asked. The protocol's `F-148/c8` case covers `notSaved`'s words.
  - **Checks**, under the lead's rules (2026-11-20): the whole repo's typecheck; lint of `protocol`, `adapter-sdk`, `runner` and the three executor adapters; tests of `protocol`, `adapter-sdk`, `runner` and the three executors' contract suites. No break-it pass (the maintainer, 2026-11-21).
  - **Waits for the launch-gate Proof run (2026-11-21):** the files case live on Linux, in the `live-docker` and `live-kind` jobs.
