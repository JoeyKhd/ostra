# 15: Core: refine drafts and writing them to the tracker

Status: ready-for-agent
Builder: core
Blocked by: 06, 07
Features: F-099, F-036 (the draft's owner)
Packages: `apps/core` (`src/refine/`, `src/runner-http/draft.ts`, the tracker writer), `packages/domain`
Spec: `../spec.md`, section 4 ("A refine task"); ADR 0028 (amended)

## What to build

- **The built-in profiles:** `profiles.seed-built-in`, keyed by organization, creates the read-only "Refine" and "Review" profiles (`builtInKind`) on the organization's default model, for every existing organization once and for each new one in milestone 4's seeding, and sets them as each project's default for those kinds where none is set. They can be edited, not deleted or archived (milestone 3's profile API refuses it). Ticket 17 uses "Review".
- **The dispatch of a refine task:** `kind: refine`, the git proxy's read-only mode, `tools: ["draft", "memory"]`, the refine prompt (ticket 06) with the ticket's context or the member's prompt, on the project's default refine profile.
- **`POST /runner/v1/tasks/:taskId/draft`:** the task token's task must be a refine task (else `wrong-kind`); the body checked by the protocol's schema; a new `RefineDraft` version with `source: agent`; `draft.submitted` in the thread. At the turn's end, a task with a draft from that turn moves to needs you (`draft_ready`), audience the driver, else the project's members (F-036).
- **Editing:** `editDraft` saves a member's version (`source: member`); images are milestone 2's blobs, at most `OSTRA_DRAFT_IMAGES_MAX`.
- **`applyDraft` ("Update ticket"):** tracker writes in milestone 2's outbox, each idempotent by the draft version: the description rendered by the domain (sections for the fields the tracker can't hold); each image attached where `attachments` is true, else linked from the description; each sub-ticket created as a sub-issue where `subIssues` is true, else as a linked ticket. `draft.applied` in the thread.
- **`markTicketReady`:** moves the ticket to the board's `ready` status through `moveTicket`; a board without one is drafted from the tracker's statuses (ticket 07's default) and shown to the project admin to confirm. Either action, by a member, moves the task to done.
- **A prompt refine task** has "Create ticket" instead (milestone 2's F-097 path), with the draft as the new ticket and its sub-tickets under it.
- Nothing of a draft reaches the tracker without a member's action; a draft's text is never logged.

## Done when

- [ ] Tests named `it("F-099: ...")`: the built-in Refine profile exists in every organization, read-only, on its default model, can be edited and not deleted, and is each project's refine default; a code task's token posting a draft is refused; the typed fields stored per version; needs you for the owner on the turn's end; "Update ticket" writes the description, attaches images and creates sub-issues once under a replayed job; "Mark ready" moves to the mapped status; nothing reaches the tracker before a member acts; the Jira fake with its acceptance-criteria field and its transitions.
- [ ] Break-it: the kind check on the endpoint dropped fails its test; recorded in `context/proof/F-099.md`.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add refine drafts`.

## Comments
