# The task page: AI SDK message types, rendered with assistant-ui

**Status:** accepted (2026-11-18, from the delegated answers in `context/history/answers-2026-11-18.md`). Settles Q50 and the approval rules in the answers' list of questions the research raises (`research/agent-ui-stream.md`). Covers F-023, F-024 and F-026. It adds `ai` (types only), `@assistant-ui/react` and `@assistant-ui/react-markdown` to ADR 0007. **Amended 2026-11-18 after spikes 1 and 7** (`research/spike-live-stream-and-task-view.md`): the render bar's device and the virtualization it implies (Q112), a stock Send that never queues, the driver race, what a deny does, and which agent updates the mapper may not drop (Q124). **Amended 2026-11-22 for milestone 10** (F-151, `specs/m10-compact-thread/spec.md` section 5.2, ticket 02): a turn's numbers and its steps' times are fields of its message, what a turn made is a part of that turn, and bookkeeping leaves the parts ("A turn's fields, its results, and bookkeeping out of the parts" below).

The task page is a view of the event log (ADR 0035). The maintainer asked for the AI SDK and assistant-ui, and both are in. The AI SDK gives the message format and its tool states. assistant-ui gives the thread, the composer and the approval card. Only the transport is ostra's own.

**The view model:**
- The AI SDK's `UIMessage` types, with `import type` only, so they're erased under `verbatimModuleSyntax`. There's no `useChat`, no `@ai-sdk/react`, no chat transport and no `resumable-stream`.
- A pure function, `foldTaskEvents(events, liveText): TaskUIMessage[]`, in `packages/task-view` (Q78). The panel and its tests share it. A stored session and a live one run through the same function. It keeps object identity for messages that didn't change, and it shows an unknown event kind as a visible "unsupported event" row, never a silent drop.
- `TaskUIMessage` is `UIMessage` with ostra's generics, derived with `z.infer` from the Zod event union and the tool schemas, never typed again by hand. Parts the AI SDK has no type for, such as the plan, a question, a compaction and a driver change, are `data-*` parts.
- The AI SDK's types are never stored and never cross the runner protocol (ADR 0034), so a new major version can't force a data migration. The panel imports no ACP types.
- **The fold maps an agent's updates by the table in `research/agent-ui-stream.md`, and may not drop one it lists** (Q124). Spike 7's mapper departed from the table in three places (the first two below, and the missing usage kind), and the table wins:
  - `current_mode_update` and `config_option_update` become `session.config_changed`.
  - An `in_progress` update of any tool that has content becomes `tool.progress`, not only an `execute` tool's.
  - The agent's `usage_update` (row 18) gets an event kind, `session.usage`, which the union lacked: the context used and the context size, stored once per turn at its end, and shown only as the context meter. Nothing acts on it. The panel's tokens and spend come from the key proxy's count, never from the agent's own figure (ADR 0042).
  - The plan (table row 14) comes from the agent's ACP `plan` update, and for OpenCode, which sends none, from its `todowrite` tool call, mapped inside the adapter (ADR 0032).
  - An update the mapper can't place is a visible "unsupported event" row, as before.

**The runtime.** assistant-ui's `useExternalStoreRuntime`, fed by ostra's own SSE subscription (ADR 0035) through a small converter of ours. assistant-ui is pinned to an exact version and used only through that runtime, its primitives and render-only toolkit entries, inside one package. It avoids `unstable_` APIs. The styled kit is installed as source through the shadcn registry (ADR 0007).

**The renderers** are keyed by ACP `kind`, not by an agent's tool name, so every agent renders alike (adapter parity):
- `read`: one line.
- `edit`: a row with the lines added and removed, which expands to a diff.
- `execute`: the command, its output and its exit status.
- the approval card.
- everything else: a generic row.

A renderer reads the typed part from ostra's store, never `args` or `result` from assistant-ui, whose types are `any`.

**One driver, many viewers:**
- The server owns the driver. It changes only through take-over, a compare-and-set, and each change is an event ("Alex took over at 14:02").
- **`task.send` and `task.interrupt` read the driver under the task's counter lock, inside the transaction,** as take-over and approvals already do. Spike 7 found that the driver check ran before the transaction (inferred, not run), so a take-over could commit between the check and the write, and the old driver's message would land. F-024's tests include a race test: a take-over and a send at the same moment, where the send either commits before the take-over or is refused.
- Each viewer gets capabilities with the task: send, interrupt, answer approvals and take over. A watcher gets a read-only composer, no approval handler, and a "Sam is driving · Take over" bar.
- **The server enforces it.** `task.send` and `task.interrupt` reject a non-driver with `FORBIDDEN`. The UI only hides the controls.
- The driver's own message shows at once, keyed by a client message ID, and the committed message replaces it. The fold de-duplicates.

**The composer follows the agent's steering capability (ADR 0032).** An agent that declares `steerMidTurn`, OpenCode included, gets Send mid-turn, and the hint reads "Send reaches the agent at its next step. Interrupt and send stops the current turn." For an agent that can't take one mid-turn, Send queues the message and the thread shows it as "queued" for everyone, and the hint reads "Send queues. Interrupt and send stops the current turn." "Interrupt and send" is a separate action either way.

**A stock Send never queues, so ostra has its own** (spike 7, closing the open item at the foot of this ADR). assistant-ui's stock Send is disabled while a run is active and never calls `onNew`. So ostra provides its own Send button, or uses assistant-ui's `queue` adapter. ostra queues on the server either way (`task.send`), so the choice only affects how the button is wired. Two smaller notes: `aui.composer()` is deprecated in assistant-ui 0.15.36 and the property form is the supported one, and the composer leaves a hidden `<textarea aria-hidden>` for measuring, which tests must ignore.

**Approvals and questions:**
- They render only from committed events. An answer is committed, with its runner command queued durably, before anything reaches the agent.
- The options are "Approve once", "Approve for this task" and "Deny". "For this task" is an ostra rule on the task (a tool kind and a pattern). The agent is always answered "once", and later requests that match the rule are answered by ostra and recorded. ACP reports a new file and an edit as the same kind, `edit` (OpenCode's `write` replaced an existing file in spike 10's dry run), so the pattern, a path glob or a command prefix, carries the difference, and a kind alone is never a rule.
- **Any member who can open the project may answer.** The first answer wins, through a compare-and-set on the approval, and a second member gets a conflict. Each answer is an audit entry.
- A settled approval shows as a receipt, such as "Approved once by Alex". One that was cancelled or expired shows that, and nobody can answer it. The AI SDK's tool states can't carry a request that closed without a decision, so a closed approval's outcome rides in the part's `toolMetadata`, and the card reads it from there (spike 7, surprise 5).
- **A deny ends the agent's turn, and the runner re-prompts** (ADR 0032). The card says "Denied by Alex" and the thread shows the short message that follows. A deny also rejects every other pending request in that session, so the member's other open approvals there close as cancelled and show it.
- An agent's question (ACP elicitation) renders as a card, and its answer is a committed event. The driver advertises `elicitation.form` (ADR 0032).

**Safety.** Agent text, diffs and command output are untrusted (`AGENTS.md`): markdown with no raw HTML, safe links, and command output as plain text. The page calls no third party. assistant-ui bundles a cloud client that stays idle unless it's configured, and spike 7 checks that with a network log (ADR 0021).

**Long tasks and the render budget (Q112).** History pages by turn, the newest 20 turns first, with "Load earlier turns" paging back. The render bar is: the default view of a 5,000-event task renders in under 1.5 s on a mid laptop, measured unthrottled in a production build, with list virtualization for long tasks. Spike 7 had no device in its bar and used its own 4x CPU throttle on the dev machine, which failed two of three shapes (about 2 s) and passed the third (1.4 s), and unthrottled every shape took under 0.5 s. A throttle is not a laptop, and a dev build is not production, so neither is the bar. The reference is an ordinary laptop of the kind a team member has (four or more cores, 16 GB, not the fastest model), and it is measured when the milestone's task page is built, not before. Rows subscribe to their own part, so a long task doesn't re-render every row on each event. Virtualization uses `@tanstack/react-virtual`, which needs the maintainer's yes before it is installed (ADR 0007's pending table); until then, paging by turn is the whole long-task answer, and the bar is judged on the default view. The fallback for assistant-ui stays as the bar says: it is for assistant-ui failing, and spike 7 didn't show it was the cost.

## A turn's fields, its results, and bookkeeping out of the parts (amended 2026-11-22)

Milestone 10's compact thread (F-151; the maintainer, 2026-11-22: "our chatbox is soooo verbose and ugly") draws a turn's numbers in its opened run's footer, its time's tooltip and the panel, never as a line, and keeps bookkeeping out of the reading column. The fold stays the one pure function from events to messages; what changes is where it puts some events. Built by ticket 02's commit, `✨ give a turn its numbers and its results`.

- **A turn's fields** (`TaskMessageMeta`, each optional, so a message without them reads as before):
  - `ordinal`: the task's turn number, from 1, in `turn.started` order across its sessions, so a reopen's turn continues the count. `tasks.history` pages by turn, so a page that starts after the first turn takes the task's numbers from `FoldOptions.turnOrdinals` (`turnOrdinalsOf(tasks.get's usage.turns)`); a turn missing from it is numbered on from the one before it.
  - `spend`: from `FoldOptions.turnSpend` (`turnSpendOf(usage.turns)`), since prices live in core; missing until the turn is priced.
  - `saved`: the turn's `session.saved` (the archive's size or `null`, the hidden refs, the repos not saved, the checks counted). The runner saves after a turn's end and before the next turn starts (ADR 0039's order), so the save is matched to its session's last turn when it comes; its `turnOrdinal` counts the session's turns, which a page of history starting mid-session can't.
  - `ended`: on the session's last turn, its `session.ended`.
  - `stepTimes`: by each call's `toolCallId` (its `tool.called`'s time, then the time of the event that settled it: completed, failed, denied, closed, or the cancelling turn's end; `null` while it runs or waits), the subagents' calls included, and by `thought:<n>` for the turn's n-th reasoning part (from 0), from the turn's event before it to its own `agent.thought`.
- **Results in their turn.** A task branch's `git.pushed`, `pr.text_set`, `pr.opened`, `memory.proposed`, and the new `data-review` (`review.submitted`, a repeat `repeat: true`, with each `review.posted`) and `data-draft` (`draft.submitted`) are parts of their session's last turn, after its other parts, so after its text, instead of rows between turns. `data-pushed` gains `checks` (the turn's saved checks) and `firstPr` (the PR that followed it in the turn). One with no turn to join stays a row.
- **Out of the parts:** `data-saved`, the hidden ref's `data-pushed`, `data-session-end`, and the `system` rows of `runner.connected` and `session.config_changed`. Their facts are the fields above, and the Event log keeps every event. `runner.lost`, `session.crashed`, `session.restored` and `turn.cancel_requested` stay rows.
- **Nothing is lost:** `coverage.ts` places every kind as a message, a part, a turn field or the Event log only, and the fold's test checks each kind lands there; a kind with no place is a type error.
- Object identity of unchanged messages is kept, as before (the render bar).

## Considered options

- **`useChat` with a custom transport,** and assistant-ui's `useChatRuntime` on top. Rejected, because the hook assumes one browser that posts a request and reads one response:
  - A watcher has no request in flight.
  - A stream builds one assistant message, so another member's message has no chunk.
  - Resume replays a response from zero, where ostra resumes by sequence number.
  - The documented resumable setup needs Redis, against ADR 0017.
  - Its approval flow re-posts the conversation, where ostra's answer is a command to a runner.
  - It keeps history on the client, and ostra's history is in Postgres.
- **assistant-ui's `LocalRuntime` and `AssistantTransport`.** Rejected: the first is request-scoped, and the second adds assistant-ui's wire format beside tRPC.
- **AI Elements in shadcn/ui.** The fallback renderer. It takes the same `UIMessage` parts, so the swap changes the renderer only. Its examples use `useChat`, so the state, the composer gating and the approval plumbing would be ours to build. Revisit if assistant-ui's churn or its `any` types cost more than they save.
- **The AI SDK's experimental harnesses.** Rejected: bridge harnesses need a port exposed on the sandbox, and they're request-scoped in the UI.
- **AG-UI with CopilotKit.** Rejected: one more protocol to map into, with a large dependency tree and a run-scoped model.
- **Rivet's UI pieces.** Rejected: they tie the panel to Rivet's types, and Rivet is out (ADR 0032).
- **OpenCode's own web UI.** Rejected: the browser would reach into the box, bypassing Postgres and ADR 0011, and it serves one agent.
- **Building the AI SDK's UI message stream on the server.** Rejected: the server serves ostra's own events, and the fold runs in a shared package.

## Consequences

- ostra builds the fold, the converter to assistant-ui's message type, the renderers, the composer with its driver gating, the approval round trip and the rule store, plus the mutations `task.send`, `task.interrupt`, `task.takeOver` and `approval.answer`. Each authorizes, and uses a compare-and-set where two members can race.
- Both libraries move fast. The AI SDK ships about 69 patch releases a month and a major about every six months. assistant-ui is before 1.0, deprecates APIs with under a month's notice, and plans breaking type renames in 0.16. Both are pinned exactly, and the AI SDK is used only through `import type`. Spike 7 pinned an older pair (the AI SDK 7.0.17x and assistant-ui 0.15.36) because pnpm 11 refuses a version less than a day old. Milestone 1 pins the newest pair that is at least a day old when it installs them, since nothing in the spike's checks needed the newer one. assistant-ui's `unstable_` APIs carry deprecation tags that typescript-eslint's `no-deprecated` reports, so ostra avoids them.
- The AI SDK's optional fields don't mix with `exactOptionalPropertyTypes`, so parts are built with conditional spreads. Branded IDs become plain strings at the edge, and mutations parse them back.
- assistant-ui publishes no accessibility audit, so F-081 needs our own axe and keyboard pass.
- Spike 7 (`live-stream-and-task-view`) gates it:
  - Every kind of event in the recorded sessions renders, and nothing is dropped silently.
  - A watcher can't send, in the UI or by calling the API. When two members answer one approval, one wins.
  - 5,000 events render in under 1.5 s.
  - Strict typecheck and lint pass with only documented suppressions, and the page calls no third party.
- If assistant-ui fails spike 7, the page renders with AI Elements. If live text fails, it rides in the notification (ADR 0035).
- Spike 7 settled the `onNew` question: it doesn't fire while a run is active, as above. Three more of its findings are rules for the converter: system rows are completed assistant-role messages with `data-*` parts (assistant-ui takes a system message only with one text part), a closed approval rides in `toolMetadata`, and a row subscribes to its own part.
- Spike 7 is still open: two checks failed (the render bar, which is decided above, and a recorded-sessions check that needs spike 1's recordings, which carry no question or permission request) and two were skipped (the load bar's shape on Linux, and those recordings). The spike never ran Next.js, the shadcn kit, `@tanstack/react-virtual` or AI Elements, and an axe and keyboard pass (F-081) is still to do.
