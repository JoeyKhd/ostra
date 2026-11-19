# 15: Web: nested subagent calls on the task page

Status: wontfix
Note: Won't do now (2026-11-19): Claude Code (F-018) moved after v1 (the maintainer: "perhaps we can just skip Claude Code with its ACP for now"), and milestone 7 is the launch alone, on OpenCode. The nesting reads Claude Code's subagent stamp (`_meta.claudeCode.parentToolUseId`), which OpenCode doesn't send. This ticket waits for F-018 after v1; its text stays as written for then (ADR 0062, postponed).
Builder: web
Blocked by: 02, 12
Features: F-018, F-023
Packages: `packages/task-view`, `apps/web` (the task thread)
Spec: `../spec.md`, sections 4 and 12 (item 16); target `task-subagent`

## What to build

- **The fold** (`packages/task-view`): a `tool.called`, `agent.message`, `agent.thought` or `plan.updated` with `parentToolCallId` goes under its parent's part, in order (the subagent's text and its checklist too, not only its calls); a subagent's plan is shown in its parent's part and never replaces the task's plan; a parent that never arrived keeps the child at the top level with a note, so nothing is lost.
- **The thread:** a subagent's calls collapsed under the call that started it, with a count, expandable; the agent's badge in the task's header; the "Preparing Claude Code on this runner" waiting state.

## Done when

- [ ] Tests named for `F-023` and `F-018`: the fold nests children (calls, messages, thoughts, a plan) under their parent across a replay and a reconnect; a subagent's plan leaves the task's plan as it was; an orphan child stays visible; a session with no parents renders as today (break-it: the parent ignored).
- [ ] Built against the approved target, with the differences under `## Comments`.
- [ ] Typecheck, lint and tests of the two packages pass.
- [ ] Committed as `✨ nest subagent calls on the task page`.

## Comments

- 2026-11-19, lead: set `wontfix`. Claude Code (F-018) moved after v1 on the maintainer's word, and this ticket waits for it.
