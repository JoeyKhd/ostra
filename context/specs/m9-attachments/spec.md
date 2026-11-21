# Milestone 9: Attachments

**Status:** spec, 2026-11-21. Tickets in `issues/`, one file each (`docs/agents/issue-tracker.md`).
**Milestone:** 9 (`context/build-order.md`). It lands before milestone 7's held launch gate, as milestone 8 does, so the gate's load test, security review, measure and demo run once, on a product that already has it.
**Features:** F-148 (files in messages), F-149 (ticket files as context, extending F-064) and F-150 (text out of documents).
**The maintainer, 2026-11-21:** "one of the top priorities now is to add image support and file support to our chat text box thing, LOL no attachements?!?!?!?!", and "if we pick up a linear ticket, or from jira (later on) the full ticket shouldd be used as context for the task that we are starting. and also during chatting we should be able to upload attachements. in the linear/jira ticket screenshots, docx anything should be added as conteeext".
**Accepted the same day:** the lead's five-part proposal (chat attachments any time; what the agent gets; ticket attachments; storage; limits), recorded as decided (Q327 to Q331). The rest of section 12 is the lead's call (Q332 to Q341), which the maintainer can still change.
**Decisions it builds on:** ADR 0013 and ADR 0025 (trackers, adapters), 0018 and 0032 (ACP, OpenCode), 0021 (no outbound calls of ostra's own), 0029 (executors), 0030 (no credential in the box), 0031 (the safety minimum), 0033 (models and the catalog), 0034 (the runner protocol), 0035 (the event log), 0036 (the task page), 0039 (fresh boxes), 0043 (blobs), 0057 (Linear follow-ups), 0068 (milestone 8's attachments and viewer). **New for this spec:** ADR 0070 (files for the agent, in messages and from tickets), which amends ADRs 0013, 0018, 0025, 0032, 0033, 0043 and 0057.
**Research it rests on:** `research/attachments-for-agents.md`: what OpenCode 2.3.2 does with images and files over ACP, read from its source, and the libraries for reading documents.
**Builds on milestones 1 to 8** as they were built, not only as they were specified. Where their code ends up different from their specs, this spec follows the code, and the ticket that meets the difference says so in its `## Comments`.

Terms follow `context/GLOSSARY.md`. Lifecycles follow `context/domain-model.md`, which ticket 05 grows.

---

## 1. What milestone 9 ends with

A member hands the agent what they're looking at as easily as they type, and a task started from a ticket starts with everything the ticket holds.

In more words. In the new-task box and in every message after it, a member pastes a screenshot, drops a spec and a spreadsheet, or picks files with the paperclip. Each shows in the box, removable, and goes with the words, or alone. The agent finds every file in its workspace, outside the repos, named in its prompt. A screenshot or a mock also reaches the model as a picture when the model can see one, and the box says so beforehand when it can't. A Word document, a PDF, a workbook or a deck has its text beside it, read by core when it came in. The thread shows the files under their message, and anyone who can open the task downloads them. A task started from a Linear ticket gets its description, its comments and every file in them or attached to it, and its first message shows what the agent got. A reopen reads the ticket again and passes on what changed, and "Send ticket updates" does that on a member's press while the task runs.

### What milestones 1 to 8 leave that milestone 9 starts from

Read from the code on `main` on 2026-11-21 (`9704dcd3`), so builders don't rebuild what exists:

- **The protocol is at minor 7** (`packages/protocol/src/runner/version.ts`, milestone 8). Milestone 9 takes minor 8, and the window (one minor either side) keeps a minor-7 runner working and leaves minor 6 out.
- **Every message box takes text only.** The task page's composer (`apps/web/src/task/task-thread.tsx`, `Composer`, on assistant-ui's `ComposerPrimitive` through `useExternalStoreRuntime`), the project page's (`apps/web/src/components/projects/project-composer.tsx`) and the new-task page's (`apps/web/src/components/tasks/new-task-view.tsx`). `tasks.create`, `tasks.send` and `tasks.reopen` take text (`packages/api/src/routers/tasks.ts`). The installed `@assistant-ui/react` 0.15.36 ships `ComposerPrimitive.AddAttachment`, `ComposerPrimitive.Attachments` and attachment adapters, unused so far.
- **A refine draft takes images** (F-099): base64 over tRPC (`drafts.addImage`), stored by core as `draft-image` blobs, 10 MiB each, `OSTRA_DRAFT_IMAGES_MAX` a draft (`apps/web/src/components/tasks/draft/draft-images.tsx`). Nothing of them reaches an agent.
- **The panel writes and reads blobs through core** (ADR 0043): `POST /panel/v1/blobs` with a one-minute HMAC token for one organization, purpose, size and SHA-256 (`packages/domain/src/panel-blob-token.ts`; purposes `skill-file`, `draft-image`, `library-file`), and `GET /panel/v1/blobs/<id>` with a read token. Milestone 8's attachments download with a fixed type, `attachment`, `nosniff`, `default-src 'none'; sandbox` and `same-origin` (`packages/api/src/services/attachment-download.ts`, `f5f6da45`).
- **A ticket's images reach the workspace** (F-064): `ticket.fetch-context` (`apps/core/src/tracker/context.ts`) reads `TicketContext.images` through the adapter, copies at most 20 of 10 MiB into `ticket-file` blobs, renders the project's ticket template (`{{#images}}` lists `.ostra/ticket/<blobId>.<ext>`), and the dispatch's `contextFiles` make the runner write them under `.ostra/ticket/` in the agent's session folder, which every repo's git ignores (`apps/runner/src/task-host/ticket-files.ts`). Only images and PDFs are written (`TICKET_FILE_EXTENSIONS`). **Other files aren't fetched at all:** Linear writes an uploaded `.docx` as a link `[spec.docx](https://uploads.linear.app/…)`, which stays text.
- **Linear's adapter** finds images in markdown (`![…](…)`, `<img src>`) and image attachments by their extension, on its file host only (`packages/adapters/adapter-linear/src/markdown-images.ts`, `#imagesOf`). `downloadFile(url, maxBytes)` sends the token only to `https://uploads.linear.app` and follows no redirect. `TicketContext.attachments` are links (`{ id, url, title, subtitle }`). The tracker capabilities have no word for files (`packages/adapter-sdk/src/tracker/capabilities.ts`). A Jira fake runs the tracker contract suite (`packages/adapter-sdk/src/testing/jira-fake.ts`).
- **A Linear follow-up** (agent mode, ADR 0057) becomes a member's message of the intent `linear-follow-up`, text only (`apps/core/src/linear/agent-mode/events.ts`).
- **The ACP driver sends text only:** `prompt: [{ type: "text", text }]` in `session/prompt` and `_session/steering` (`packages/adapter-sdk/src/agent/acp/driver.ts:1017-1019`, `1082`). It doesn't read `promptCapabilities`. `AgentAdapter`'s session takes `prompt(agentSessionId, text)` and `steer(agentSessionId, text)` (`packages/adapter-sdk/src/agent/base.ts:397-399`).
- **OpenCode sees every model as text-only:** the catalog entry ostra writes has no `modalities`, and OpenCode's default is `["text"]`, so it swaps any image, the read tool's included, for an error line (research §1). F-064's images have never reached a model as pictures.
- **The catalog** (`packages/adapters/adapter-model-endpoint/src/catalog.ts`, `CatalogEntry`) keeps prices, limits and reasoning, not modalities. The `Model` row has `catalogReasoning` and `adminReasoning` (ADR 0066), the pattern for an admin's override.
- **The workspace:** with one repo the agent's session opens in the repo's checkout (`apps/runner/src/task-host/agent-cwd.ts`); with several, in the root. OpenCode's file tools reach the root (`ownFolders`, `ec0e3482`).
- **A reopen** (`packages/domain/src/use-cases/reopen.ts`) writes the member's message, carries unanswered messages as the spec's `pendingMessages`, and enqueues `task.dispatch`.
- **The key proxy** reads a model call's whole body, with no cap of its own (`apps/runner/src/sidecar/key-proxy.ts`).
- **The launch gate is held:** milestone 7's tickets 25 to 28, 32 and 33, and milestone 8's demo (its ticket 33), wait for the maintainer's word (`build-order.md`). Milestone 9's own demo joins them.

### What is in, and what is not

**In:**
- files in the new-task box (the project page's and the new-task page's) and in every message after it: a message, a reply, an interrupt, a reopen; by the paperclip, paste and drop; a tray with thumbnails, chips and remove; the limits as settings;
- uploads through core, bound at send, swept after a day;
- files in the thread, the viewer for images, downloads for anyone who can open the task;
- the files in the box under the workspace's root, named in the prompt, written again on every fresh box;
- images as images to a model that takes them, on both API formats, through a new agent capability; a model's image input from models.dev and an admin's override; the box's warning;
- text out of `.docx`, `.pdf`, `.xlsx` and `.pptx` in core, safely, with a switch;
- a ticket's every file as context, through a new tracker capability, with links given and not fetched; the ticket's limits; Retry;
- the thread's first message for a ticket task, showing what the agent got;
- a ticket's changes on a reopen, and "Send ticket updates"; a follow-up's files;
- the docs for all of it.

**Not in** (and when it comes):
- OCR of scans and pictures: not planned. A model that takes PDFs or images reads them itself.
- `.doc`, `.xls`, `.ppt` and OpenDocument text: later, if members ask. They're attached as files.
- Frames from a video or text from audio: not planned (Q341). They're files.
- Fetching what a link points at (Figma, Sentry, Google Docs): not planned (Q337).
- A ticket's new comments pushed into a running task by themselves: not planned (Q336). A member sends them.
- Showing a document's extracted text in the panel: later (the targets' open point). The chip says it exists.
- Files on a PR comment (`@ostra`) or a review comment: later. Their text reaches the agent as today.
- Jira itself: after v1 (F-008). Its fake declares `ticketFiles: all` and passes the suite now.
- Claude Code and other agents: after v1 (F-018). The agent capability `promptImages` is what they'll declare.

### On this machine

The same adjustment as milestones 1 to 8: the scripted demo runs here on the `host` executor. Uploads, extraction, the files in the box, the prompts with images (to the stub models in both API formats), the thread and the ticket's files from the fake Linear all run here. What needs more than that:
- **Linux with Docker, and kind:** the executor suite's new case live, in the `live-docker` and `live-kind` jobs of `proof.yml` at the launch gate. Until then the case passes on the fakes, and F-148's c4 waits for the gate on those two executors.
- **A real Linear ticket with files, and a real model that sees images:** the manual run, once (ticket 19).
- **People:** the maintainer's approval of the targets in `context/brand/app-targets/m9/` (tickets 15 and 16).

---

## 2. The features, and where each one lives

"At M9's end" is the ledger status ticket 18 sets at the launch gate, if and only if every condition in the row's "done when" holds.

| F-ID | What milestone 9 builds | Packages | Tickets | At M9's end |
|---|---|---|---|---|
| F-148 Files in messages | The tray, paste, drop and the paperclip in every box; uploads through core; binding at send; the limits; files in the thread and downloads; the files in the box outside the repos; images as images where the agent and the model take them; a model's image input; the sweep (ADR 0070) | `packages/protocol`, `adapter-sdk`, `adapter-opencode`, `adapter-model-endpoint`, `apps/runner`, `packages/db`, `packages/domain`, `apps/core`, `packages/api`, `apps/web` | 01, 02, 04, 05, 09, 10, 11, 13, 14, 15, 16 | done, once the `live-docker` and `live-kind` jobs ran the executor case; otherwise `building` with `host` and the fakes proved |
| F-149 Ticket files as context | `ticketFiles` and the suite's cases; every file of a Linear ticket; the ticket's limits; the first message's "What the agent got"; Retry; a reopen's changes and "Send ticket updates"; a follow-up's files (ADR 0070) | `adapter-sdk`, `adapter-linear`, `packages/db`, `packages/domain`, `apps/core`, `packages/api`, `apps/web` | 03, 04, 06, 08, 12, 14, 16 | done |
| F-150 Text out of documents | The reader for `.docx`, `.xlsx`, `.pptx` and `.pdf` in a worker in core; its caps and refusals; the text beside the file; the switch (ADR 0070) | `apps/core`, `packages/domain`, `apps/runner`, `apps/web` | 05, 07, 10, 12, 13, 15, 16 | done |

**Rows this milestone touches without finishing:**
- **F-064 (ticket context)** gets every file instead of images alone, and its images become visible to a model that takes them. Its status stays as milestone 2 left it; F-149 carries the new conditions.
- **F-088 (model providers)** gains a model's image input and the admin's switch, as F-137 gained its reasoning. No new status.
- **F-012 (start from Linear)** gains a follow-up's files. No new status.
- **F-032 (reopen)** on a ticket task reads the ticket first. No new status.
- **F-114 (blob storage)** gains two purposes. No new status.

**Built in from the first milestone** (`build-order.md`), checked again by ticket 18:
- **Organization-scoped data:** every new row carries `organizationId`, every project record `projectId` with the composite key (04). Milestone 4's generated isolation test gets a fixture for each new model, and fails until each has one.
- **The event log and the durable queue:** a message's files are bound in the transaction that writes its `user.message`, a ticket read and its message in one transaction, and every fetch, sweep and re-read is a job (05, 06, 10, 12).
- **No credential in the agent's container:** a tracker's credential stays in core; the box gets blobs on the bulk path (12, 13).
- **ACP as the only way to talk to an agent:** images are ACP content blocks (02).
- **Strict typing, dark first, responsive, English text in message files,** and milestone 7's keyboard walk and contrast check on the new parts (15, 16).

---

## 3. The end-to-end demo

Ticket 18 runs it **at the launch gate**, with milestone 7's ticket 32 and milestone 8's ticket 33, and records the result under its `## Comments` and in `demo.md` next to this spec. Everything runs against the Linear workspace `ostra-test` (team `OST`) and the GitHub org `ostra-test`, repo `test1`. Secrets come from `~/.config/ostra-dev/` with `set -a; . ~/.config/ostra-dev/<file>; set +a`, and are never printed, logged or committed. The fixtures (a mock PNG, a `.docx` spec, a `.pdf`, an `.xlsx`, a `.pptx`, a `.csv`, an 11 MiB file, an encrypted PDF, a zip bomb named `.docx`, a `.docx` with a `<!DOCTYPE`, a PDF with JavaScript) live in `e2e/m9-attachments/fixtures/`, made by ticket 07.

**Two runs.** The scripted run (`pnpm e2e:m9`) runs every step it can without a person, on the `host` executor, with the fake Linear and the stub models in both API formats, and `OSTRA_BOX_IDLE_MINUTES=2`. The manual run, once, in a real browser, adds a real `OST` ticket with files (ticket 19 makes it), a real model that sees images, and a model that doesn't.

**Before:** a fresh clone, `pnpm install`, `pnpm dev:reset`, `pnpm dev`, and milestones 1 to 8's helpers: a model provider, the test App on `test1`, the Linear connection, a project `test1` with board `OST`, a personal runner on `host`. The panel signs in as `demo@demo.com` / `demo`. Sam joins by invitation as a member of another project only.

1. **Files in the new-task box.** On `test1`'s page Demo pastes the mock PNG, drops the `.docx`, the `.csv` and the `.pdf`, and picks the `.xlsx` with the paperclip. The tray shows the mock as a thumbnail and four chips, each uploading then ready, the documents marked "text extracted". Demo removes the `.csv` and starts the task: "Make the history panel match the mock; the spec is attached."
2. **What the agent got.** The thread shows Demo's message with the thumbnail and three chips. The stub model's first request holds the image (an Anthropic `image` block in one run, an `image_url` in the other), and the prompt's text names `<root>/.ostra/attachments/<n>/history-panel-spec.docx` and its `.md`. The agent's first tool call reads the `.md`. `git status` in the repo shows nothing of `.ostra`, and the PR holds no file of it.
3. **Limits.** Demo drops the 11 MiB file: the box refuses it, naming it and the 10 MB limit. Demo adds eleven small files: the eleventh is refused. Restarted with `OSTRA_MESSAGE_FILE_MAX_MIB=1`, the box's limit line says 1 MB, and the server leaves out a 2 MiB file sent straight to the API with a note in the thread.
4. **A file mid-turn.** While the agent works, Demo pastes a second screenshot with "use this layout instead" and presses "Interrupt and send". The next request to the stub model holds it.
5. **A model that can't see images.** Demo switches the task's profile to a model the catalog lists as text only. The box shows "{model} can't see images; the agent gets them as files." with an image in the tray. Sent, the thread says the same under the message, the stub model gets no image block, and the prompt names the file's path. On the provider's page, an admin turns on "Reads images" for a custom model, and the next message to it carries the image.
6. **Downloads.** Demo downloads the `.docx` from its chip under its own name. Its response carries `attachment`, `nosniff` and the sandbox policy; the mock's carries `image/png`. Signed in as Sam, the same URL is a 404.
7. **A fresh box.** The task stops and its box idles out. Demo reopens it with the `.pptx`. Before the agent's turn, every earlier file is back at its place under `.ostra/attachments/`, and the deck's text is beside it.
8. **A ticket with files.** In `OST`, a ticket holds a screenshot inline in its description, a `.docx` linked in its description, a PDF attached, an `.xlsx` in a comment, a Figma link attachment, and ostra's own progress comment with a picture. Demo starts it from the Inbox. The thread's first message, "What the agent got", shows the description, four files (three with text), the Figma link as "Link · not fetched", and the comment. ostra's own comment and its picture aren't there. The files are under `.ostra/ticket/`.
9. **Left out and Retry.** A second ticket holds 22 files, one of 12 MiB, and the fake tracker fails one download. The first message says 20 were given, names the one over 10 MB and the one past the limit, and the one that failed with its reason. The task started. Demo presses "Retry": the failed file arrives with ostra's message in the next turn.
10. **Changes.** A new comment with a PNG lands on the first ticket. Demo presses "Send ticket updates": a `ticket-update` message carries the comment and the picture. Pressed again: "Nothing new on the ticket since the agent read it." The task stops; someone edits the description; Demo reopens. The reopening turn gets Demo's words and then the edited description.
11. **A follow-up's files.** In agent mode (the fake Linear session), a member's follow-up comment holds a screenshot: it reaches the agent with the follow-up as an image.
12. **Documents ostra can't read.** Demo sends the encrypted PDF, the zip bomb named `.docx`, the `.docx` with a `<!DOCTYPE` and the PDF with JavaScript. Each is attached and marked "no text" with its reason. A plain upload sent at the same time answers within its usual time. With `OSTRA_FILE_TEXT_EXTRACTION=false` on a restart, a `.docx` goes as a file alone.
13. **The sweep.** An upload Demo never sent is gone after the clock moves 24 hours (the scripted run's clock), and its blob with it.

**The checks after the run** (ticket 18 scripts what it can, in `e2e/m9-attachments/`):
- **Nothing leaked.** No file name, no file content and no extracted text appears in any log line, event's log field, process's command line or URL ostra built (searched by value, never printed).
- **Outside the repos.** No `.ostra/attachments/` or `.ostra/ticket/` path appears in any commit, hidden ref or PR of the run.
- **Parity.** The executor suite's files case passes on `docker` and `kubernetes` against their fakes and on `host` live; the Linux jobs run it live when they run. The agent suite passes for the fakes with and without `promptImages`; the tracker suite for Linear and the Jira fake.
- **Fail closed.** A minor-7 runner is never offered the task with files, and the box says the runner needs upgrading.
- **Clean-up:** the demo's tickets archived in `OST`, its PRs closed and branches deleted, in `test1` only.

---

## 4. How it fits together in milestone 9

```
 browser ──▶ apps/web: the tray (paste, drop, paperclip) in the composer and the new-task box;
   │                    files under their message; "What the agent got"; Send ticket updates;
   │                    the provider's "Reads images"
   │     ├─ POST /api/projects/<projectId>/files (FormData, one file) ─▶ core POST /panel/v1/files
   │     ├─ GET  /api/tasks/<taskId>/files/<fileId>                    ─▶ core GET /panel/v1/blobs/<id>
   │     └─ tRPC: tasks.create / send / reopen { fileIds }, files.discard, tasks.ticketUpdates, …
 core ──▶ Postgres: message files, ticket reads, the model's image input
 core ──▶ the worker pool: text out of .docx .xlsx .pptx .pdf (unpdf, fflate, @xmldom/xmldom)
 core ──▶ the tracker (adapter, with the connection's credential): the ticket's files
 runner ──bulk path──▶ core: each file and its text, by blob, with its SHA-256
   └─ the box: <workspace root>/.ostra/attachments/<n>/<name>, …/<name>.md, .ostra/ticket/<name>
      the agent: session/prompt or _session/steering [text, image, image …]
```

**The flows:**
- **An upload.** The tray uploads each file as it joins: `POST /api/projects/<projectId>/files` with `FormData` (`file`, and `taskId` on a task's page). The web app checks the member can open the project (and send on the task, when named), the file's size against the limit, and the member's unsent count; computes the SHA-256; and sends the bytes to core's `POST /panel/v1/files` with a one-minute token for that organization, project, member, size and digest (05). Core tells the kind by the bytes (05), stores the blob (`message-file`), reads a document's text in its worker pool (07) into a second blob (`message-file-text`), writes the `MessageFile` (`uploaded`, the member's, no task yet), and answers `{ fileId, name, kind, contentType, size, text: { state, words } }`. The tray shows the result. Removing a file calls `files.discard`, which deletes an unsent upload.
- **Sending.** `tasks.create`, `tasks.send` and `tasks.reopen` take `fileIds` beside the text, which may be empty when there are files. In the transaction that writes the `user.message`, the domain's `bindMessageFilesInTx` (05) takes the member's unsent uploads of that project, checks the limits again (leaving out what's over, with the reason), sets each file's task, message (`eventSeq`), position and place in the box (`attachments/<seq>/<name>`), decides which go as images (`promptImagesFor`: the agent's `promptImages`, the model's image input, 10 images of 10 MiB), and writes the event's `files` and `filesLeftOut`. A steer carries the files (11, 14); a new task's or a reopen's spec carries them as `promptFiles` or a pending message's (11).
- **In the box.** Before a session starts, the runner writes every file of the spec's `files` (every sent file of the task) and its text, from the bulk path, checked against size and SHA-256, under `<workspace root>/.ostra/` (13). A steer's files are written before the steer goes to the agent. The runner sends `files.written`. It builds the prompt: the message's text, then the protocol's `messageFilesBlock` with each absolute path; then an ACP `image` block for each file marked as an image, when the agent advertised `promptCapabilities.image`.
- **A ticket task's start.** `ticket.fetch-context` (12) reads the ticket through the adapter. With `ticketFiles` not `none`, it fetches each file in `TicketContext.files` within the ticket's limits, stores it (`ticket-file`) with its text, and in one transaction writes the rendered prompt, the first `user.message` with its files (each placed at `ticket/<name>`), a `ticket.context_read` event with what the agent got, the `TaskTicketRead` of round 1, and `task.dispatch`.
- **A ticket's changes.** A reopen of a ticket task enqueues `ticket.read-changes` instead of `task.dispatch`. The job reads the ticket, compares it with the last `TaskTicketRead` (`ticketChanges`, 06), and in one transaction writes, when something changed, a `user.message` of the intent `ticket-update` (ostra's words around the changes, credited to the reopening member, with the new files), the next `TaskTicketRead` and `ticket.context_read`, then `task.dispatch`: the new session gets the reopening message and the update as pending messages, in order. "Send ticket updates" (`tasks.ticketUpdates`) and "Retry" (`tasks.retryTicketFiles`) enqueue the same job with their reason, and its message goes as the driver's steer. A tracker that doesn't answer retries the job; after its tries, a reopen dispatches without the changes and the thread says so.
- **A model's image input.** The catalog sync writes each model's models.dev `modalities.input` to `Model.catalogInputModalities` (11, on 09's catalog field). An organization admin's `adminImageInput` wins (14, 16). `modelImageInput(model)` (05) is `yes`, `no` or `unknown` (counted as no). Dispatch puts the model's input modalities in the spec's agent section, and the OpenCode adapter writes them into its catalog file and config (09).
- **The sweep.** `files.sweep-unsent`, hourly, deletes uploads no message took within 24 hours, blobs and text with them (10).

---

## 5. The contracts

Every contract change in milestone 9 is **additive**: a new optional field, a new union member, a new endpoint, a new table, column or enum value. Nothing is renamed or dropped (`AGENTS.md`). Each lands as one small commit that names the contract and updates every caller in the same commit. Tickets 01 to 06 make them first, each with the fakes its callers test against.

### 5.1 `packages/protocol`: minor 8 (ticket 01)

- **The version.** Minor 8, negotiated in `hello` and `welcome`, with minor 7's codecs kept. A minor-7 peer is never sent anything below. Core never offers it a task whose spec holds `files`, and never sends it a steer with files (`isTaskOfferable`'s new reason `message-files`, with its words in `taskNotOfferableWords`; and `canSendFiles(peerMinor)` for the steer path, whose refusal the box shows). A minor-6 peer falls outside the window.
- **A file for the box** (`src/task/files.ts`, new), a strict object:
  - `taskSpecFileSchema`: `{ fileId, blobId, size, sha256, kind: "image" | "document" | "text" | "file", contentType, path, text: { blobId, size, sha256, path } | null }`. `path` is relative to the workspace root's `.ostra/` (`FILES_ROOT_DIR`), and matches `attachments/<n>/<name>` or `ticket/<name>`: segments of `safeFileNameSchema` only, no `..`, no separator in a name. A text's path is its file's with `.md` added.
  - `safeFileNameSchema`: letters, digits, spaces and `._-()`, 1 to 124 characters, not starting with `.`, not one of Windows' reserved names. `safeFileName(raw, fallbackExtension)` makes one from a member's or a tracker's name, and is shared by core and the runner's check.
  - `promptFilesSchema`: `{ fileIds, images }`, the message's files in order and those that go as images (a subset, at most `promptImagesMax`).
- **The task spec, new optional fields:**
  - `files`: every sent file of the task, at most `taskFilesMax` and `taskFilesTotalBytes`, oldest first. The runner writes each before a session starts, and again on a fresh box.
  - `promptFiles`: the first prompt's files.
  - `restore.pendingMessages[].files`: each pending message's.
  - `agent.inputModalities`: `("text" | "image" | "pdf" | "audio" | "video")[]`, the model's, for the agent's config. Missing means `["text"]`.
- **Commands:** `steer` gains `files` (the message's own `taskSpecFile`s) and `images` (their IDs that go as images). Missing means none.
- **Events (the runner's):** `files.written { files: [{ fileId, textWritten }], skipped: [{ fileId, reason }], imagesSent: number, imagesAsFiles: "agent-did-not-advertise" | null }`, once per prompt that carried files and once per fresh box. `reason` is `download-failed`, `digest-mismatch`, `write-failed` or `path-refused`.
- **Events (the server's):**
  - `user.message` gains `files`: `[{ fileId, name, kind, contentType, size, origin: "member" | "ticket", asImage, text: "ready" | "none" | "failed" | "off" }]`, and `filesLeftOut`: `[{ name, reason: "too-big" | "too-many" | "total-too-big" | "unreadable" | "download-failed" | "not-fetched" }]`, and `imagesNotSent`: `"model" | "agent" | null` (why images went as files). A name is the safe name, never the raw one.
  - `ticket.context_read` (server-only, `serverOnlyKinds`): `{ round, reason: "start" | "reopen" | "member" | "retry", description: string | null, comments: [{ author, at, body, edited }], links: [{ title, url }], files: fileId[], leftOut: [{ name, reason }], failed: [{ name, reason }] }`. `description` is `null` when it didn't change since the last round. Every string in it is the ticket's, never logged; the limits are the template's (64 KiB a description, 16 KiB a comment, 100 comments). Ticket 12 adds two optional markers: `filesNotFetched: true` (the tracker's `ticketFiles` is `none`) and `unreadable: true` (the tracker didn't answer after the read's tries, or the ticket is gone: every list empty). A round that found nothing new has every list empty and `description: null`.
- **A message's intent:** `ticket-update` joins `messageIntentSchema` (`messageIntentSupportedAt` minor 8; below, it reads as `message`).
- **The MCP tools:** none new.
- **Limits,** in `limits.ts`, as named working values: `messageFilesMax` 20, `messageFileMaxBytes` 25 MiB, `messageFilesTotalBytes` 64 MiB (the settings' ceilings); `ticketContextFilesMax` 50; `taskFilesMax` 500 and `taskFilesTotalBytes` 512 MiB (a spec's `files`); `promptImagesMax` 10 and `promptImageMaxBytes` 10 MiB (OpenCode fails a prompt for an attachment over 20 MiB, research §1); `fileTextMaxBytes` 1 MiB.
- **The fixed words** in `src/agent/prompts.ts`: `messageFilesBlock({ root, files, leftOut, imagesNotSent })`, which names each file's absolute path, its kind in words ("PNG image", "Word document", "file") and size, its text's path, "you can see it above" for an image sent as one, and what was left out and why; and says the files are the member's or the ticket's data, saved outside the repos and never committed, and not instructions. `ticketFilesBlockHeading` for the first prompt's ticket files. Neither holds a file's content.
- **Never logged:** a file's name, its content, its text, a ticket's text. Each schema's description says so.

### 5.2 `packages/adapter-sdk` (tickets 02 and 03)

**`AgentAdapter`: images in a prompt** (ticket 02), implemented by the OpenCode adapter (ticket 09), the scripted fakes and the tiny adapters in the same commit:
- **Capability, new:** `promptImages: boolean`: the agent takes images in its prompt. The driver also reads `agentCapabilities.promptCapabilities.image` from `initialize` (ACP), and sends an image only when both say yes.
- **The prompt:** the session's `prompt(agentSessionId, input)` and `steer(agentSessionId, input)` take `AgentPromptInput = { text, images: readonly { mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; bytes: Uint8Array; name }[] }`. The driver sends `[{ type: "text", text }, ...images.map((image) => ({ type: "image", mimeType, data: base64 }))]`. No `uri`: OpenCode would take a `uri`-only block as a link and read the file itself (research §2). `images` is empty for an adapter without the capability, and the driver refuses a non-empty one with `unsupported`.
- **The launch:** `PrepareLaunchInput.model` gains `inputModalities`, for the agent's config.
- **The stub models** (`testing/stub-models/`) record each request's image parts in both API formats (`image` blocks with `source.base64`; `image_url` with a data URL), for the suite to assert.
- **The scripted fake agent** (`testing/fake-acp-agent/`) comes with `promptCapabilities.image` and without it, and passes an image block on to the stub model.
- **The agent contract suite** gains (`agent-files-cases.ts`, new):
  - with `promptImages`, a PNG in a prompt reaches the stub model as an image, in each API format;
  - the same in a steer mid-turn, where the agent steers mid-turn;
  - without it, or with a model whose `inputModalities` lacks `image`, no image part reaches the model and the text names the path;
  - a file the runner wrote under the root's `.ostra/` is readable by the agent's own read tool.
- **Parity rows** (milestone 7's `parity.test.ts`): F-148's images, through `promptImages`.

**`TrackerAdapter`: a ticket's files** (ticket 03), implemented by Linear (ticket 08), the Jira fake and the tiny adapter in the same commit:
- **Capability, new:** `ticketFiles: "all" | "images" | "none"`.
- **`TicketContext` gains `files`:** `TicketContextFile[]`, each `{ url, name, contentType | null, size | null, where: "description" | "comment" | "attachment", commentId | null, byOstra: boolean }`, in the order the ticket shows them (the description's, then each comment's oldest first, then the attachments), each URL once, only files the tracker holds (a link attachment is never one). `byOstra` marks a file in ostra's own comment or an attachment ostra made, which core leaves out. `images` stays as it is (the image subset), so nothing that reads it breaks.
- **`filesInText(markdown)`**: the files a piece of the tracker's text names (a follow-up's comment), the same way. Needs `ticketFiles` other than `none`; without it `[]`.
- **`downloadFile`** as now: the credential goes only to the tracker's own file host, no redirect is followed, and over `maxBytes` is `invalid-input` with nothing more read.
- **The Jira fake** holds attachments with `mimeType`, `size` and a content URL, and ADF `mediaSingle` nodes pointing at them, and declares `all`. **The tiny adapter** declares `none` and returns `files: []`.
- **The tracker contract suite** gains:
  - a ticket's files listed once each, in order: an inline image and a linked file in the description, a comment's image, an attached file;
  - ostra's own comment's files and a link attachment left out of `files` (`byOstra`, not a file);
  - `filesInText` over a follow-up's text;
  - a download within `maxBytes`, one over it refused having read no more, and a URL off the file host refused with no credential sent;
  - `none` declared and `files` empty.

### 5.3 `packages/db`: the milestone 9 migration (ticket 04)

One new migration, after milestone 8's, additive only. Every row carries `organizationId`, every project record `projectId` with the composite key to the project.

| Change | What |
|---|---|
| New `MessageFile` | `projectId`; `taskId` (null until sent); `memberId` (the uploader; null for a ticket's); `origin` (`member`, `ticket`); `state` (`uploaded`, `sent`, `expired`, `left_out`, `failed`); `reason` (a left-out or failed one's code); `sessionId`, `clientMessageId`, `eventSeq` (the `user.message` it went with); `position`; `name` (made safe; never logged); `kind` (`image`, `document`, `text`, `file`); `contentType` (detected); `size`; `sha256`; `blobId` (null for a left-out or failed ticket file); `boxPath` (under `.ostra/`, set at send); `asImage`; `textState` (`none`, `ready`, `failed`, `off`); `textReason`; `textBlobId`; `textWords`; `textTruncated`; `ticketWhere` (`description`, `comment`, `attachment`), `ticketCommentId`, `ticketSourceKey` (the SHA-256 of the tracker's URL, never the URL); `retryOfId`; `createdAt`, `sentAt`. Indexes `(taskId, eventSeq, position)`, `(state, createdAt)`, `(organizationId, projectId, memberId, state)` |
| New `TaskTicketRead` | `taskId`, `round` (1 at the start), `reason` (`start`, `reopen`, `member`, `retry`), `readAt`, `descriptionSha256`, `comments` (JSON `[{ id, updatedAt }]`), `fileKeys` (JSON, the files' source keys), `eventSeq` (the message it went with, if any). Unique `(taskId, round)` |
| `Model` | + `catalogInputModalities` (JSON: models.dev's `modalities.input`; null when the catalog says nothing), `adminImageInput` (Boolean, null: follow the catalog) |
| Message intents | + `ticket_update` (`packages/db/src/enums.ts`'s mapping) |
| Enums | New `MessageFileOrigin`, `MessageFileState`, `MessageFileKind`, `FileTextState`, `TicketReadReason` |

**What the migration seeds:** nothing. The catalog's next sync fills `catalogInputModalities`.

**Blob purposes, new words:** `message-file` and `message-file-text`. A ticket's files keep `ticket-file`; their text is `message-file-text`.

### 5.4 `packages/domain` (tickets 05 and 06)

**Ticket 05: message files, the limits and the image decision.**
- **Detection:** `fileKindOf(bytes, name)` → `{ kind, contentType }`: PNG, JPEG, GIF and WebP by their magic bytes are `image`; PDF by `%PDF-`, and `.docx`, `.xlsx`, `.pptx` by a zip whose `[Content_Types].xml` names their main part, are `document`; valid UTF-8 with no NUL in its first 8 KiB is `text` (`text/plain`); anything else is `file` (`application/octet-stream`). The browser's type is never read. An SVG, a HEIC, an AVIF and a BMP are files.
- **`safeFileName`** (the protocol's) and **`boxPathFor(origin, seq, names)`**: `attachments/<seq>/<name>` or `ticket/<name>`, deduplicated within a folder as `name (2).ext`.
- **Limits:** `checkMessageFiles(files, limits)` → `{ kept, leftOut: [{ fileId, name, reason }] }`, and `checkTicketFiles` the same for the ticket's settings.
- **The image decision:** `modelImageInput(model)` → `yes` | `no` | `unknown`, from `adminImageInput`, then `catalogInputModalities`. `promptImagesFor(files, { agentTakesImages, modelImageInput })` → `{ images, notSent: "model" | "agent" | null }`: images only, at most `promptImagesMax` of `promptImageMaxBytes` each, the rest as files.
- **The upload token:** `createPanelFileTokens` beside `panel-blob-token.ts`: an HMAC under the secrets key over the organization, project, member, size and SHA-256, for a minute, never logged.
- **Lifecycles,** each a discriminated union with exhaustive tests, and drawn in `domain-model.md`:
  - a member's file: `uploaded` → `sent` | `expired`;
  - a ticket's file: `sent` | `left_out` | `failed`, and a `failed` one's retry makes a new file (`retryOfId`);
  - a file's text: `none` | `ready` | `failed` | `off`.
- **Use cases:**
  - `recordUpload` (core's endpoint, ticket 10) and `discardUpload` (the member's own unsent file only);
  - `bindMessageFilesInTx(tx, scope, { taskId, sessionId, clientMessageId, eventSeq, fileIds, model, agent })` → the event's `files`, `filesLeftOut` and `imagesNotSent`, and the steer's `files` and `images`;
  - `createPromptTask`, `sendMemberMessageInTx` and `reopenTask` take `fileIds` and call it, and a message may then have empty text; `tasks.send`'s own transaction (ticket 14) calls it too;
  - `taskSpecFilesOf(tx, taskId)`: every sent file of the task, for the spec.
- **Jobs, new names** (IDs only in payloads, ADR 0037): `files.sweep-unsent` (hourly; key: the hour).
- **Settings** (ticket 05 adds them, each with its line in `docs/configuration.md`): section 5.6's table.

**Ticket 06: a ticket's files and its changes.**
- **`ticketFilesToFetch(context, limits)`:** the files of `TicketContext.files` without `byOstra`, within the ticket's limits, and the left-out ones with their reasons; with `ticketFiles: "images"` only images; with `none` nothing, and a `not-fetched` note.
- **`ticketChanges(lastRead, context)`** → `{ description: string | null, comments: { new, edited }, files: TicketContextFile[] }`, against the `TaskTicketRead`: a description whose SHA-256 differs, comments with an ID not seen or an `updatedAt` later than seen (ostra's own left out), files whose source key wasn't read. Pure.
- **`ticketUpdatePrompt(changes, ticket)`:** ostra's words around the changes, the ticket's text inside the template's marked blocks (`markTicketInline`, F-064), as `refinePrompt` does. Nothing changed gives `null`.
- **The ticket template:** the built-in template drops its `## Images` section, since the runner's block names every file. A project's own template that keeps `{{#images}}` gets each image's place under the workspace root (`.ostra/ticket/<name>`), and its docs line says so.
- **Use cases:** `readTicketForTask` (the start's and each round's read: fetch, store, write the event and the round), `requestTicketUpdates` (a member's press, the driver's: enqueues the job), `retryTicketFiles` (the task's failed files: enqueues the job).
- **Jobs, new names:** `ticket.read-changes { taskId, reason, memberId, requestId }` (key: task and request).
- **The follow-up:** `linear-follow-up`'s message takes the files `filesInText` finds in its comment, fetched as a ticket's are and bound to it.

### 5.5 Core: the text out of documents (ticket 07)

In `apps/core/src/files/text/`, so only core carries it:
- **`extractText(bytes, kind, limits)`** → `{ state: "ready", markdown, words, truncated } | { state: "failed", reason }`, where `reason` is a code: `encrypted`, `damaged`, `too-big`, `too-many-parts`, `doctype`, `timeout`, `no-text`, `busy`.
- **The pool:** Node's `worker_threads`, two workers per core process *(working value)*, each with `resourceLimits` (256 MiB of heap *(working value)*), and 30 s a file *(working value)*, after which the worker is terminated and a fresh one takes its place. A file that waits more than 30 s for a worker is `busy`. The event loop never parses.
- **The Office reader:** `fflate`'s `unzipSync` with a `filter` that takes only the parts below and checks each one's declared size before inflating it: at most 2,000 entries and 100 MiB inflated *(working values)*. `@xmldom/xmldom` parses each part; a part holding `<!DOCTYPE` is refused. `.docx`: `word/document.xml`, paragraphs and runs with tabs and breaks, headings (`Heading1` to `Heading6` styles) as `#`, list paragraphs as `- `, tables as `|` rows. `.xlsx`: `xl/workbook.xml` for the sheets' names, `xl/sharedStrings.xml`, and each `xl/worksheets/sheet<n>.xml`'s cells' stored values as a Markdown table under `## <sheet>` (the lead's brief to ticket 07, 2026-11-21, over tab-separated rows). A big part (a body, a sheet's rows, the shared strings) is parsed a batch of its elements at a time, so its DOM stays small in the worker's heap. `.pptx`: each `ppt/slides/slide<n>.xml`'s `a:t` text under `## Slide <n>`, in their order in `ppt/presentation.xml`.
- **The PDF reader:** `unpdf`'s pdf.js, page by page, with `disableFontFace: true`, `useSystemFonts: false`, `useWasm: false`, no URL to fetch fonts, CMaps or decoders from, and no worker of pdf.js's own (pdf.js 6.5 has no `eval` path left: its `isEvalSupported` option is gone); an encrypted PDF is `encrypted`; a PDF with no text layer is `no-text`.
- **The output:** a first line, `Text extracted by ostra from <name> (<kind>). Layout, images and anything scanned may be missing.`, then the Markdown, cut at `fileTextMaxBytes` with a last line saying so.
- **Dependencies:** `unpdf` 2.2.1, `fflate` 0.8.3 and `@xmldom/xmldom` 0.9.12, exact, in `apps/core/package.json` with `pnpm-lock.yaml`; ADR 0007's list gains them. `pnpm check:licenses` and the core image's notices pass (`packages/deploy-checks`).
- **The fixtures** (`e2e/m9-attachments/fixtures/`, shared with the demo): each kind's normal file, an encrypted PDF, a scanned PDF, a PDF with JavaScript, a zip bomb named `.docx` (a small zip declaring a huge part), a zip of 5,000 entries, a `.docx` with a `<!DOCTYPE` and an entity, a `.xlsx` with 100,000 cells, and names with shell syntax and prompt-like text.

### 5.6 Settings

Each with a working default and its line in `docs/configuration.md` (ticket 05 adds them):

| Setting | Default |
|---|---|
| `OSTRA_MESSAGE_FILES_MAX` (server) | `10`, at most `20` |
| `OSTRA_MESSAGE_FILE_MAX_MIB` (server) | `10`, at most `25` |
| `OSTRA_MESSAGE_FILES_TOTAL_MIB` (server) | `25`, at most `64` |
| `OSTRA_TICKET_FILES_MAX` (server) | `20`, at most `50` |
| `OSTRA_TICKET_FILE_MAX_MIB` (server) | `10`, at most `25` |
| `OSTRA_TICKET_FILES_TOTAL_MIB` (server) | `50`, at most `200` |
| `OSTRA_FILE_TEXT_EXTRACTION` (server) | `true`; `false` reads no document's text |

Each limit is below `OSTRA_BLOB_MAX_MIB`'s ceiling (64), so a file always fits one blob. A fresh install with none of them set works as the table says.

---

## 6. Parity

### Adapter parity

| Feature | What it asks | OpenCode | Linear | The fakes |
|---|---|---|---|---|
| F-148: images as images | `promptImages`, and the agent's `promptCapabilities.image` | yes, with the model's inputs in its catalog and config (ticket 09) | — | a fake with it sends images on to the stub model; a fake without it gets paths only |
| F-148: files in the box and named in the prompt | nothing of the agent | yes | — | every fake |
| F-149: a ticket's files | `ticketFiles` | — | `all` (ticket 08) | the Jira fake `all`; the tiny adapter `none`, whose tasks start from text and say so |
| F-149: a follow-up's files | `filesInText`, with `ticketFiles` | — | yes | the fake Linear's agent session |
| F-150: text | nothing of the agent or the tracker | — | — | — |

The parity test (`packages/adapter-sdk/src/testing/parity.test.ts`) gains a row for each line above.

### Runner parity

| | `docker` | `kubernetes` | `host` |
|---|---|---|---|
| Where the files go | `<workspace root>/.ostra/`, the root the agent's container mounts | the same, in the pod's workspace volume | `<worktree root>/.ostra/`, beside the task's worktrees |
| Who writes them | the runner, as it writes a ticket's files now | the same | the same |
| Who can read them | the agent's user | the same | the account the task runs as |

None of this is a new allowed difference (ADR 0070). The executor suite gains one case, on each executor (the fakes for `docker` and `kubernetes`, live on `host`, live in the Linux jobs at the gate): files written under the root's `.ostra/`, outside every repo, readable by the agent, absent from each repo's `git status`, written again on a fresh box at the same place, and gone with the box. A personal runner and a pool runner write them the same way.

---

## 7. Packages, licenses and owners

| Package | License | New in M9 | Built by |
|---|---|---|---|
| `packages/protocol` | Apache-2.0 | minor 8: files in the spec, the steer and the events; the fixed words; the limits | core (01) |
| `packages/adapter-sdk` | Apache-2.0 | `promptImages` and the prompt's images; `ticketFiles`, `files`, `filesInText`; the suites' cases, the fakes, the stub models | adapters (02, 03) |
| `packages/adapters/adapter-linear` | Apache-2.0 | every file of a ticket; a follow-up's files | adapters (08) |
| `packages/adapters/adapter-opencode` | Apache-2.0 | the model's inputs in its catalog and config; `promptImages` | adapters (09) |
| `packages/adapters/adapter-model-endpoint` | Apache-2.0 | a catalog entry's input modalities | adapters (09) |
| `apps/runner` | Apache-2.0 | writing the files, the prompt's block and images, `files.written` | runner (13) |
| `packages/db` | Sustainable Use | the M9 migration, the isolation fixtures | core (04) |
| `packages/domain` | Sustainable Use | detection, names, places, limits, the image decision, the token, use cases, ticket changes, jobs, settings | core (05, 06) |
| `apps/core` | Sustainable Use | the text reader and its pool; `/panel/v1/files`; the sweep; files in the spec, the dispatch and the restore; the catalog sync; the ticket's files, changes and Retry | core (07, 10, 11, 12) |
| `packages/api` | Sustainable Use | uploads, sending with files, downloads, the ticket's context, updates and Retry, a model's image input | api (14) |
| `apps/web` | Sustainable Use | the tray in every box, the drop zone, files in the thread, "What the agent got", the provider's switch, the upload and download route handlers | web (15, 16), api (14) |
| `apps/docs` | Apache-2.0 | the pages of ticket 17 | core (17) |
| `e2e/m9-attachments` (new) | Sustainable Use | the demo and the fixtures | core (07, 18) |

The license line holds (ADR 0045, ADR 0048): no Apache-2.0 package depends on a Sustainable Use one. The runner gets files on the bulk path and imports only `packages/protocol`. `pnpm check:licenses` runs on every commit.

---

## 8. The builders and their tickets

Five builders, as before: **core**, **runner**, **web**, **api** and **adapters**. Core and adapters make the contracts first (01 to 06), each with the fakes its callers need. Core's text reader (07) has no blocker and starts at once. The web tickets wait for the targets the design agent is making now in `context/brand/app-targets/m9/`, approved by the maintainer. Ticket 19 is the maintainer's.

| # | Ticket | Builder | Blocked by |
|---|---|---|---|
| 01 | Protocol: minor 8 | core | none |
| 02 | Adapter SDK: images in an agent's prompt | adapters | 01 |
| 03 | Adapter SDK: a ticket's files | adapters | none |
| 04 | DB: the milestone 9 migration | core | none |
| 05 | Domain: message files, the limits and the image decision | core | 01, 04 |
| 06 | Domain: a ticket's files and its changes | core | 03, 04, 05 |
| 07 | Core: the text out of documents | core | none |
| 08 | Linear adapter: every file of a ticket | adapters | 03 |
| 09 | OpenCode and the catalog: a model's image input | adapters | 01, 02 |
| 10 | Core: uploads and the unsent sweep | core | 05, 07 |
| 11 | Core: files in the spec, the dispatch, the steer and the restore | core | 05, 09 |
| 12 | Core: a ticket's files, its changes and Retry | core | 06, 07, 10, 11 |
| 13 | Runner: writing the files and prompting with them | runner | 01, 02 |
| 14 | API: uploads, sending with files, downloads and the ticket's context | api | 10, 11, 12 |
| 15 | Web: files in the message box and the new-task box | web | 14; the targets in `context/brand/app-targets/m9/` approved |
| 16 | Web: files in the thread, the ticket's context and a model's image input | web | 14; the targets in `context/brand/app-targets/m9/` approved |
| 17 | Docs: files for the agent | core | 14 |
| 18 | The end-to-end demo and the ledger (at the launch gate) | core (lead) | 02 to 17; the maintainer's word for the launch gate |
| 19 | The maintainer's steps outside the code | maintainer | none for the approvals; 18 for the review of the run |

**Who starts when.**
- **core** takes 01, 04 and 07 at once, then 05 and 06, then 10, 11 and 12 as their blockers land.
- **adapters** take 03 at once, 02 after 01, 08 after 03, and 09 after 02.
- **runner** takes 13 after 01 and 02, against the scripted fake agent.
- **api** starts 14 once 10 is in, and adds each part as 11 and 12 land.
- **web** builds 15's and 16's data hooks and tests against 14's procedures as they land, and their UI once the targets are approved (recorded in each ticket's `## Comments`).

Milestone 8's remaining tickets (its demo, 33, and the maintainer's, 34) touch no file of these. A ticket that meets an open one on the same package waits for it, and says so in its `## Comments`. The launch gate's tickets stay held, and run after milestone 9.

---

## 9. Test seams

Agreed here so builders don't each invent one.

- **Postgres:** milestone 1's helper, a database per test file. Every test that reads data also checks that another organization's rows and a restricted project's rows stay invisible. Milestone 4's generated isolation test gets a fixture for `MessageFile` and `TaskTicketRead`.
- **The fixtures:** `e2e/m9-attachments/fixtures/` (ticket 07), made by a script in the same folder where a fixture is generated (the zip bomb, the 5,000-entry zip, the big workbook), so no binary over 1 MiB is committed.
- **The model:** the stub models of `@ostra/adapter-sdk/testing`, in both API formats, recording image parts. OpenCode's live contract tests run the pinned binary against them, as milestones 3 and 4 did.
- **The tracker:** the fake Linear (`testing/fake-linear/`) gains uploads (inline images and file links on its file host, attachments of both kinds, a comment by ostra's app user, a download that fails on demand, a 12 MiB file), and agent sessions whose `prompted` comment holds a file. The Jira fake as section 5.2 says.
- **The runner:** the bulk path's fake server (milestone 2) serves blobs and digests, and one with a wrong digest. The executor suite's fakes as milestone 5 left them.
- **Time:** the sweep and the token's minute read the `Clock` port.
- **Text that is data:** every test of a file's name, content, extracted text or ticket text holds shell syntax, prompt-like text and a path with `..`, and asserts none reaches a log line, a shell command or a process's argument list, and no file lands outside `.ostra/`.
- **The worker pool:** a test pool of one worker with a 2 s timeout, so the time and memory cases run fast.

---

## 10. Every ticket's checks and commit

As milestones 1 to 8 (`../m8-previews-and-library/spec.md`, section 10), and the lead's rules (`C:/Users/santi/ow/_lead/AGENT-RULES.md`). In short:
- **Checks once, then push.** `pnpm typecheck`, `pnpm lint` and `pnpm test` for the touched packages (and their direct consumers when a shared type changes), with `--cache-dir=C:/Users/santi/ow/.turbo-cache`, once before each push. `pnpm check:licenses` passes. GitHub CI runs the rest; a failure from the change is fixed forward.
- **The whole-repo checks** run for tickets that touch the schema, the runner protocol, credentials or anything that runs on untrusted input: 01, 02, 04, 07, 10, 11, 12 and 13.
- **Browser specs run once,** at the milestone's end (ticket 18). A fix that needs browser proof runs only its own spec file.
- **A ticket's "(break-it: ...)"** names what its test must catch, and nothing more: no break-it pass runs (the maintainer, 2026-11-21: "keep tests, drop extras").
- **Every new setting** has a working default and its line in `docs/configuration.md`. A fresh install with only the required settings works, with every message box taking files at the defaults.
- **Proof:** each condition of a row's "done when" has a test named with its key (`it("F-148/c1: ...")`) that exercises it through the real code path, and CI runs it. No proof file. A condition only a live run shows waits for the launch-gate Proof run.
- **No secret in the commit,** and no file name, content or ticket text in a log line.
- **Dependencies:** only section 11's three, in ticket 07. A `package.json` change goes with its `pnpm-lock.yaml`.
- **Stage only the ticket's own paths,** no `git add -A`, no stash. A gitmoji message of at most 50 characters, no AI attribution. Rebase onto `origin/main`, then push to `origin main`.
- **Work in a worktree** under `C:/Users/santi/ow/<name>` from `origin/main`, never in `c:/Users/santi/ostra`. Kill every process started with its whole tree, and remove the worktree at the end.
- The ticket file gets its `Status:` updated and a line under `## Comments` with the commit's hash.

### 10.1 How each row gets proved

A condition's key is its sentence's place in the row's "done when" (`features.md`), as before.

**F-148 Files in messages:**
- c1: files in the new-task box and every later message, by paperclip, paste and drop, any type, removable; files alone make a message (15, 05, 14)
- c2: the limits, refused in the box with a note, checked again at send and left out with a note (05, 14, 15)
- c3: blobs of the task, shown under the message, downloadable with the fixed headers, the same 404 outside (14, 16)
- c4: written under the root's `.ostra/attachments/<n>/`, outside every repo, checked, named in the prompt, never committed, on every executor (01, 13, the executor suite) — **needs** the Linux jobs for `docker` and `kubernetes` live
- c5: images as images where `promptImages` and the model's input allow, in both formats; otherwise files, and the box and the thread say so (02, 05, 09, 11, 13, 15, 16)
- c6: every earlier file back on a fresh box (11, 13)
- c7: unsent uploads deleted after 24 hours (10)
- c8: names and contents in no log line, command or argument; names made safe (01, 05, 10, 13)
- c9: a minor-7 runner refused, and the box says why (01, 11, 15)

**F-149 Ticket files as context:**
- c1: the whole ticket, every file, links as title and URL (06, 08, 12)
- c2: fetched in core within the ticket's limits; the credential never in the box (12)
- c3: left out and failed named in the prompt and the thread; the task starts; Retry (06, 12, 14, 16)
- c4: the files reach the agent under `.ostra/ticket/`, as a member's; the text inside marked blocks (06, 12, 13)
- c5: the first message shows what the agent got (14, 16)
- c6: `ticketFiles` declared, the suite passing for Linear and the Jira fake, `none` starting from text and saying so (03, 08, 12, 16)
- c7: a reopen reads the ticket again and passes on what changed (06, 12)
- c8: "Send ticket updates", and "nothing new" (06, 12, 14, 16)
- c9: a follow-up's files (06, 08, 12)

**F-150 Text out of documents:**
- c1: text for `.docx`, `.pdf`, `.xlsx` and `.pptx`, beside the file as `.md`, both paths in the prompt, "text extracted" on the chip (07, 10, 12, 13, 15, 16)
- c2: core only, a worker with a time and a memory limit, the caps, DOCTYPE refused, 1 MiB, nothing run or fetched (07)
- c3: an unreadable document still attached, "no text" with the reason, never a failure (07, 10, 12)
- c4: `OSTRA_FILE_TEXT_EXTRACTION=false` (05, 10)
- c5: `unpdf`, `fflate` and `@xmldom/xmldom` pinned; the license checks; none in the runner's image (07)
- c6: the text in no log line (07, 10)

---

## 11. Dependencies

The maintainer allowed new dependencies for this work (2026-11-21, through the lead). Three, in `apps/core` only, each pinned exactly, each MIT with no dependency of its own (research §5):

| Package | Version | License | For | If withdrawn |
|---|---|---|---|---|
| `unpdf` | 2.2.1 | MIT (it bundles Mozilla's pdf.js, Apache-2.0) | A PDF's text layer, page by page | `pdfjs-dist` 6.5.438 (Apache-2.0) directly, its legacy build |
| `fflate` | 0.8.3 | MIT | Reading an Office file's zip, part by part, with the declared sizes checked first | Node's `zlib` with ostra's own reader of a zip's central directory |
| `@xmldom/xmldom` | 0.9.12 | MIT | Parsing each Office part's XML | A small tokenizer of ostra's own for the few elements read |

**Considered and not added:** `mammoth` (its `jszip` is `(MIT OR GPL-3.0-or-later)`, which the images' notices check refuses, and it brings about twenty packages), `officeparser` (an OCR engine that fetches its data at run time), `pdf-parse` (a native module), and `pdfjs-dist` directly (larger, and `unpdf` packs the build Node needs). The runner adds nothing. ADR 0007's list gains the three (ticket 07).

---

## 12. Choices this spec makes

Each is recorded in `context/open-questions.md`'s settled list under its number, and in ADR 0070. Q327 to Q331 are the lead's proposal, which the maintainer accepted on 2026-11-21. Q332 to Q341 are the lead's call on the research, which the maintainer can still change: such a change moves the question back to the open list, and the ticket that holds it changes.

**The lead's proposal, accepted:**
1. **Chat attachments, any time** (Q327). In the new-task box and in every message after it (a message, a reply, an interrupt, a reopen): paste, drag and drop, or a paperclip; thumbnails and chips, removable before sending; any file type.
2. **What the agent gets** (Q328). Images to the model as images where the model takes them, with a warning in the box where it doesn't; every file in the workspace, outside the repo, with its path in the prompt; documents with their text beside them.
3. **Ticket attachments** (Q329). The full ticket as context: description, comments, every file inline or attached, through the tracker adapter, as a declared capability for Linear now and Jira later.
4. **Storage** (Q330). ostra's blobs, kept with the task, shown in the thread, downloadable by anyone who can see the task, with fixed content types, `nosniff` and a sandbox, never run and never put into a command.
5. **Limits** (Q331). 10 files a message, 10 MiB each and 25 MiB in all; a ticket's 20 files, 10 MiB each and 50 MiB in all; settings with those defaults; too big or too many left out with a note, never a failure.

**The lead's call:**

6. **How images reach OpenCode** (Q332). ACP `image` blocks with base64 data, in `session/prompt` and `_session/steering`, behind the agent capability `promptImages` and the agent's own `promptCapabilities.image`; and the model's input modalities written into OpenCode's catalog file and config, without which OpenCode turns every image into an error line. No `resource_link`. The fallback is the file and the agent's read tool.
7. **Where files live in the box** (Q333). Under the workspace's root, outside every repo: `.ostra/attachments/<n>/` for a message's, `.ostra/ticket/` for the ticket's, the text beside each as `.md`; written again on every fresh box; the runner names the absolute paths in the protocol's fixed words.
8. **Where and how text is read** (Q334). In core, when the file comes in, in a worker pool with time, memory and size limits; `.docx`, `.xlsx` and `.pptx` by ostra's own reader on `fflate` and `@xmldom/xmldom`, `.pdf` by `unpdf`; no OCR; `OSTRA_FILE_TEXT_EXTRACTION` turns it off.
9. **Which model takes images** (Q335). models.dev's `modalities.input`, kept on each model by the catalog sync, and an organization admin's "Reads images" per model, which wins; unknown counts as no.
10. **A ticket's changes after the start** (Q336). Never pushed into a running agent by themselves; a reopen reads the ticket again and passes on the changes; "Send ticket updates" does so on a member's press; a follow-up brings its own files.
11. **Links** (Q337). A ticket's link attachments go as title and URL, and nothing behind them is fetched.
12. **Uploads** (Q338). One file a request, through the web app to core with a one-minute token; bound to a message at send; deleted after 24 hours unsent.
13. **Which images are images** (Q339). PNG, JPEG, GIF and WebP, told by their bytes. HEIC, AVIF, BMP and SVG are files, and an SVG is never drawn as an image.
14. **The protocol** (Q340). Minor 8; a task or a message with files goes only to a minor-8 runner, and the box says when the task's runner needs upgrading.
15. **Video and audio** (Q341). Files only, within the limits: no frames and no transcripts.

The design targets' own open points (where the tray sits, one `Attachments` group in the properties panel, captions, "What the agent got" as the first message, the drop zone's extent) are settled by the maintainer's approval of the targets, not here. Where a target says the limits are fixed with no setting, this spec's settings win, and the box reads the limits from the server.

---

## 13. Screens and their targets

`build-order.md`: a milestone's screens are designed first, image first. **The targets are being made now** by a design agent, in `context/brand/app-targets/m9/` (the `m9-targets` worktree), each with its picture, its build spec and its HTML source, against `context/brand/brief.md`, `context/brand/app-design.md` and milestone 8's double-sidebar shell. Tickets 15 and 16 build them once the maintainer approves them, and record the approval in their `## Comments`. Until then their data hooks and tests can go ahead, not their UI.

| Target (in `app-targets/m9/`) | Screen | Feature | Ticket |
|---|---|---|---|
| `composer-attachments` (with `composer-drop`, `composer-states`, `composer-phone`) | The task page's message box: the tray, the paperclip, paste, the drop zone over the chat column, every limit's note, a failed upload and Retry, Send while uploading, the model's warning, the phone's dock | F-148 | 15 |
| `new-task-attachments` | The new-task box on the project page and the new-task page, as a drop zone, with its tray | F-148 | 15 |
| `message-attachments` (with `message-attachments-viewer`) | A member's message in the thread: thumbnails opening milestone 8's viewer, chips that download, "text extracted", the model's line; the properties panel's `Attachments` group | F-148, F-150 | 16 |
| `ticket-context` (with `ticket-context-skipped`, `ticket-context-failed`) | "What the agent got" as the ticket task's first message: the description, files, links, comments, the box's place and "Show the prompt"; left out and failed files with Retry | F-149, F-150 | 16 |

**Screens that only grow,** built against their existing targets with the changes listed in the building ticket's `## Comments`:
- The provider's models (`app-targets/m4/` and the provider page as built): a model's "Reads images" switch and what the catalog says (16).
- The task page's ticket card (`app-targets/m2/task-ticket`): "Send ticket updates" and its answer (16).
- The thread's `ticket-update` message (`app-targets/m1/task`): its marker and its files (16).
