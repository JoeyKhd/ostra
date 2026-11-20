# 31: Web: a runner, approval, drain, resume and revoke

Status: done
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

- [x] Playwright, named for `F-092` and `F-091`: approve a joining seeded runner from the needs-you row; drain, then resume, a seeded runner and see the state follow; revoke with its count; a member's own runner page has Revoke and no Drain.
- [x] Committed as `✨ add the runner page and its actions`.

## Comments

- 2026-11-20: built. The runner's page (`organization/runners/[runner-id]`, `runner-view.tsx`, `runner-page-words.ts`): its state and connection, carrier, version against the server's with its chip and the fix for its install, executor with its line, containment, install, capacity, boxes, history (its last 20 audit entries), and the panel's pool, host, system, labels (its own, then the built-in ones), token, approver and key fingerprint. Drain, Resume and Revoke with their confirms and counts (`runner-actions.tsx`); a member's own personal runner offers Revoke only. Approval (`runner-approval.tsx`): the panel with its eight facts, Approve (no confirm) and Reject (asks first), and the receipts; it shows on Needs you and on the runner's own page while it waits. Needs you gains the Runners band for admins (`components/needs-you/runner-approvals.tsx`), whose Review fills the 380px panel.
- Proof: `apps/web/e2e/15-runner.spec.ts`: approve from the Needs you row (gone after a reload); drain, then resume, with the state following; revoke with its count; a member's own page with Revoke and no Drain; the carrier, the version and its fix. Unit: `runner-page-words.test.ts`. The same e2e run with every break failed each test. Screens compared with `m5/runner` and `m5/runner-approval`.
- Departures: (1) the Runners band's rows come from `runners.list`'s `awaitingApproval`, since a runner notice has no needs-you item or runner column (ticket 12), so `runner_joined` notices for pools without approval get no row of their own on Needs you; the selection isn't in the URL. (2) Below `xl` the approval panel stacks under the list (`PageFrame`), not a right sheet. (3) Capacity shows the CPU and memory a runner offers, not their use: `runners.get`'s boxes carry their size's name only. (4) A box's task shows its title without a ticket key. (5) `How to update` links to the configuration reference's runner section until a runner upgrade page exists.
