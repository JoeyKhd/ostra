# 27: API: refine drafts

Status: ready-for-agent
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

- [ ] Tests: a member's version saved after the agent's; the preview equals what `updateTicket` writes; images over the limit refused; apply and mark ready once; access as the project's.
- [ ] The touched packages' checks pass (spec section 9).
- [ ] Committed as `✨ add the drafts API`.

## Comments
