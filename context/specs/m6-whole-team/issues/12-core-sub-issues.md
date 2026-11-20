# 12: Core: sub-issues

Status: done
Builder: core
Blocked by: 06, 07
Features: F-077, F-031 (the parent's comment)
Packages: `apps/core` (`src/starts/sub-issues.ts`, the tracker writer), `packages/domain`
Spec: `../spec.md`, section 4 ("Sub-issues"); ADR 0056

## What to build

- **`startSubIssues`,** called by `startTask` for a code start on a ticket whose tracker declares `subIssues` and which has open children: the tree through `getTicketContext`, at most `OSTRA_SUB_ISSUES_DEPTH` levels, the open leaves that are cached on one of the project's boards (a child not yet cached is fetched and upserted first), one `startTask` per leaf with `parentTicketId`, each through the one-active-task index. Over `OSTRA_SUB_ISSUES_MAX` leaves, nothing starts and the caller gets the count. A refine start on a parent refines the parent itself.
- **Children elsewhere:** a child on no board of the project is listed in the result and on the parent's page as "not on this project's boards", and not started.
- **The parent's progress comment:** milestone 2's tracker writer keeps one comment on the parent listing each child, its task's state and its PRs, edited in place as they move, coalesced like any progress comment.
- **A child's prompt** holds its own ticket context and, when the parent has an accepted refine draft, the parent's acceptance criteria (F-064's template gains the block).
- **A ticket that gains children later** starts nothing by itself; the parent's page offers "Start sub-issues".

## Done when

- [x] Tests named `it("F-077: ...")`: a three-level tree starts only its leaves; the parent never gets a code task; a child elsewhere is listed and skipped; 51 leaves refused; the parent's comment lists each child and is edited, not reposted; the Jira fake's sub-tasks start the same way.
- [x] Break-it: the leaf filter dropped (parents started too) fails its test; recorded in `context/proof/F-077.md`.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ start one task per sub-issue`.

## Comments

- 2026-11-20, core: built as `✨ start one task per sub-issue` (4d1f45be). `startSubIssues` is in `packages/domain/src/starts/sub-issues.ts`, so ticket 25's router can call it; core's tracker lookup for it is `apps/core/src/starts/sub-issues.ts`. The parent's comment is `packages/domain/src/tickets/parent-progress.ts` plus a parent branch in `apps/core/src/tracker/writer.ts`. Readings and differences:
  - **Not called from inside `startTask`:** `startTask` runs in the caller's transaction and can't read the tracker. Instead it refuses a code start on a ticket whose open children are cached (`has-sub-issues`), so no start of any origin gives a parent a code task. `has-sub-issues` is a new refusal of `startTask` and `startTicketTask`, mapped to `PRECONDITION_FAILED` by `tasks.startFromTicket`. The caller then runs `startSubIssues`, outside a transaction; ticket 25 wires the panel's start to it. A bulk start's item for a parent is `skipped: has-sub-issues`, and a rule or a schedule matching a parent starts nothing for it.
  - **No `BulkStart`:** the leaves start directly, each in its own transaction, and `bulkStartId` is always `null`. The migration has no column for a bulk start's parent, which each leaf's `parentTicketId` needs. A repeated request starts nothing twice: each leaf's task is found (`skipped: has-task`). The result lists each leaf's outcome.
  - The tree is read through `getTicketContext`, one call per ticket, to `OSTRA_SUB_ISSUES_DEPTH` levels, plus one more read at the last level to tell a child that's too deep. A child not cached yet is read and upserted through milestone 2's ingest first. A child on no board of the project is listed `not-on-a-board`.
  - **The parent's comment:** one `comment` row per parent, keyed by the parent's ticket and made by whichever child's start comes first, then an edit for each child's change (its start, a PR, a move), written beside the child's own progress writes. The writer renders the children's keys, states and PRs when it applies a row, and skips an edit that a newer one supersedes. Its marker line names the parent's page, `<publicUrl>/tickets/<ticketId>`, which ticket 32's page should serve. The parent's own prompt leaves the comment out, like any progress comment.
  - **A child's prompt** gains the template block `parentCriteria`: the acceptance criteria of the parent's latest refine draft that a member applied or marked ready.
  - Proof: `context/proof/F-077.md`. The second row stays `partial` until the parent's page lists its children (tickets 25 and 32).
