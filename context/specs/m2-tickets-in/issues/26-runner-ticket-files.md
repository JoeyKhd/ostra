# 26: Runner: ticket files in the workspace

Status: done
Builder: runner
Blocked by: 02, 12
Features: F-064
Packages: `apps/runner` (`src/task-host/`)
Spec: `../spec.md`, sections 5.1 (`contextFiles`) and 11 (item 9)

## What to build

- **Before the agent starts,** each of the spec's `contextFiles` is downloaded through the bulk path, its digest checked, and written under `.ostra/ticket/` in the workspace, with a file name the runner makes from the blob ID and the content type, never from the ticket's text.
- **`.ostra/` is excluded** from git in every repo (`.git/info/exclude`), so the files never land in a commit or the hidden ref.
- Then `ticket.files_ready` with the paths, so the panel can show them.
- A file that fails to download is skipped and named in the event; the turn still starts.
- Only image and PDF content types are written *(working value)*; anything else is skipped.

## Done when

- [x] Tests: files land under `.ostra/ticket/` with safe names; a path in a ticket can't escape the folder; the files aren't in a commit or the hidden ref; a failed download doesn't stop the turn.
- [x] Committed as `✨ write ticket files into the workspace`.

## Comments
- 2026-11-20, runner: done in the commit after `4b9f1ee` on `main` (`✨ write ticket files into the workspace`), which added what this needed to the protocol, additively: `ticketFileNameFor`, `TICKET_FILE_EXTENSIONS`, and minor 2's optional `skipped` on `ticket.files_ready` (`4b9f1ee`, `✨ say why on a skipped file and a rebuilt restore`). Whole-repo typecheck and lint, the runner's and the executors' tests, and check:licenses green. For tickets 18, 36 and 39:
  - **The file's name is `ticketFileNameFor(blobId, contentType)`** (`packages/protocol/src/events/agent-events.ts`): the blob ID with anything but letters, digits and `-` replaced, then the type's extension, such as `0196f1a0-….png`. The runner writes the file under the name it makes, whatever `path` says, and `ticket.files_ready` names it so. Core's own `ticketFileNameFor` (`apps/core/src/dispatch/restore-spec.ts`, ticket 18) gives the same name for its UUID blob IDs and the image types; it answers `bin` for a PDF, where the runner writes `.pdf`, so **core's prompt should use the protocol's function** (a one-line swap for ticket 18's builder) before PDFs are copied.
  - **Where:** `.ostra/ticket/` in the folder the agent's session opens on: the repo's checkout with one repo (so the prompt's relative `.ostra/ticket/<name>` finds it from there), the workspace root with several (ticket 44's scan already leaves `.ostra` out). The host executor writes `/.ostra` into every checkout's `.git/info/exclude` when it prepares it, so neither `commitAndPush` nor the hidden ref carries the files.
  - **Checks:** the size the spec names and the SHA-256 core sends in `x-ostra-sha256` (a download without it is refused as `digest-mismatch`); only `image/png`, `jpeg`, `gif`, `webp`, `avif`, `bmp`, `svg+xml` and `application/pdf` are written. A file that fails is skipped with its reason (`type-not-allowed`, `download-failed`, `digest-mismatch`, `write-failed`), named in `skipped` (stripped for a minor-1 server), and the turn starts anyway. The event goes up before the agent starts, only when the spec has files.
