# 30: Runner: approvals, task rules and question answers

Status: ready-for-agent
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

- [ ] Tests: on both fake agents and on OpenCode with the stub models: a rule asks and an answer goes through; a task rule answers the second request; a deny with a reason re-prompts with it and closes the other held requests; an expired request cancels the turn; a question's answer reaches the agent; on `host` and through the box dispatcher alike.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ hold approvals for a person's answer`.

## Comments
