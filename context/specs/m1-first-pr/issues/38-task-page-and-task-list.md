# 38: The task page and the project's task list

Status: ready-for-agent
Builder: web
Blocked by: 33, 35, 36
Features: F-023, F-025, F-097, F-065 (needs you), F-014 (run on)
Packages: `apps/web`
Spec: `../spec.md`, section 3 (steps 7 to 10)

## What to build

- **The project's tasks:** grouped by state with a count per group (needs you, running, queued, in review, stopped), each row with state, key, title, what the agent is doing now, the runner, the driver and the age (`app-design.md`). A "New task" composer: the prompt and "Run on" (the member's personal runner, labelled "personal, not isolated", or the project's pools).
- **The task page** (ADR 0036): `@assistant-ui/react` and `@assistant-ui/react-markdown` (pinned, the newest at least a day old), used only through `useExternalStoreRuntime`, its primitives and render-only parts, inside one folder, with no `unstable_` API.
  - Fed by the stream (ticket 33) through a small converter, with the fold (ticket 36).
  - Renderers by ACP kind: `read` one line, `edit` the lines added and removed, expandable to a diff, `execute` the command, its output as plain text and its exit status, and a generic row. Setup output, the pushed branch, the PR and the session's end as their own rows. An approval or question is shown read-only with "answering comes in milestone 3".
  - The properties panel: state, runner, model, branch, the PR link, tokens counted by the key proxy.
  - **Stop** for members of the project, optimistic, confirmed by the stream.
  - "Needs you" with the agent's summary when the session ended without changes.
  - History by turn, newest 20 first, with "Load earlier turns".
  - The stream client reconnects from the last committed `seq` after 20 s without a frame.
- Agent text is untrusted: markdown with no raw HTML, safe links, command output as text.

## Port from

`spikes/live-stream-and-task-view/src/web/convert.ts` and `main.tsx`, and its surprises (system rows as assistant-role messages with `data-*` parts, a row subscribing to its own part, ostra's own Send).

## Done when

- [ ] A Playwright run against a dev stack with a replayed event stream: two tabs show the same thread; a reload mid-turn brings back the history and the partial text within 1 s; Stop works; a task without changes shows its needs-you summary; no request goes to another origin.
- [ ] The default view of a 5,000-event task renders, and the time is recorded (the bar of ADR 0036 is measured on a mid laptop; this machine's figure is noted, not claimed).
- [ ] Package checks pass.
- [ ] Committed as `✨ add the task page and task list`.

## Comments
