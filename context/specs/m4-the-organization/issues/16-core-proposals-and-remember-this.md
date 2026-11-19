# 16: Core: notes, proposals and "Remember this"

Status: ready-for-agent
Builder: core
Blocked by: 06, 15
Features: F-109, F-111
Packages: `packages/domain` (`saveNote`, `archiveNote`, `decideProposal`, `rememberThis`), `apps/core` (the closing turn)
Spec: `../spec.md`, section 4 ("A proposal's decision"); ADR 0044 (amended)

## What to build

- **`saveNote`:** create or edit a note, with the secret scan before anything is stored, a new `MemoryNoteVersion` on every edit (version numbers gap-free under the note's lock), and an audit entry by note ID. Access through `canWriteNote`; archiving through `canArchiveNote`.
- **`decideProposal`:** one transaction each for "Approve as a new note" (a note with the proposal as its source, version 1), "Approve and archive <note>", "Merge into <note>" (a new version of that note with the member's text, `proposalId` set), and "Reject". A decided proposal can't be decided again (`CONFLICT`). Each writes its audit entry.
- **Related notes:** the store's query ranks the scope's active notes against the proposal's title and body with `ts_rank` and returns the top three, beside the agent's declared `relatesTo`.
- **"Remember this":** from a diff comment (F-072) or an accepted `@ostra` PR comment (F-053), a proposal whose body is the comment's text, its source the comment, proposed by the member who pressed it, with the secret scan.
- **The closing turn:** when the task's profile has `closingTurn` on, after the session's last turn with changes, core sends one more turn with ticket 06's fixed prompt asking for proposals and nothing else, through the budget gate with the origin `closing-turn`.

## Done when

- [ ] Tests named `it("F-109: ...")`: notes with each kind and scope; versions on edit; each secret shape refused; an audit entry per change; a member who can't open the project can't write or read its notes.
- [ ] Tests named `it("F-111: ...")`: each decision; a decided proposal refused twice; related notes ranked; "Remember this" from both sources; the closing turn runs only when the switch is on, which it isn't by default.
- [ ] Break-it checks recorded in `context/proof/F-109.md` and `F-111.md`.
- [ ] Committed as `✨ add memory notes and proposals`.

## Comments
