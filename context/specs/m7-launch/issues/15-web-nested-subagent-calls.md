# 15: Web: nested subagent calls on the task page

Status: ready-for-agent
Builder: web
Blocked by: 02, 12
Features: F-018, F-023
Packages: `packages/task-view`, `apps/web` (the task thread)
Spec: `../spec.md`, sections 4 and 12 (item 16); target `task-subagent`

## What to build

- **The fold** (`packages/task-view`): a tool event with `parentToolCallId` goes under its parent's part, in order; a parent that never arrived keeps the child at the top level with a note, so nothing is lost.
- **The thread:** a subagent's calls collapsed under the call that started it, with a count, expandable; the agent's badge in the task's header; the "Preparing Claude Code on this runner" waiting state.

## Done when

- [ ] Tests named for `F-023` and `F-018`: the fold nests children under their parent across a replay and a reconnect; an orphan child stays visible; a session with no parents renders as today (break-it: the parent ignored).
- [ ] Built against the approved target, with the differences under `## Comments`.
- [ ] Typecheck, lint and tests of the two packages pass.
- [ ] Committed as `✨ nest subagent calls on the task page`.

## Comments
