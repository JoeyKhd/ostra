# 38: Web: Memory, proposals and the task's memory

Status: ready-for-agent
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

- [ ] Playwright, named `it("F-109: ...")` and `it("F-111: ...")`: a member writes a note and finds it by a word; a note with a fake token is refused with the kind named; a save from a stale version says who saved first and keeps the text; a proposal is approved and appears as a note with its source; "Remember this" on a diff comment makes a proposal.
- [ ] Each screen checked by eye against its target, dark and light, at 1440 px and phone width.
- [ ] Committed as `✨ add Memory to the panel`.

## Comments
