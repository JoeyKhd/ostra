# 38: Web: Memory, proposals and the task's memory

Status: resolved
Builder: web
Blocked by: 29, 31
Features: F-109, F-110, F-111
Packages: `apps/web` (`src/app/(panel)/organization/memory/`, `src/app/(panel)/projects/[project-id]/memory/`, `src/task/`, the diff view)
Spec: `../spec.md`, sections 3 (steps 7 to 9) and 12; targets `memory`, `memory-note`, `memory-proposals`

## What to build

- **Memory** for the organization and each project to the `memory` target: notes with search and kind filters, "always" marks, last used (the last time a session read the note, ADR 0044, Q91), "N proposals", "New note".
- **A note** to `memory-note`: the editor, its source, its versions, archive (for whoever `canArchiveNote` allows), the secret refusal's words, and the `CONFLICT` state when someone saved first, with the member's text kept (ADR 0044, Q91).
- **Proposals** to `memory-proposals`: the list and one proposal with its source task, the declared relation, the related notes beside it, and the four decisions, "Merge into …" with the merged text editable and its `CONFLICT` line when the note moved on.
- **The task's memory,** growing `app-targets/m1/task`: the "Memory" list in the properties panel (notes used and how, proposals made and their states) and `memory.proposed` in the thread.
- **"Remember this"** on a diff comment (growing `app-targets/m3/task-changes`) and on an `@ostra` comment in the thread.
- **The profile's switch** "Ask what the next task should know", growing `app-targets/m3/agent-profile`.
- The sidebar gains Memory under Organization and under each project. Write the growing changes under `## Comments`.

## Done when

- [x] Playwright, named `it("F-109: ...")` and `it("F-111: ...")`: a member writes a note and finds it by a word; a note with a fake token is refused with the kind named; a save from a stale version says who saved first and keeps the text; a proposal is approved and appears as a note with its source; "Remember this" on a diff comment makes a proposal.
- [x] Each screen checked by eye against its target, dark and light, at 1440 px and phone width.
- [x] Committed as `✨ add Memory to the panel`.

## Decided 2026-11-19

Settled by the target's recommendation, on the maintainer's delegation (ticket 42, step 5); the maintainer may reopen any.

- **A saved note keeps its scope** (`memory-note.md`, open point 1): a member writes a new note in the other scope and archives this one.
- **Archive only, no delete** (open point 2): an archived note keeps the sources and versions the audit log points at.
- **No restore of an archived note** (open point 3): a member writes it again.
- **Related notes for a project proposal** (`memory-proposals.md`, open point 1): the project's notes and the organization's; an organization proposal ranks only the organization's.
- **No editing a proposal before approving it** (open point 2): approve it as it stands, then edit the note (one version more, the member its editor).
- **No reason on Reject** (open point 3).

## Comments

- 2026-11-20, web builder B: Memory for the organization and each project (`/organization/memory`, `/projects/[id]/memory`, `components/memory/`) to the `memory` target: Project, Organization and Archived tabs, full-text search (`?q=`), Kind and Source filters, "Always only", the index order without a search, last used, the Proposals count and New note; the selected note in the panel with its Always switch (a save at the version shown), source, versions and Archive. A note's page (`…/memory/new`, `…/memory/[note-id]`) to `memory-note`: the editor, the size against 4 KiB, the secret refusal worded from the API's kind, the stale-save line naming who saved first with the text kept, the versions, and archive for whoever may. Proposals (`…/memory/proposals`) to `memory-proposals`: the list with the declared relation, one proposal with its related notes, and Approve, Approve and archive, Merge into (the merged text editable, its stale line) and Reject. Growing screens: the task panel's Memory group (`tasks.memory`: the notes each session used and how, the proposals and their states); `memory.proposed` is a thread row (`@ostra/task-view` folds it to `data-memory-proposed`); a sent diff comment has "Remember this" (`memory.rememberThis`); the agent profile editor has "Ask what the next task should know" (`closingTurn`); the sidebar has Memory under Organization and under each project. Proof: `apps/web/e2e/15-memory.spec.ts` (write and find by a word, the token refusal, the stale save, a proposal approved into a note with its source, the count, phone width), with break-its on a rebuilt panel, plus unit tests; see `context/proof/F-109.md` and `F-111.md`. Checked by eye at 1440 px and 412 px in the dark theme against the three targets (finals in the session's `ui-check/m4-memory-*-final.png`); the panel has no light theme yet. **Left open (the Playwright box stays unticked):** "Remember this" has no browser case: the e2e stack's fake GitHub holds no diff for a seeded task, so it's proved by the API's test and the comment's render test; and the thread has no row for an accepted `@ostra` PR comment yet (`pr.comment_received` draws nothing), so "Remember this" there isn't built. The merge's stale line and the task panel's Memory group have no browser case. Commit: see the git log for `✨ add Memory to the panel`.
- 2026-11-20: the commit is `61ab1ea5` on main.
- 2026-11-20, apps/web review: the open box is closed. An accepted `@ostra` comment is a thread row (`pr.comment_received` folds to `data-pr-comment` in `@ostra/task-view`), with the commenter, the line and a link to the comment, and "Remember this", which asks for the proposal's title and text in the member's words (the comment's text is untrusted and stays in the member message) and calls `memory.rememberThis` by the event's seq. `apps/web/e2e/15-memory.spec.ts` adds F-111 cases for "Remember this" on a diff comment (the diff seeded in the cache `diff.fetch` fills, on the fake GitHub's repo `03-first-run.spec.ts` links) and on the `@ostra` row, the merge's stale line with the merged text kept, and the task panel's Memory group, each failing on a rebuilt panel with its break-it (`context/proof/F-111.md`). Checked by eye at 1440 px and 390 px. Commit: `🐛 fix review findings in apps/web`.
