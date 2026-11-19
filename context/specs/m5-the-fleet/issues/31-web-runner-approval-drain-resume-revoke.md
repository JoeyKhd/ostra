# 31: Web: a runner, approval, drain, resume and revoke

Status: ready-for-agent
Builder: web
Blocked by: 25, 26, 29
Features: F-092, F-091, F-061, F-013, F-014
Packages: `apps/web` (`src/app/(panel)/runners/[runnerId]/`, `src/components/runners/`, `src/components/needs-you/`, `messages/en.json`)
Spec: `../spec.md`, sections 3 (steps 2, 8, 9, 10 and 11) and 12

## What to build

- **The runner page** (`m5/runner`): state and connection, carrier, version against the server's with its state and the fix, executor, containment, install, slots and resources, labels, the token it joined with and who approved it, its boxes, and "Drain", "Resume" and "Revoke" with their confirms (how many tasks finish or stop; for a minor-3 runner, that resume takes effect after its restart).
- **Approval** (`m5/runner-approval`): the needs-you row for admins and its panel with "Approve" and "Reject".
- **Milestone 2's Revoke action** lands here, now that the target has row actions.
- **Your machine** for a member: their personal runner's page, with Revoke and no Drain.

## Done when

- [ ] Playwright, named for `F-092` and `F-091`: approve a joining seeded runner from the needs-you row; drain, then resume, a seeded runner and see the state follow; revoke with its count; a member's own runner page has Revoke and no Drain.
- [ ] Committed as `✨ add the runner page and its actions`.

## Comments
