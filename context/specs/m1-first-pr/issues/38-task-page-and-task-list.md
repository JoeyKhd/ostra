# 38: The task page and the project's task list

Status: done
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

- [x] A Playwright run against a dev stack with a replayed event stream: two tabs show the same thread; a reload mid-turn brings back the history and the partial text within 1 s; Stop works; a task without changes shows its needs-you summary; no request goes to another origin.
- [x] The default view of a 5,000-event task renders, and the time is recorded (the bar of ADR 0036 is measured on a mid laptop; this machine's figure is noted, not claimed).
- [x] Package checks pass.
- [x] Committed as `✨ add the task page and task list`.

## Comments

- 2026-11-18 (web): built in `apps/web/src/task/` (the only folder that imports assistant-ui: `useExternalStoreRuntime`, its primitives and `MarkdownTextPrimitive`, no `unstable_` API), `src/components/tasks/` and the project page. One SSE subscription per tab (`StreamProvider` in the shell) carries the change notices and, on a task page, the task's events (`tracked(seq)`) and live text; the server's `reconnectAfterInactivityMs: 20_000` makes tRPC's link resume from the last seq. History pages by turn with "Load earlier turns". Renderers by ACP kind: `read` one line, `edit` counts and an expandable diff, `execute` the command, its exit status and its output as text, a generic row; setup, push, PR text, PR, session end, driver and system rows; approvals and questions read-only ("answering comes in milestone 3"). Markdown has no raw HTML, links are http(s) only, and an image the agent links isn't loaded. Stop is optimistic. The composer shows only when `tasks.get` says the member may send. Playwright on a replayed stream (`e2e/seed-task.ts`, spike 1's recorded OpenCode session): two tabs show the same thread and both receive the rest live; a reload mid-turn shows the history and the partial text in about 0.2 s; Stop stops; a task without changes shows its needs-you summary; no request to another origin. The default view of a 5,000-event task was visible in about 0.3 s on this machine (Windows 11 desktop, production build; the fold of its newest 20 turns took about 2 ms). That's this machine's figure, not ADR 0036's mid-laptop bar.
- The thread's tokens come from the fold's `usage.recorded` sum and the session row, whichever is larger; the model isn't on `tasks.get` yet, so the properties panel doesn't show it.
