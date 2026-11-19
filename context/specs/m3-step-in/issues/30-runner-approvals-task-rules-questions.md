# 30: Runner: approvals, task rules and question answers

Status: done
Builder: runner
Blocked by: 01, 08
Features: F-026
Packages: `apps/runner` (`src/task-host/task-run.ts`, `task-host.ts`, `src/box-dispatcher.ts`)
Spec: `../spec.md`, section 4 ("An approval", "A question"); ADR 0049, ADR 0032, ADR 0036

## What to build

Milestone 1 auto-answers every request under `NO_RULES_YET` and rejects `approval-answer`. Replace both.

- **A permission request:** take its subject from the adapter (`describePermission`). If a task rule matches (the domain's matcher), answer "once" at once and emit `approval.auto_answered` with the rule. If a profile rule matches, or the agent asked because its own settings say "ask", emit `approval.requested` with the rule and the subject, and hold the request. A request that no rule covers, from an agent whose settings asked anyway, is still held: the agent's settings came from the profile.
- **`approval-answer`:** answer the held request "once" (`allow_once` and `allow_task`, ADR 0036) or "reject" (`deny`). For `allow_task`, add the command's `taskRule` to the session's rules, so the next match is answered by it. After a reject, the turn ends (ADR 0032), the runner closes the session's other held requests as `cancelled`, and re-prompts with the deny prompt (the reason as data, or the fixed line). An answer for a request that's gone is `rejected` with `no-pending-approval`.
- **The wait:** a held request waits at most 15 minutes (milestone 1's limit), then the turn is cancelled and the request reported `approval.closed { reason: "expired" }`.
- **`question-answer`:** answer the held elicitation with the answers; an unknown question is `rejected`.
- **Both runner paths:** the task host on `host` and the box's sidecar on `docker` take the commands; the box dispatcher forwards them to the box instead of rejecting.
- Port the reject and re-prompt from `spikes/how-should-the-runner-drive-opencode/src/cases/t7-permissions.ts` and the elicitation from `t8-questions.ts`.

## Done when

- [x] Tests: on both fake agents and on OpenCode with the stub models: a rule asks and an answer goes through; a task rule answers the second request; a deny with a reason re-prompts with it and closes the other held requests; an expired request cancels the turn; a question's answer reaches the agent; on `host` and through the box dispatcher alike.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ hold approvals for a person's answer`.

## Decided 2026-11-19

Decided on the maintainer's delegation while preparing the build, from the open points of the milestone 3 targets (`context/brand/app-targets/m3/`) and the spec's gaps. If the maintainer disagrees with one, it goes back to `context/open-questions.md` and this section changes.

- **Held requests are checked again when a task rule arrives** (`task-approval.md`, point 2). After an `allow_task` answer adds its rule, the runner matches the session's other held requests against it. Each match is answered "once" and reported `approval.auto_answered { approvalId, ruleId }` with the rule's ID from the command (ticket 01). Core closes their items (ticket 17). Test: two `pnpm add` requests held at once; one "Approve for this task" answers both.
- **The matcher and the deny's re-prompt come from `@ostra/protocol`** (Q190), not from the domain, which the runner can't import.

## Comments

- 2026-11-19: done in `✨ hold approvals for a person's answer`. The runner holds what a profile rule covers (`apps/runner/src/task-host/permission-decision.ts`, `task-run.ts`), answers a task rule's matches itself (held ones included, as decided), re-prompts after a deny with `denyPrompt` from `@ostra/protocol`, cancels the turn after 15 minutes, and hands a question's answers to the agent. Proved on both fake agents (`approvals.test.ts`) and on the pinned OpenCode with the stub models (`approvals.opencode.test.ts`); break-it checks in `context/proof/F-026.md`. Three things to know:
  - **OpenCode now asks.** It declared `runner-only` while its config allowed everything, so it never asked. `taskPermissionRules` (`adapter-opencode/src/config.ts`) makes it ask before each call of a tool a rule watches (and of all three in a plan turn); ticket 08 still writes the rules natively.
  - **OpenCode asks one request at a time**, so a deny there ends the turn before its next request; closing the other held requests is proved on the fake agents, which ask two at once.
  - **The box path is the sidecar's connection** (Q129: core sends a box's commands to its sidecar), tested with the sidecar's peer. The box dispatcher still refuses a misrouted answer, as it does a steer.
