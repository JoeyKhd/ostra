# 27: API: refine drafts

Status: done
Builder: api
Blocked by: 15
Features: F-099
Packages: `packages/api` (`src/routers/drafts.ts`)
Spec: `../spec.md`, section 4 ("A refine task")

## What to build

- `drafts.get({ taskId, version | null })` → the fields, the versions with their source, the images, and the ticket preview (the description as the tracker will show it); `drafts.save({ taskId, fields })` → a member's version; `drafts.addImage` and `drafts.removeImage` through milestone 2's blob upload.
- `drafts.updateTicket({ taskId, version })`, `drafts.markReady({ taskId })`, `drafts.createTicket({ taskId, boardId })` for a prompt refine task; each refused once the task is done, and each an audit entry.
- Any member who can open the project may edit and apply (the owner is the needs-you audience, not a permission).

## Done when

- [x] Tests: a member's version saved after the agent's; the preview equals what `updateTicket` writes; images over the limit refused; apply and mark ready once; access as the project's.
- [x] The touched packages' checks pass (spec section 9).
- [x] Committed as `✨ add the drafts API`.

## Comments

- 2026-11-20: built in `✨ add the drafts API`. `packages/api/src/routers/drafts.ts`: `drafts.get`, `save`, `addImage`, `removeImage`, `updateTicket`, `markReady` and `createTicket`, each a `taskProcedure("read")` (any member who can open the project), over ticket 15's use cases. The preview is the domain's new `draftTicketText` (`packages/domain/src/prompts/m6.ts`), which core's `draft.apply` now writes with, so the two can't drift; `apps/core/src/refine/drafts-preview.test.ts` records what `draft.apply` sends to `updateTicket` on Linear and on the Jira fake and compares it with the preview. Images go through core's blob service under a new panel blob purpose, `draft-image` (10 MiB, `DRAFT_IMAGE_MAX_BYTES`), and at most `OSTRA_DRAFT_IMAGES_MAX` a draft (`ApiSettings` gains `team`). Proof: `context/proof/F-099.md`.
- Domain changes, additive: `applyDraft`, `markTicketReady`, `editDraft` and `addDraftImage` refuse a done task (`task-done`); `removeDraftImage` and `createTicketFromDraft` are new. `CreateTicketFromDraft` now answers the `ticketWriteId` (the ticket is made by `ticket.sync`, so its key isn't known yet) and takes `publicUrl`; nothing called it before. "Create ticket" is F-097's `create` write with the draft as its description, the version marked applied; core's writer, once the ticket exists and the task is linked to it, sends that version's `draft.apply` for its images and sub-tickets (`TicketWriterDeps.jobs`, wired in `core.ts`).
- Choices: `drafts.createTicket` takes the `version` as `updateTicket` does, so a newer version in between is a `CONFLICT` rather than written unseen. Image uploads are base64 in the tRPC call, checked against 10 MiB before core's blob service is asked. Nothing in the panel starts a prompt refine task yet (milestone 2's prompt start makes code tasks only), so `createTicket` is proved on a seeded one; starting one is ticket 34's screen and its start.
- Checks: whole-repo typecheck through turbo; lint and tests of `@ostra/domain`, `@ostra/api` and `@ostra/core`; `check:licenses`; `check:proof`. Break-its, one at a time, each failing its case: a member's version stored as the agent's; the done check dropped from `applyDraft`; the preview without the tracker's criteria field; `draft.apply` writing other text than `draftTicketText`; no `draft.apply` after "Create ticket"'s ticket; the image count unchecked in the router and the domain; the size unchecked in the router and the store; `taskProcedure` skipping the project check.
- 2026-11-20: landed on main as 4b4f9658.
