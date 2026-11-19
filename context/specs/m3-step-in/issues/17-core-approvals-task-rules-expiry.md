# 17: Core: approvals, task rules and expiry

Status: ready-for-agent
Builder: core
Blocked by: 07, 16
Features: F-026
Packages: `apps/core` (`src/ingest/`, `src/reactions/`), `packages/domain` (`recordApprovalRequested`, `answerApproval`)
Spec: `../spec.md`, section 4 ("An approval"); ADR 0049, ADR 0036

## What to build

- **`approval.requested`** (ingest): store the approval with its rule and subject, raise a needs-you item (reason `approval`, audience the driver, or the project's members when the task has no driver), move the task to needs you (sub-reason `approval`), and enqueue `notify.fanout`, all in the ingest's transaction.
- **`approval.auto_answered`:** store it as answered by a rule, with no needs-you item and no notification.
- **`approval.closed`:** `cancelled` closes the item; `expired` leaves the needs-you item open (ADR 0039), and an answer to it then reopens the task with the decision in the reopen's pending messages (milestone 2's path, ticket 18 of milestone 2).
- **The answer** (`answerApproval`, used by `approvals.answer`): milestone 1's compare-and-set stays. "For this task" also inserts a `TaskApprovalRule` from the subject (the domain's pattern rule) and puts it in the command's `taskRule`; "deny" carries the reason, at most 2,000 characters. The audit entry records the decision and the rule, never the reason's text.
- **A deny's other approvals:** the runner closes them as cancelled (ADR 0036); core only records the events it receives.
- **On the ticket:** the needs-you item's notification posts on the ticket (ticket 20). Nothing here writes to the tracker directly.
- **A minor-1 runner** answers its own approvals "once" (milestone 1's behaviour), recorded with the rule `peer-too-old`.

## Done when

- [ ] Tests: a request raises one item and one fan-out; two members answering at once, one wins and one gets `CONFLICT`; "for this task" writes one task rule even when answered twice in a race; a deny's reason reaches the command and not the audit entry; an expired approval's item stays open and its later answer reopens the task with the decision; another organization's approval can't be answered.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add approvals with task rules`.

## Comments
