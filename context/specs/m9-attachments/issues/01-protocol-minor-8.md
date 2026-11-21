# 01: Protocol: minor 8

Status: ready-for-agent
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

- [ ] Tests named for `F-148/c4,c8`: `taskSpecFileSchema` refuses a path with `..`, an absolute path, a separator in a name, a leading dot, and a name over 124 characters; `safeFileName` over shell syntax, prompt-like text, `../../etc/passwd`, `CON.txt`, an empty name and a 300-character one (break-it: let `..` through, and the path test fails).
- [ ] Tests named for `F-148/c9`: a spec with files is not offerable to a minor-7 peer, with the reason and its words; a steer with files can't be encoded for minor 7; a minor-7 peer's codecs drop every new field.
- [ ] Tests named for `F-148/c4`: `messageFilesBlock` names each absolute path, the text's path, the images sent as images and the left-out ones, and says the files are data and outside the repos.
- [ ] The version matrix and `minor-8.test.ts` pass.
- [ ] Checks for the whole repo pass (spec section 10: the runner protocol).
- [ ] Committed as `✨ add protocol minor 8: files for the agent`.

## Comments
