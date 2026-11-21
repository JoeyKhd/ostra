# 13: Runner: writing the files and prompting with them

Status: ready-for-agent
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

- [ ] Tests named for `F-148/c4`: the executor suite's case on the `docker` and `kubernetes` fakes and live on `host`: files under the root's `.ostra/`, outside every repo, readable by the agent's user, absent from each repo's `git status`, gone with the box; a path that would leave `.ostra/` is refused (break-it: write under the session's folder, and the `git status` case fails on a one-repo task).
- [ ] Tests named for `F-148/c5`: with the scripted fake that advertises images, the image reaches the stub model; with the one that doesn't, the block names the path and `files.written` says `agent-did-not-advertise`.
- [ ] Tests named for `F-148/c6`: on a fresh box every file of the spec is back at its place before the session starts.
- [ ] Tests named for `F-149/c4`: a ticket's files land under `.ostra/ticket/`, named in the first prompt's block.
- [ ] Tests named for `F-150/c1`: a document's `.md` lands beside it and the block names both.
- [ ] Tests named for `F-148/c8`: a digest mismatch isn't written; no file name or content in a log line.
- [ ] Checks for the whole repo pass (spec section 10: what runs agent output). The `live-docker` and `live-kind` runs of the case wait for the launch-gate Proof run, with a dated note.
- [ ] Committed as `✨ write a message's files into the box`.

## Comments
