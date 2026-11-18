# 36: The task-view fold

Status: ready-for-agent
Builder: web
Blocked by: 02
Features: F-023
Packages: `packages/task-view`
Spec: `../spec.md`, sections 5.1 and 8

## What to build

`foldTaskEvents(events, liveText): TaskUIMessage[]` (ADR 0036), a pure function the panel and its tests share.

- `TaskUIMessage` is the AI SDK's `UIMessage` with ostra's generics, derived with `z.infer` from ticket 02's union, using `import type` from `ai` only (pinned to the newest version at least a day old, ADR 0036).
- Tool parts keyed by ACP kind; `data-*` parts for the plan, a question, a compaction, setup output, a pushed branch, an opened PR, the session's end and a driver change. An `unsupported` event is a visible row, never dropped.
- Object identity kept for messages that didn't change; the optimistic `user.message` replaced by its committed one by client message ID; partial text shown in its segment until its completed message arrives.
- Optional fields built with conditional spreads (`exactOptionalPropertyTypes`).
- `deriveTaskState(events)`: what the agent is doing now, for the task list.

## Port from

`spikes/live-stream-and-task-view/src/shared/fold.ts`, `fold.test.ts`, `ui-types.ts`, and the recorded fixtures, including spike 1's captures with tool calls (`spikes/how-should-the-runner-drive-opencode/.runs/`, copied as fixtures without any secret or endpoint address in them).

## Done when

- [ ] A test per event kind, ticket 02's fixtures, and a recorded OpenCode session with tool calls folded with nothing dropped.
- [ ] 5,000 events fold in well under the render budget on this machine (the number recorded in the test's output).
- [ ] Package checks pass.
- [ ] Committed as `✨ add the task-view fold`.

## Comments
