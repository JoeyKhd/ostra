# The task page: AI SDK message types, rendered with assistant-ui

**Status:** accepted (2026-11-18, from the delegated answers in `context/history/answers-2026-11-18.md`). Settles Q50 and the approval rules in the answers' list of questions the research raises (`research/agent-ui-stream.md`). Covers F-023, F-024 and F-026. It adds `ai` (types only), `@assistant-ui/react` and `@assistant-ui/react-markdown` to ADR 0007.

The task page is a view of the event log (ADR 0035). The maintainer asked for the AI SDK and assistant-ui, and both are in. The AI SDK gives the message format and its tool states. assistant-ui gives the thread, the composer and the approval card. Only the transport is ostra's own.

**The view model:**
- The AI SDK's `UIMessage` types, with `import type` only, so they're erased under `verbatimModuleSyntax`. There's no `useChat`, no `@ai-sdk/react`, no chat transport and no `resumable-stream`.
- A pure function, `foldTaskEvents(events, liveText): TaskUIMessage[]`, in `packages/task-view` (Q78). The panel and its tests share it. A stored session and a live one run through the same function. It keeps object identity for messages that didn't change, and it shows an unknown event kind as a visible "unsupported event" row, never a silent drop.
- `TaskUIMessage` is `UIMessage` with ostra's generics, derived with `z.infer` from the Zod event union and the tool schemas, never typed again by hand. Parts the AI SDK has no type for, such as the plan, a question, a compaction and a driver change, are `data-*` parts.
- The AI SDK's types are never stored and never cross the runner protocol (ADR 0034), so a new major version can't force a data migration. The panel imports no ACP types.

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
- Each viewer gets capabilities with the task: send, interrupt, answer approvals and take over. A watcher gets a read-only composer, no approval handler, and a "Sam is driving · Take over" bar.
- **The server enforces it.** `task.send` and `task.interrupt` reject a non-driver with `FORBIDDEN`. The UI only hides the controls.
- The driver's own message shows at once, keyed by a client message ID, and the committed message replaces it. The fold de-duplicates.

**The composer follows the agent's steering capability (ADR 0032).** Send queues the message when the agent can't take one mid-turn, and the thread shows it as "queued" for everyone. "Interrupt and send" is a separate action. The hint reads "Send queues. Interrupt and send stops the current turn." An agent that declares `steerMidTurn` gets Send mid-turn.

**Approvals and questions:**
- They render only from committed events. An answer is committed, with its runner command queued durably, before anything reaches the agent.
- The options are "Approve once", "Approve for this task" and "Deny". "For this task" is an ostra rule on the task (a tool kind and a pattern). The agent is always answered "once", and later requests that match the rule are answered by ostra and recorded.
- **Any member who can open the project may answer.** The first answer wins, through a compare-and-set on the approval, and a second member gets a conflict. Each answer is an audit entry.
- A settled approval shows as a receipt, such as "Approved once by Alex". One that was cancelled or expired shows that, and nobody can answer it.
- An agent's question (ACP elicitation) renders as a card, and its answer is a committed event. The driver advertises `elicitation.form` (ADR 0032).

**Safety.** Agent text, diffs and command output are untrusted (`AGENTS.md`): markdown with no raw HTML, safe links, and command output as plain text. The page calls no third party. assistant-ui bundles a cloud client that stays idle unless it's configured, and spike 7 checks that with a network log (ADR 0021).

**Long tasks.** History pages by turn. Row virtualization with `@tanstack/react-virtual` comes only if spike 7 needs it, and needs a yes first.

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
- Both libraries move fast. The AI SDK ships about 69 patch releases a month and a major about every six months. assistant-ui is before 1.0, deprecates APIs with under a month's notice, and plans breaking type renames in 0.16. Both are pinned exactly, and the AI SDK is used only through `import type`. assistant-ui's `unstable_` APIs carry deprecation tags that typescript-eslint's `no-deprecated` reports, so ostra avoids them.
- The AI SDK's optional fields don't mix with `exactOptionalPropertyTypes`, so parts are built with conditional spreads. Branded IDs become plain strings at the edge, and mutations parse them back.
- assistant-ui publishes no accessibility audit, so F-081 needs our own axe and keyboard pass.
- Spike 7 (`live-stream-and-task-view`) gates it:
  - Every kind of event in the recorded sessions renders, and nothing is dropped silently.
  - A watcher can't send, in the UI or by calling the API. When two members answer one approval, one wins.
  - 5,000 events render in under 1.5 s.
  - Strict typecheck and lint pass with only documented suppressions, and the page calls no third party.
- If assistant-ui fails spike 7, the page renders with AI Elements. If live text fails, it rides in the notification (ADR 0035).
- Whether assistant-ui's `onNew` fires while a run is active without its own queue adapter is unverified. Spike 7 checks it. ostra queues on the server either way.
