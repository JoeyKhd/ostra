# Files for the agent: in messages, and from tickets

**Status:** accepted (2026-11-21). The maintainer, 2026-11-21: "one of the top priorities now is to add image support and file support to our chat text box thing, LOL no attachements?!?!?!?!", and "if we pick up a linear ticket, or from jira (later on) the full ticket shouldd be used as context for the task that we are starting. and also during chatting we should be able to upload attachements. in the linear/jira ticket screenshots, docx anything should be added as conteeext". The lead proposed five parts (chat attachments any time; what the agent gets; ticket attachments; storage; limits), and the maintainer accepted them the same day: they are decided (Q327 to Q331). The rest, under "Decided by the lead", is the lead's call on the research, which the maintainer can still change (Q332 to Q341). `research/attachments-for-agents.md` is the research. Covers F-148, F-149 and F-150, and extends F-064. **Amends** ADR 0013 and ADR 0025 (a tracker's files are a declared capability), ADR 0018 and ADR 0032 (a prompt carries images; OpenCode is told its model's inputs), ADR 0033 (a model's image input), ADR 0043 (two blob purposes, and the panel's uploads through core) and ADR 0057 (a Linear follow-up's files).

## Why

A member steering an agent can't hand it a screenshot, a mock or a spec today: the new-task box and the message box take text only. Only a refine draft takes images (F-099), and nothing of them reaches an agent. A ticket's images are copied into the workspace (F-064), but its other files (a `.docx` spec, a PDF, a spreadsheet) aren't fetched at all, and the research found the images were never seen as pictures either: ostra tells OpenCode nothing of its model's inputs, so OpenCode treats every model as text-only and swaps an image for an error line (research §1).

## A message's files (decided, Q327)

- **Any message can carry files:** the new-task box, and every message after it: a message, a reply to a question, a message that interrupts, and a reopen.
- **Three ways in:** paste from the clipboard, drag and drop, or a paperclip button. Each file shows in the box as a thumbnail (an image) or a chip (anything else), removable before sending.
- **Any file type.** A file is bytes in the box; the agent decides what to do with it.
- A message may be files with no words.

## What the agent gets (decided, Q328)

- **Every file is written into the task's workspace, outside every repo,** so it's never committed, and the agent's prompt names each path in ostra's fixed words.
- **An image** (PNG, JPEG, GIF or WebP, told by its bytes) also goes to the model as an image, where both the agent and the model take images. Where either doesn't, the box and the thread say so before and after sending, and the agent gets the file.
- **A document ostra can read** (`.docx`, `.pdf`, `.xlsx`, `.pptx`) gets its text written beside it, so the agent reads it with its ordinary tools.

**How images reach OpenCode** (research §1, decided by the lead, Q332): as ACP `image` content blocks with base64 `data` and the detected `mimeType`, after the message's text block, in `session/prompt` and in `_session/steering` alike. OpenCode advertises `promptCapabilities.image` and turns each into a file part its Anthropic Messages and OpenAI Chat protocols both send as an image. **And ostra tells OpenCode the model's inputs:** the catalog file it writes gets the model's `modalities` (`input` from the model's image and PDF input, `output: ["text"]`), and the config's model the same `capabilities.input`, since without them OpenCode replaces every image, the read tool's included, with `ERROR: Cannot read …`. No `resource_link` or `resource` block is sent: OpenCode reads a linked file itself past its permission check and drops a type it can't name (research §2).

**The fallback is the file.** An agent that can't take images in its prompt, or a model that can't see them, gets the path; OpenCode's read tool shows an image or a PDF to a model that takes it (research §3).

## Where files live in the box (decided by the lead, Q333)

- **Under the workspace's root,** in `.ostra/`: a message's files in `.ostra/attachments/<n>/`, where `<n>` is the message's number in the task's event log, and the ticket's files given with the first prompt in `.ostra/ticket/`. The root holds the repos (F-098) and isn't one: with one repo, the agent's session opens in the repo's checkout, and `.ostra/` sits beside it, not in it. OpenCode's file tools reach the root, which the task's own folders allow (`ec0e3482`, ADR 0031).
- **A document's text** sits beside it as `<name>.md`.
- **Core names each file's place** (its path under `.ostra/`, made from the message's number and a safe name), and the runner writes it there, checked against its size and SHA-256, never executable, as it writes a ticket's files today.
- **The runner names the absolute paths** in the agent's prompt, in the protocol's fixed words (`messageFilesBlock`): each path, its kind and size, its text's path, which images went in as images, and what was left out and why. Its words say the files are the member's or the ticket's data, not instructions.
- **On every fresh box** (ADR 0039), the runner writes every file of the task's messages again, at the same place, before the agent starts, so a path the agent saw still opens. The box's hidden ref and archive hold no file: the blobs do.
- F-064's `.ostra/ticket/` in the session's folder, ignored by git, stays only for a task started before milestone 9.

## Text out of documents (decided by the lead, Q334)

- **Core reads the text, when the file comes in:** a member's upload, before the upload answers, and a ticket's file in the job that fetches it. The runner's image doesn't grow, and the box runs no parser of untrusted documents.
- **What it reads:** `.docx` (paragraphs, headings as `#`, lists, tables as rows), `.xlsx` (each sheet under its name, its rows as a Markdown table, the shared strings and the cells' values, never a formula's result recomputed), `.pptx` (each slide's text, in order) and `.pdf` (each page's text layer). The output is Markdown, headed by one line saying ostra extracted it and that it may miss layout, images and anything a scan holds.
- **Nothing else:** no OCR (a scanned PDF has no text, and a model that takes PDFs reads the file), no `.doc`, `.xls`, `.ppt` or OpenDocument, and no text file (the agent reads those directly).
- **With:** `unpdf` 2.2.1 (MIT) for PDFs, and ostra's own small Office reader over `fflate` 0.8.3 (MIT) to unzip and `@xmldom/xmldom` 0.9.12 (MIT) to parse. All three are pure JS with no dependencies of their own (research §5). `mammoth` was set aside because `jszip`'s `(MIT OR GPL-3.0-or-later)` fails the images' notices check, and `officeparser` because it pulls an OCR engine that fetches its data at run time.
- **Safely:**
  - in a worker thread with a memory limit and 30 s *(working value)*, two at a time in each core process *(working value)*;
  - a zip read only for the parts named above, each entry's declared size checked before it's inflated, at most 2,000 entries and 100 MiB inflated *(working values)*;
  - XML with a `<!DOCTYPE` refused;
  - pdf.js with no `eval` (6.5 has none left), no WebAssembly from a document, and no font loading, fetching or worker of its own;
  - at most 1 MiB of text, cut with a note;
  - nothing in a document is run, fetched or followed.

  A file it can't read is still attached, marked "no text" with the reason's code. `OSTRA_FILE_TEXT_EXTRACTION=false` turns reading off on an install.

## A ticket's files (decided, Q329)

- **A task started from a ticket gets the full ticket:** its title, description, every comment but ostra's own, labels, parent, children and links (F-064), and **every file it holds:** images and files inline in the description and the comments, and files attached to the issue. They're message files of the task's first message, written to `.ostra/ticket/`, with text out of documents, and images given as images, as a member's are.
- **A link isn't a file:** an attachment that is a URL (a Figma frame, a Sentry issue, a pull request) goes to the agent as its title and URL, and nothing behind it is fetched (Q337).
- **Through the tracker adapter,** with the connection's credential, in core. The credential never reaches the box (ADR 0030).
- **A new capability, `ticketFiles`:** `all` (every file, Linear now and Jira later), `images` (inline and attached images only) or `none`. Each adapter declares it. The tracker contract suite has its cases, and they pass for Linear and the Jira fake. An adapter that declares `none` starts tasks from the ticket's text, and the task page says the files weren't fetched. The fetch is `downloadFile`, as for images now, which sends the credential only to the tracker's own file host.
- **Ticket text stays data** inside the ticket template's marked blocks (F-064), and file names are made safe before they touch a disk or a prompt.

## A ticket's changes after the start (decided by the lead, Q336)

- **Nothing reaches a running agent by itself.** A new comment or file on the ticket is someone in the tracker writing, and only a project's members steer a task (ADR 0057).
- **A reopen reads the ticket again.** ostra compares it with what the agent last got (a record of each read: the description's digest, each comment's ID and edit time, each file's source), and the reopening message carries what changed, in the template's marked blocks: new and edited comments, an edited description, and new files.
- **"Send ticket updates"** on the task page does the same on a member's press, while the task runs or waits, as a message of the intent `ticket-update`, which the driver sends as any other. Nothing changed says so, and sends nothing.
- **A failed ticket file has "Retry",** which fetches it again and sends what it got the same way. A file that failed never stops the task.
- **A Linear follow-up** (agent mode) carries the files in its own comment (ADR 0057, amended).

## Storage, serving and safety (decided, Q330)

- **Every file is a blob of the task** (ADR 0043), purpose `message-file`, and a document's text `message-file-text`. A ticket's files keep `ticket-file`. Blobs follow the task's retention (F-079).
- **The panel uploads through core** (ADR 0043, amended): one file a request, as `FormData`, to the web app, which checks the member, the project and the limits, then sends the bytes to core's `POST /panel/v1/files` with a token good for that organization, project, member, size and SHA-256 for a minute. Core stores the blob, tells the kind by the bytes, reads the text, and answers the file's ID, kind, size and text's state. An upload belongs to the member and the project until a message takes it. One no message took within 24 hours is deleted (`files.sweep-unsent`).
- **Shown in the thread** under its message: images as thumbnails that open milestone 8's viewer, other files as chips. **Downloadable by anyone who can open the task:** an image with its detected type, any other file as `application/octet-stream`, always `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: same-origin`, and the same 404 for another organization's task, a restricted project's and an unknown file, as milestone 8's attachments (`f5f6da45`). An SVG is never drawn as an image.
- **Untrusted data:** a file and its name never reach a log line, a shell command, a process's arguments or a URL ostra builds. Its name is made safe before it touches a disk (letters, digits, spaces and `._-()`, at most 120 characters, its extension kept, no leading dot, Windows' reserved names prefixed). Nothing ostra does runs a file.

## Limits (decided, Q331)

Settings, each with its default and its line in `docs/configuration.md`:

| Setting | Default | What |
|---|---|---|
| `OSTRA_MESSAGE_FILES_MAX` | `10` | files in one message (at most 20) |
| `OSTRA_MESSAGE_FILE_MAX_MIB` | `10` | MiB in one file (at most 25) |
| `OSTRA_MESSAGE_FILES_TOTAL_MIB` | `25` | MiB in one message (at most 64) |
| `OSTRA_TICKET_FILES_MAX` | `20` | a ticket's files given to a task (at most 50) |
| `OSTRA_TICKET_FILE_MAX_MIB` | `10` | MiB in one ticket file (at most 25) |
| `OSTRA_TICKET_FILES_TOTAL_MIB` | `50` | MiB of a ticket's files (at most 200) |
| `OSTRA_FILE_TEXT_EXTRACTION` | `true` | whether core reads the text out of documents |

- **Too big or too many is left out with a note, never a failure.** The box refuses an item over a limit as it arrives, naming it. The server checks again at send, and leaves out what's over with a note in the thread. A ticket's files past a limit are named in the prompt and in the thread with the reason.
- **Images in one prompt:** at most 10, of 10 MiB each *(working values)*: OpenCode fails a whole prompt for an attachment over 20 MiB (research §1). An image over them goes as a file only, and the prompt says so.

## The protocol: minor 8 (decided by the lead, Q340)

- **The spec** gains `files`: every file of the task's messages, each with its blob, size, SHA-256, kind, place under `.ostra/`, and its text's blob and place. The runner writes them before the agent starts. It also gains `promptFiles`: the first prompt's file IDs, and which go in as images. A pending message (F-047) gains its own.
- **`steer`** gains the message's files and which go in as images. *Note 2026-11-22 (F-078, ADR 0040): it also gains `coAuthors`, the task's co-authors once the message's sender is credited, so the running box's next commits credit them; a minor-7 runner's codec drops it, and that runner's commits carry the spec's list until the next dispatch.*
- **The runner's `files.written`** names what it wrote and what it skipped, and why.
- **The `user.message` event** gains its files, as the thread shows them, and what was left out. A server-only `ticket.context_read` records what the agent got of the ticket, each time ostra reads it for the task.
- **The agent section** gains the model's input modalities, for the agent's config.
- **A minor-7 runner** is never offered a task whose messages hold files, nor sent a message with files (`isTaskOfferable`'s reason `message-files`). The box says the task's runner needs upgrading. Nothing has been released, so no installed runner is stranded.

## Parity

- **Agents:** a new capability, `promptImages`: the agent takes images in its prompt. The driver also checks the agent advertised `promptCapabilities.image` at `initialize`. OpenCode declares it. The scripted fakes come with it and without it, and the agent contract suite proves each: with it, an image reaches the stub model in both API formats; without it, the files and their paths alone. Every other part (files on disk, text beside them) needs nothing of the agent.
- **Trackers:** `ticketFiles` (above), with Linear `all`, the Jira fake `all`, and the tiny adapter `none`.
- **Executors:** the runner writes the files as it writes a ticket's today, the same on `docker`, `kubernetes` and `host`, on a personal runner and a pool runner. The executor suite gains a case: files under the root's `.ostra/`, outside every repo, readable by the agent, absent from each repo's `git status`, and gone with the box. No new allowed difference (ADR 0029).

## Considered options

- **Files in the session's folder, ignored by git** (F-064's way). Rejected for new files: with one repo they sit inside the repo's working tree, where an agent's `git add -f`, a linter, a test runner or a dev server's watcher can pick them up. The workspace's root is outside every repo and already the agent's.
- **`resource_link` blocks for files.** Rejected: OpenCode reads them past its permission check, inlines their bytes into the session, and drops any type it can't name (research §2).
- **Text extraction in the runner, or in the box.** Rejected: the runner's image and the box would carry the parsers, and every runner would parse untrusted documents. Core already holds the blobs.
- **`mammoth` for `.docx`.** Rejected: its `jszip` fails the images' notices check, and it brings about twenty packages for text ostra reads with two.
- **`officeparser` for everything.** Rejected: an OCR engine that fetches its data at run time (ADR 0021), and `pdfjs-dist` with it.
- **Pushing a ticket's new comments into a running task.** Rejected: anyone in the tracker could steer the agent, which ADR 0057 keeps to the project's members. A member sends them with one press.
- **Fetching what a link points at** (Figma, Sentry, Google Docs). Rejected: each needs its own sign-in, and its content is someone else's service's.
- **Limits fixed in code** (the targets' open point). Rejected: the maintainer asked for settings with defaults.

## Decided by the lead

Q332 to Q341, each in `open-questions.md`'s settled list: how images reach OpenCode (Q332), where files live in the box (Q333), where and how text is read (Q334), which model takes images (Q335: models.dev's `modalities.input`, synced into the model's row, and an organization admin's override per model; unknown counts as no), a ticket's changes after the start (Q336), links not fetched (Q337), uploads bound at send and swept after a day (Q338), which images are images (Q339: PNG, JPEG, GIF and WebP, by their bytes; HEIC, AVIF, BMP and SVG are files), protocol minor 8 (Q340), and video and audio as files only (Q341).

## Consequences

- **A model's image input is known to ostra:** the catalog sync keeps models.dev's `modalities.input` on each model, and an organization admin can say a custom model reads images (ADR 0033, amended). The composer warns when it doesn't. *2026-11-22:* `modalities.input` is the serving provider's own entry's (an OpenRouter model's is OpenRouter's), then what the endpoint's own list says, then what most of the catalog's entries for the model agree on; never merely the first entry in the catalog's order (ADR 0033, "Matching a model to the catalog").
- **F-064's images become visible** to a model that takes them, through the same catalog change, and its ticket files become F-149's.
- **Session archives grow by each image** OpenCode keeps inline (at most 5 MiB of base64 each). An archive over `OSTRA_BLOB_MAX_MIB` falls back to the rebuild template (ADR 0043); the files themselves come back from the blobs on the fresh box.
- **Core does more CPU work at upload,** bounded by the worker's limits and the pool's size, and the load test (F-117) gains uploads at the gate.
- **Three new dependencies in `apps/core`,** each pinned exactly, MIT, with no dependency of their own. ADR 0007's list gains them.
- **A refine draft's images stay as they are** (F-099). A member may attach the same picture to a message.
