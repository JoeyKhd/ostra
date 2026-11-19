# Target: no key for this model in this project (milestone 4, screen 22)

> **Committed image:** `no-key-for-model.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

- **Prompt:** `no-key-for-model.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 1 generation, kept as made. References: the approved milestone 1 original `app-targets/m1/task-new.png` (the screen this one starts from, spec section 12), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`. The other three places (the queued task, the held message, the needs-you row) are copy on their approved targets, below; `app-targets/m2/task-limits` is the queued task's.
- **Routes (existing):** New task `apps/web/src/app/(panel)/tasks/new/page.tsx` → `components/tasks/new-task-view.tsx`; the task page `components/tasks/task-view.tsx`; Home's needs-you `components/home/` and `components/needs-you/`.
- **Features:** F-135. ADR 0065, "When no key serves the model" (Q274) and "No silent fallback" (Q276). Spec section 3 step 17. Tickets 45 (the wait code `no-provider-for-model { modelName }`, the needs-you item for organization admins), 48 (dispatch and turn start), 50 (`tasks.create` and the New task check return the reason), 53 (this screen).
- **Status:** approved 2026-11-19 by the lead on the maintainer's delegation, pending the maintainer's review (ticket 52's `## Comments`).

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

When no key on a project's list serves the model its profile names, the task can't start, and every place it shows says so in the same words, names who can fix it, and never falls back to another key (ADR 0065). There are four places:

1. **New task**, before Start: the reason under the composer and Start disabled (the picture).
2. **A queued task** (from a ticket, an automation or a reopen): the task page's status and its reason, with who can fix it.
3. **A held message** on a task whose key left the list: the line in the thread.
4. **Home's needs-you row**, for organization admins only (audience `organization_admins`).

**The one sentence**, everywhere: `No key for {model} in {project}.` then `An organization admin picks one in Models and keys.` The model is its display name (a custom model: its endpoint ID in mono); the project in mono. A chosen model row that its key stops listing is the same case, the same words.

## 1. New task (the picture)

Milestone 1's `task-new`, with:

- **The reason line**, 12px under the composer, replacing milestone 1's runner line (the runner line comes back under it if both apply). No box, no fill: Lucide `ban` 15px `--muted` (the picture's icon is wrong, see below), then `No key for Claude Sonnet 5.5 in globex-shop.` in 14px `--text`, then `An organization admin picks one in Models and keys.` in `--muted`; for an organization admin `Models and keys` is a teal link to the project's `settings/models` tab. `role="status"`.
- **Who can**, under it, 13px `--faint`: `Organization admins: Alex Kim, Priya Nair.` (names from `members.list`, roles only; three or more: `Alex Kim, Priya Nair and Dana Ortiz`). Hidden for an organization admin.
- **Start task** disabled: the outline `Button` dimmed (`--faint` text, `--line` border), not the Shell fill, `aria-disabled` with the reason line as its `aria-describedby`. `⌘↵` does nothing. The server refuses it too (`tasks.create` → `PRECONDITION_FAILED` with the same message), and the page shows the server's message if the check was stale.
- **What happens next** becomes three faint rows: `clock` · `Nothing starts until globex-shop has a key that lists Claude Sonnet 5.5.`; `sliders-horizontal` · `Or pick a profile whose model has a key here.`; `pencil-line` · `Your text stays here while you wait.` (the draft is kept, as milestone 1 does).
- **Picking another profile** in the composer's picker re-runs the check at once; a profile whose model has a key here shows `Key · northwind-anthropic` beside its name in the picker's options, and one without shows `No key here` in `--faint`.
- **The properties panel:** `Agent profile` group gains a row `Key`: the serving key in mono `--text`, or `None in globex-shop` in `--red`. A new group `{project}'s keys`: one row per key on the list, its name in mono and its models in `--muted` (comma-joined, cut with `…`), then 12.5px `--faint`: `None of them lists Claude Sonnet 5.5.` An empty list: `globex-shop has no key yet.`
- **Recent in {project}:** a queued task's row reads `Queued` · title · `Waiting · no key for Claude Sonnet 5.5` (`--muted`).

## 2. A queued task (on `app-targets/m2/task-limits`)

The task page's status, header and properties, as `task-limits` draws a task waiting on a limit:
- Status chip: `Queued · no key` (`--muted`, not amber: the member who started it can't fix it).
- The notice under the title (no amber rule; a 2px `--line-2` rule): `No key for Claude Sonnet 5.5 in globex-shop.` (14px `--text`) and `An organization admin picks one in Models and keys. The task starts by itself once one does.` (`--muted`). Then `Organization admins: Alex Kim, Priya Nair.` in 13px `--faint`.
- Properties: `Status` `Queued · no key`; `Key` `None in globex-shop` in `--red`.
- Nothing is reopened or moved: when an admin adds a key that lists the model, the dispatch starts it, and the thread gains `Started on northwind-anthropic.`

## 3. A held message (on `app-targets/m1/task`)

A turn never starts on a key the project no longer allows (ADR 0065, "Where it's enforced", 3). The member's message stays in the thread, and under it the held-turn marker milestone 4 adds for budgets (`Held: …`), in the same form: Lucide `pause` 13px `--faint`, 13px `--muted`: `Held: no key for Claude Sonnet 5.5 in globex-shop. An organization admin picks one in Models and keys.` The composer stays usable (more messages queue behind it). When an admin puts a key back, the marker becomes `Started in a fresh box on northwind-anthropic.` (`--faint`), as F-033's fresh-box line.

## 4. Home's needs-you row (on `app-targets/m1/home` and `app-targets/m3/needs-you`)

Reason `no_provider_for_model`, audience `organization_admins`: a member who isn't one never sees it (spec step 17). One row per project and model, not per task:
- key column: the project's colour square and name in mono;
- title: `No key for Claude Sonnet 5.5`;
- reason (`--muted`): `2 tasks wait in globex-shop. Pick a key in Models and keys.`;
- the action opens the project's `Models and keys` tab with the model's row highlighted. It leaves needs-you when the project resolves the model again.
- Amber, as every needs-you row: it waits on this admin.

## States and copy

| State | What shows |
|---|---|
| **New task, no key** (the picture) | as section 1 |
| **New task, a key** | milestone 1's page; the panel's `Key` row names the key in mono |
| **The list has no key at all** | the same sentence; the panel's keys group reads `globex-shop has no key yet.` |
| **The model's row stopped listing it** | the same sentence (ADR 0065) |
| **Checking** | while the New task check (ticket 50) runs after a picker change, Start is disabled with no reason line, and a 12px `Loader` sits in the button |
| **A member who isn't an organization admin** | the sentence and `Organization admins: …`; no link |
| **Narrow** | the reason line wraps under the composer; the panel drops under the page |

## Components and tokens

`Button` (outline, disabled), `Popover` (the profile picker), `PropGroup`, `PropRow`, `Skeleton`. Icons: `ban`, `clock`, `sliders-horizontal`, `pencil-line`, `pause`, `loader`. The approved pictures' scale. `--red` only for `None in {project}`; amber only on Home's needs-you row; nothing on New task is amber or boxed.

## Open points (settled by recommendation, 2026-11-19; recorded in ticket 53's `## Comments`)

1. **Amber on the queued task.** Settled: no. The person looking at it can't act; only the organization admins' needs-you row is amber.
2. **One needs-you row per task or per project and model.** Settled: per project and model, with the waiting count, since one admin action fixes all of them.
3. **Naming the admins.** Settled: by name, roles only, never addresses (`project-access`'s rule).

## Differences from the current code

1. `new-task-view.tsx` already disables Start for a runner problem; it gains the key check from ticket 50's New task check (no procedure on `main` yet; `tasks.create` refuses with the same message) and the panel's `Key` row and keys group.
2. `task-view.tsx` gains the `Queued · no key` status words and the held marker's reason (`task-words.ts`).
3. Home's reason words (`home-words.ts`, `reasonParts`) gain `no_provider_for_model`.
4. Messages: `tasks.noKey.*`, `home.reason.noProviderForModel`.

## Wrong in the image

- **The reason line's icon** is a pen-like glyph; it's Lucide `ban` 15px `--muted`.
- **`Who can: Alex Kim, Priya Nair.`** reads `Organization admins: Alex Kim, Priya Nair.`
- **What happens next's icons** are milestone 1's (folder, branch, pull request); they're `clock`, `sliders-horizontal` and `pencil-line`, and the rows are `--muted`, not faint, so they stay readable.
- **The panel's keys group** sets the models list in 14px `--text`; it's 13px `--muted`, and the key's name is mono 14px.
- **The sidebar** comes from the shell (its `Spend` icon is the audit log's).
- The other three places aren't pictured: their copy is above, on their approved targets.

All other visible copy is spelled right.
