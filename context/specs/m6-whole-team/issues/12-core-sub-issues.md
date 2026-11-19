# 12: Core: sub-issues

Status: ready-for-agent
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

- [ ] Tests named `it("F-077: ...")`: a three-level tree starts only its leaves; the parent never gets a code task; a child elsewhere is listed and skipped; 51 leaves refused; the parent's comment lists each child and is edited, not reposted; the Jira fake's sub-tasks start the same way.
- [ ] Break-it: the leaf filter dropped (parents started too) fails its test; recorded in `context/proof/F-077.md`.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ start one task per sub-issue`.

## Comments
