# 14: Core: outside tasks and their approval

Status: done
Builder: core
Blocked by: 06
Features: F-040
Packages: `apps/core` (`src/starts/outside.ts`), `packages/domain` (`approveOutsideTask`, `rejectOutsideTask`, `setOutsideApproval`)
Spec: `../spec.md`, section 4 ("An outside task"); ADR 0031, ADR 0057

## What to build

- **Who is outside:** a task whose starter is a tracker user (agent mode now; a Jira user later) that `matchTrackerUser` can't match to an active member who can open the project. Every other origin has a member or an automation behind it and isn't outside.
- **What an outside task gets:** with the project's `outsideApproval` on, `startTask` writes it `awaiting_approval`, with the project's default profile for its kind (whatever the starter asked), `poolOnly`, `trackerActorName`, a needs-you item (`awaiting_approval`) for the project's members, and a `task_approval` notification. Admission never offers a `poolOnly` task to a personal runner, before or after approval. With the switch off, it starts queued, still `poolOnly` on the default profile.
- **Approve and reject:** any member who can open the project. Approve moves it to queued in one transaction with the audit entry and `task.approved`; reject stops it with `rejected`, its reason, the audit entry and `task.rejected`; the first answer wins. Agent mode's session gets "Approved by a member of …" or the final response "Rejected in ostra". There is no expiry.
- **The switch:** `setOutsideApproval` for an organization admin only; a project admin's call is `FORBIDDEN`; each change is an audit entry.

## Done when

- [x] Tests named `it("F-040: ...")`: an unmatched starter's task waits and nothing runs before approval; it runs the project's default profile for its kind and only on a pool; any project member approves or rejects, and someone without access can't; the first answer wins; audited; on by default; only an organization admin switches it off; with it off the task starts at once, still on a pool; a matched member's start never waits.
- [x] Break-it: the `poolOnly` check dropped from admission fails its test; recorded in `context/proof/F-040.md`.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ hold outside tasks for approval`.

## Comments

- 2026-11-20: built in `✨ hold outside tasks for approval`. The start is `startFromTrackerInTx` in `apps/core/src/starts/outside.ts` (with `matchStarterInTx` for ADR 0057's match), which ticket 13's `linear.agent-event` calls; the domain's single `startTask` (ticket 06's signature) isn't built yet, so an outside start goes through this core path, and a matched member's through milestone 2's `startTicketTask`. The answers and the switch are `approveOutsideTask`, `rejectOutsideTask` and `setOutsideApproval` in `packages/domain/src/use-cases/outside-tasks.ts`. `poolOnly` is honoured in all three places admission reads a runner from: `goesToPersonalRunner`, `poolQueueInTx` and `dispatchTask`'s runner choice. The `task_approval` notification is the needs-you item's (`awaiting_approval` now maps to the `task_approval` moment, and a refine task's `draft_ready` to its own moment; the five milestone 6 moments get their headings, default email and mail details). The agent session hears ostra's own copy (`agentSessionCopy`'s "approved" and "rejected") rather than the ticket's exact words. Proof: `context/proof/F-040.md`, both rows `partial` until tickets 26 and 33 give the "needs approval" list and the switch their API and screen; the break-it dropped `poolOnly` from `dispatchTask`'s runner choice, and two cases failed. Checks: whole-repo typecheck through turbo, lint of `@ostra/domain` and `@ostra/core`, tests of domain, core, api and web, `check:licenses` and `check:proof`.
