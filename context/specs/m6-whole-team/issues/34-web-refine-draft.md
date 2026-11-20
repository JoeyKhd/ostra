# 34: Web: the refine draft

Status: done
Builder: web
Blocked by: 27, 30
Features: F-099
Packages: `apps/web` (the task page's "Draft" tab)
Spec: `../spec.md`, section 12 (`refine-draft`, and the task page and New task growing)

## What to build

- The draft editor with its typed fields, images, versions, the ticket preview, "Update ticket", "Mark ready" and "Create ticket", and the applied state with links, to the approved target.
- New task's kind picker (code, refine); the kind's badge on the task page; "Draft ready" on Home and in "Needs you".

## Done when

- [x] Playwright: open a draft the drafting fake handed in, edit a criterion, upload an image, "Update ticket", "Mark ready", against the fake Linear server.
- [x] Checked against its target at 1440 px and at phone width, in dark and light.
- [x] The touched packages' checks pass (spec section 9).
- [x] Committed as `✨ add the refine draft screen`.

## Comments

- 2026-11-20: built in `✨ add the refine draft screen`. The Draft tab is `apps/web/src/components/tasks/draft/` (`draft-view.tsx`, `draft-field-list.tsx`, `draft-images.tsx`, `draft-preview.tsx`, `draft-properties.tsx`, `draft-words.ts`): the version chips, the five typed fields each editable with the agent's words under a changed item, images with "Upload" (a drop or a paste works too), the preview, "Update ticket", "Mark ready", "Create ticket" for a prompt (a board menu with several boards), "Discard my edits", and the applied state with the sub-issues' keys and the On Linear rows. The task page gains the kind's chip, "Read-only: this task never pushes", the `Kind`, `built-in` and `Pushes` rows, the Draft and On Linear groups, and a refine task's tabs (Activity, Draft, Event log); it opens on the Draft tab while a draft exists. New task gains the kind picker (`?kind=refine&project=` opens on it), and Home and Needs you say "Draft ready" and "Review draft" for a refine task.
- Additive server changes, each tested: `tasks.create` takes `kind` (`createPromptTaskInputSchema`); `drafts.get` gains `agentDraft`, `written` (from `draft.applied`), `createdTicketKey`, `subIssues` and `board`; the agent profile view gains `builtInKind`; a `draft_ready` detail gains `refine`. A new setting, `OSTRA_LINEAR_API_URL` (`docs/configuration.md`), which the panel's and core's Linear adapters read, so the e2e stack runs a fake Linear (`apps/web/e2e/fakes.ts`).
- Choices on the target's open points: (1) autosave a second after typing stops, one member version per editing session: `editDraft` updates the member's own latest version in place while it's unapplied and nothing else wrote after it; (2) "Update ticket" once per version, and "Mark ready" may follow it once with the task left done (`markTicketReady`'s after-apply path; ticket 27's test now says so); (3) no `@dnd-kit/sortable`: reorder by the grip's menu (Move up, Move down) and `Alt`+arrows. Not built: the confirm dialog for an unconfirmed ready status (the mapping has no "confirmed" field; "Mark ready" shows only when the board names a ready status), and stored images' thumbnails (the panel serves no draft image back; an image uploaded in this visit shows its own, others a tile).
- Proof: `apps/web/e2e/18-refine-draft.spec.ts` on the desktop and phone projects, against the fake Linear: the drafting fake's `sampleDraft` and a second agent version are seeded (`seed-refine-world.ts`); the page edits a criterion, uploads an image, "Update ticket" and "Mark ready"; the fake Linear holds the edited description, the attachment, the two sub-issues and `Todo`. Break-it: the panel saving the shown version's fields instead of the edit failed the case. Server break-its (each failed its case): the prompt start ignoring `kind`, no after-apply "Mark ready", every autosave a new version, `written` and `agentDraft` wrong, `OSTRA_LINEAR_API_URL` ignored, a refine draft worded as a draft PR, an edited item marked added. Rows in `context/proof/F-099.md`.
- Checked against `refine-draft.webp` and `refine-draft-applied.webp` at 1440 px and at phone width, in dark and light; the finals are in `C:/Users/santi/ow/_lead/ui-check/m6-refine-draft*-final.png`. A full desktop Playwright run, started by mistake through the phone project's dependency, also failed cases in other specs (02-setup, 03-first-run, 07, 08, 09, 10, 11, 12) before it was stopped; it wasn't checked whether they fail on main too. This ticket's spec runs alone with `01-shell` first, which sets the admin's password.
