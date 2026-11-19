# 26: Runner: ticket files in the workspace

Status: ready-for-agent
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

- [ ] Tests: files land under `.ostra/ticket/` with safe names; a path in a ticket can't escape the folder; the files aren't in a commit or the hidden ref; a failed download doesn't stop the turn.
- [ ] Committed as `✨ write ticket files into the workspace`.

## Comments
