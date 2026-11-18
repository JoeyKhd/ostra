# Research: the live agent UI, on the Vercel AI SDK and assistant-ui

**Question:** The maintainer wants the official Vercel AI SDK (`ai`, `@ai-sdk/react`) for live typing and the message format, with assistant-ui on top for the thread. Can that carry a task's activity, which comes from a coding agent over ACP, through the runner and Postgres, to several members watching one task, with only the driver sending? This page covers the mapping, the transport, multi-viewer, approvals and types, and where it doesn't fit.
**Checked:** 2026-11-18. Versions come from the npm registry and the GitHub API on that date ([Versions checked](#versions-checked)). Docs were read as markdown from ai-sdk.dev, assistant-ui.com, agentclientprotocol.com and opencode.ai on that date. Claims I couldn't confirm from a primary source (docs, source, published package) are marked **unverified**.
**Informs:** Q50, F-023 (live activity), F-024 (steer, take over), F-026 (approvals), F-062, F-081; Q23; ADR 0007, 0011, 0018, 0024, 0025; `research/live-sync.md`; `research/rivet.md`.

Recommendations are marked as such. They aren't decisions.

**About Rivet.** The brief assumed Rivet Sandbox Agent's "universal session schema". That schema was removed in sandbox-agent 0.2.0 (2026-02-11). Since then the SDK's `SessionEvent.payload` is the raw ACP JSON-RPC message (`payload: AnyMessage` in the published 0.5.6 types; `research/rivet.md` §3). `research/rivet.md` recommends that the runner drive agents over ACP directly with `@agentclientprotocol/sdk`. This page therefore maps **ACP's own messages**. If Rivet stays, nothing below changes, because Rivet passes the same ACP messages through.

---

## Summary

**Verdict: it fits, but only in part. The AI SDK fits as the message format. Its hooks and transport don't. assistant-ui fits through its external store runtime.**

- **The AI SDK's message format fits.**
  - `UIMessage` parts cover text, reasoning, typed tool calls and custom `data-*` parts.
  - AI SDK 7's tool-part states cover what a coding-agent timeline needs: `input-streaming`, `input-available`, `approval-requested`, `approval-responded`, `output-available` (with `preliminary` for interim output), `output-error` and `output-denied` ([ui-messages.ts](https://github.com/vercel/ai/blob/main/packages/ai/src/ui/ui-messages.ts); also in the published `ai@7.0.176` types).
  - Every ACP update maps to one of: a part, message metadata, task state, or an ostra-defined `data-*` part ([mapping table](#the-mapping)).
- **The AI SDK's live-typing path does not fit.** `useChat`, `ChatTransport`, `resume` and `resumable-stream` are built around one browser POSTing a request and reading one streamed assistant response ([transport](https://ai-sdk.dev/docs/ai-sdk-ui/transport), [resume](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams)). ostra's live stream works differently:
  - It comes from a runner, through Postgres, to many viewers.
  - It spans many turns.
  - It carries user messages written by other members.
  - It resumes by sequence number, not by replaying one response.
  - Bending `useChat` to that shape fights the abstraction at every step ([§3](#3-is-the-transport-pluggable)).
- **assistant-ui fits well through `useExternalStoreRuntime`.** Use it instead of `useChatRuntime`.
  - It renders state the app owns.
  - `isDisabled` makes the composer read-only for watchers.
  - Leaving out `onRespondToToolApproval` hides the approval controls.
  - Its approval options use the same four kinds as ACP's (`allow-once`, `allow-always`, `reject-once`, `reject-always`).
  - assistant-ui documents this exact pattern for an agent whose session is a server-side event log ([Claude Managed Agents](https://www.assistant-ui.com/docs/runtimes/claude-managed-agents)). Its own OpenCode runtime is built the same way ([OpenCode runtime](https://www.assistant-ui.com/docs/runtimes/opencode/overview)).
- **Recommended shape:**
  1. The runner maps ACP into ostra's own typed events (ADR 0018).
  2. The server saves them with a per-task `seq` (`live-sync.md`).
  3. One tRPC v11 SSE subscription per task page carries committed events plus ephemeral "live text" frames (Q23).
  4. A shared pure function folds the events into `TaskUIMessage[]`, which is the AI SDK's `UIMessage` type with ostra's generics.
  5. A small converter of our own feeds assistant-ui's `useExternalStoreRuntime`.
- **What ostra builds itself:** the fold, the converter, the live-text channel, the tool renderers (read, edit with a diff, command with output, approval card), driver-only sending and the approval round trip. The libraries give the message types, the thread and composer primitives, the scrolling, and the approval UI contract.

**Top risks:**
1. assistant-ui is pre-1.0 and churns. Its tool APIs were deprecated this year, its AI SDK package moved in August, and 0.16 brings breaking type renames.
2. The AI SDK ships about 69 patch releases a month and a major about every six months.
3. Partial-text fan-out from the core service to Next.js is unproven.
4. OpenCode can't steer mid-turn.

The spike at the end tests all four.

---

## Versions checked

All checked 2026-11-18. Sources: the npm registry, plus `api.npmjs.org` for downloads (the week of 2026-11-11 to 11-17) and the GitHub API for stars.

| Package | Version | Published | License | Downloads/week | Cadence and maturity |
|---|---|---|---|---|---|
| `ai` | 7.0.176 | 2026-11-17 | Apache-2.0 | 47.2M | 69 stable releases in the last 30 days. Majors: 5.0 on 2025-07-31, 6.0 on 2025-12-22, 7.0 on 2026-06-25. Peer `zod ^3.25.76 \|\| ^4.1.8`. `vercel/ai` has 28.1k stars |
| `@ai-sdk/react` | 4.0.180 | 2026-11-17 | Apache-2.0 | 13.8M | Same cadence. Peer `react ^18 \|\| ~19.0.1 \|\| ~19.1.2 \|\| ^19.2.1` |
| `@assistant-ui/react` | 0.15.37 | 2026-11-18 | MIT | 3.36M | 8 releases in 30 days, 22 in 90. 0.15.0 on 2026-07-28. Pre-1.0; 0.16 planned with breaking type renames ([#9106](https://github.com/assistant-ui/assistant-ui/issues/9106)). Peer `react ^18 \|\| ^19`. 13.3k stars |
| `@assistant-ui/core` / `store` / `tap` | 0.3.37 / 0.3.24 / 0.9.26 | 2026-11-13 to 11-18 | MIT | (transitive) | Pulled in by `@assistant-ui/react` |
| `@assistant-ui/ai-sdk` | 0.0.19 | 2026-11-18 | MIT | n/a | New home of the AI SDK integration, created 2026-08-18. Peer `ai ^7.0.101` |
| `@assistant-ui/react-ai-sdk` | 1.4.24 | 2026-11-18 | MIT | 661k | Now one line: `export * from "@assistant-ui/ai-sdk"` (published `dist/index.d.ts`) |
| `@assistant-ui/react-markdown` | 0.14.26 | 2026-11-11 | MIT | n/a | Built on `react-markdown` 10. Peer `@assistant-ui/react ^0.15.0` |
| `assistant-stream`, `assistant-cloud` | 0.3.58, 0.2.13 | 2026-11-18 | MIT | 3.77M, n/a | Dependencies of `@assistant-ui/react`. The cloud client stays idle unless you configure it ([Risks](#risks)) |
| `@assistant-ui/react-ui` | 0.2.1 | 2025-10-17 | MIT | n/a | **Stale.** The styled kit moved to the shadcn registry. Don't use it |
| `@assistant-ui/react-opencode` | 0.2.35 | 2026-11-08 | MIT | n/a | Experimental, built on ExternalStoreRuntime. Prior art only |
| `@agentclientprotocol/sdk` | 2.7.0 | 2026-11-14 | Apache-2.0 | ~9.8M (`rivet.md`) | Its default export is **protocol v1 (stable)**. Protocol v2 is under `./experimental/v2` (package `exports`) |
| `@agentclientprotocol/claude-agent-acp` | 0.108.0 | 2026-11-17 | Apache-2.0 | n/a | Serves ACP v1 and the draft v2 |
| OpenCode | ACP registry `opencode` 2.3.2; npm `opencode-ai` and GitHub "latest" 1.19.6 | 2026-11-17 | MIT | n/a | `opencode acp` speaks ACP v1 ([OpenCode ACP](https://opencode.ai/docs/cli/acp)) |
| `sandbox-agent` / `@sandbox-agent/react` | 0.5.6 / 0.5.6 | 2026-11-05 | Apache-2.0 | 55k / 9.9k | Footnote (`rivet.md`) |
| `ai-elements` | 1.9.1 | 2026-10-14 | Apache-2.0 | n/a | **Deprecated at the end of November 2026**, in favour of AI Elements in shadcn/ui ([intro](https://elements.ai-sdk.dev/llms.txt)) |
| `@ai-sdk/harness`, `@ai-sdk/harness-opencode` | 1.0.187, 1.0.190 | 2026-11-17 | Apache-2.0 | n/a | **Experimental** ([overview](https://ai-sdk.dev/docs/ai-sdk-harnesses/overview)). See [§8](#8-alternatives-for-comparison) |
| `@ag-ui/client` / `@ag-ui/core` | 1.0.5 | 2026-11-17 | MIT | 2.4M | AG-UI 1.0. 20.3k stars |
| `@copilotkit/react-core` | 1.89.0 (next: 2.0.0-rc.60) | 2026-11-17 | MIT | 784k | 38.8k stars |
| `resumable-stream` | 2.2.13 | 2026-09-16 | ISC | 1.16M | Needs Redis (ADR 0017 conflict). Not used |
| `next` / `react` | 16.4.6 / 19.3.1 | n/a | MIT | n/a | assistant-ui's own examples use `next ^16.4.5`, `react ^19.3.1` and `tailwindcss ^4.3.3` ([with-external-store](https://github.com/assistant-ui/assistant-ui/blob/main/examples/with-external-store/package.json)) |

---

## 1. Versions, licenses, cadence, maturity

- **Licenses:**
  - The AI SDK packages are Apache-2.0 (npm metadata and the repo's [LICENSE](https://github.com/vercel/ai/blob/main/LICENSE) text; the GitHub API reports the repo license as "NOASSERTION").
  - assistant-ui is MIT, by AgentbaseAI Inc. (`package.json`).
  - Both are compatible with ostra's AGPL server and Apache-2.0 runner (ADR 0009).
- **React 19 and Next.js 16:**
  - Both libraries declare React 19 support.
  - assistant-ui's examples and docs app run on Next 16.4 and React 19.3.
  - No open issue on Next 16 compatibility turned up in a GitHub issue search.
  - `@assistant-ui/react` is a client-side library, so the task thread is a client component.
- **AI SDK maturity:** mature and very fast-moving.
  - Majors land about every six months.
  - `UIMessage` changed shape in v5 (parts), and v6 added the approval states.
  - v7's changes to UI messages were small: it removed `isToolOrDynamicToolUIPart` and some deprecated content-part variants ([v7 migration](https://ai-sdk.dev/docs/migration-guides/migration-guide-7-0)).
- **assistant-ui maturity:** widely used (3.4M a week), but pre-1.0, with fast-moving APIs:
  - **The tool APIs.** `makeAssistantToolUI`, `useAssistantToolUI`, `makeAssistantTool` and `useAssistantTool` are deprecated in favour of toolkits ([migration](https://www.assistant-ui.com/docs/migrations/toolkit-tools)).
  - **The AI SDK integration** moved to `@assistant-ui/ai-sdk` in August 2026.
  - **0.16** renames the store state types. "The runtime API is a Beta feature, whose deprecations get under one month of notice" ([#9106](https://github.com/assistant-ui/assistant-ui/issues/9106)).
  - **`unstable_` APIs** "may change in any release including patch releases". They carry `@deprecated` tags, which typescript-eslint's `strict-type-checked` reports through `no-deprecated` ([stability](https://www.assistant-ui.com/docs/runtimes/concepts/stability)).

## 2. The UI message stream protocol and `UIMessage` parts

**The parts** (published `ai@7.0.176` types; [ui-messages.ts](https://github.com/vercel/ai/blob/main/packages/ai/src/ui/ui-messages.ts)):
- **The message:** `UIMessage<METADATA, DATA_PARTS, TOOLS>` with `id`, `role` (`system | user | assistant`), `metadata` and `parts`.
- **Part types:** `text` (with `state: streaming | done`), `reasoning`, `tool-${name}` (typed per tool), `dynamic-tool` (untyped, `toolName: string`), `file`, `reasoning-file`, `source-url`, `source-document`, `custom` (provider-specific), `data-${name}` (with an optional `id` for reconciliation), `step-start`, and the experimental `steering-message`.
- **Tool parts** carry `toolCallId`, `title?`, `toolMetadata?` (a JSON object), `providerExecuted?` and a state union:
  - `input-streaming` (with `rawInput` text)
  - `input-available`
  - `approval-requested` (`approval: {id, descriptor?, requestReason?, isAutomatic?}`)
  - `approval-responded` (`approved: boolean`, `reason?`)
  - `output-available` (`output`, `preliminary?`)
  - `output-error` (`errorText`)
  - `output-denied`

**The wire protocol** ([stream protocol](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)):
- SSE with the header `x-vercel-ai-ui-message-stream: v1`.
- Chunks: `start`, `text-start/delta/end`, `reasoning-*`, `tool-input-start/delta/available`, `tool-approval-request`, `tool-approval-response`, `tool-output-available/error/denied`, `data-*` (optionally `transient`), `start-step`, `finish-step`, `reset-step`, `finish`, `abort` and `message-metadata`.
- **One stream builds one assistant message.** A `start` chunk with a new `messageId` resets the state instead of opening a second message ([process-ui-message-stream.ts](https://github.com/vercel/ai/blob/main/packages/ai/src/ui/process-ui-message-stream.ts), `case 'start'`).
- **There's no chunk for a user message**, apart from the experimental `steering-message`.

**Can ACP be represented losslessly?** For display, yes, with ostra-defined data parts for what the AI SDK has no type for. The full row-by-row answer is the [mapping table](#the-mapping). In short:
- **Fits directly:**
  - text, reasoning and images
  - tool calls of every ACP `kind`, with `title`, interim output and errors
  - plans, as a reconciled `data-plan` part
  - the stop reason, as message metadata
- **Fits with an ostra convention:**
  - **Approvals with more than two options.** The AI SDK's response is a boolean. The ACP options travel in `approval.descriptor`, which assistant-ui already reads options from (published `@assistant-ui/ai-sdk` 0.0.19, `readApprovalDescriptor`).
  - **Questions.** ACP `elicitation/create` has no AI SDK type.
  - **Who answered** an approval.
  - **Cancelled and expired** approvals.
  - **Subagent transcripts.** The AI SDK has no nested messages; assistant-ui does (`ToolCallMessagePart.messages`).
  - **System rows:** driver changed, runner lost, session restored.
- **Doesn't belong in messages:** `available_commands_update`, `session_info_update`, `current_mode_update` and `config_option_update`. These are task state. So is `usage_update`, which also goes into message metadata.
- **Lost by design (Q23):** partial text that was never completed when a runner crashed. The agent's own session history still has it.

The event log keeps every committed event in ostra's own shape (ADR 0018), with the raw ACP payload size-capped for unknown kinds. The fold is a *view*, so a lossy view never loses data.

## 3. Is the transport pluggable?

**Yes, in form.** `useChat({ transport })` accepts any object that implements `ChatTransport`:
- `sendMessages({trigger, chatId, messageId, messages, abortSignal, …}) → ReadableStream<UIMessageChunk>`
- `reconnectToStream({chatId}) → stream | null`
- optional `resumeStreamIsReplay` and `close`

The source is [chat-transport.ts](https://github.com/vercel/ai/blob/main/packages/ai/src/ui/chat-transport.ts). The SDK ships `DefaultChatTransport` (HTTP), `WebSocketChatTransport`, `DirectChatTransport` (in-process Agent) and `WorkflowChatTransport` ([transport](https://ai-sdk.dev/docs/ai-sdk-ui/transport)).

**In substance it doesn't fit ostra, for six reasons:**
1. **Request-scoped.**
   - `sendMessages` is called per user submission, posts the whole history, and returns *that response's* stream.
   - A watcher who didn't send has no request in flight.
   - The only way to see a turn someone else started is `resumeStream()`, which the hook calls on mount and when a backgrounded page comes back after a network drop ([resume](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams)).
   - A watcher would need a second channel just to learn that a turn started.
2. **One assistant message per stream.**
   - A task stream spans many turns and includes the driver's messages.
   - The chunk protocol can't carry another member's user message.
3. **Resume replays from zero.**
   - `reconnectToStream` must return the *complete* active response from its first chunk, keeping the original `start` `messageId`.
   - A continuation without `start` keeps state only within the same chat instance, so "a page reload does not retain that streaming state, so use a full replay for reloads" ([resume](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams), [transport](https://ai-sdk.dev/docs/ai-sdk-ui/transport)).
   - ostra resumes by `seq` across the whole task (`live-sync.md`).
4. **Redis.** The documented resumable setup needs the `resumable-stream` package and Redis. That breaks ADR 0017.
5. **The wrong approval flow.**
   - `addToolApprovalResponse` plus `sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses` re-POSTs the conversation so the server continues the model call ([tool usage](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage)).
   - ostra's answer is a command routed to a runner, not a re-POST.
6. **Client-owned history.** `useChat` holds `messages` on the client and sends them to the server. ostra's history lives in Postgres and is written by the server.

**Many viewers of one stream.** The AI SDK has no multi-viewer story beyond each client resuming the same active stream. `resumable-stream` fans out through Redis pub/sub, and each viewer must still know which stream is active. ostra's fan-out (`live-sync.md`: Postgres plus batched `NOTIFY`, a per-replica tailer, tRPC SSE with `tracked(seq)`) already gives every viewer every committed event, in order, gap-free.

**Loading history.** Doable with `useChat({ messages })`. But then history and live updates come from two sources with different shapes and must be reconciled by hand.

**Do we want `useChat` at all? Recommendation: no.** The lower-level pieces don't help either:
- `readUIMessageStream` folds *one* message per stream: "Each stream part represents a different state of the same message" ([reference](https://ai-sdk.dev/docs/reference/ai-sdk-ui/read-ui-message-stream)).
- `createUIMessageStream` on the server would turn ostra's events into a wire format that the client would only parse back.

The piece that fits is **our own pure fold, over our own typed events, producing AI SDK `UIMessage` objects**, handed to assistant-ui's `useExternalStoreRuntime`. assistant-ui's Claude Managed Agents integration does exactly this: "one pure fold from the event array to assistant-ui's message model … replaying a stored session and tailing a live one run through the same pure function" ([docs](https://www.assistant-ui.com/docs/runtimes/claude-managed-agents)).

## 4. assistant-ui

**Runtimes** ([custom runtimes](https://www.assistant-ui.com/docs/runtimes/custom/overview)):
- **`useChatRuntime` / `useAISDKRuntime`** (`@assistant-ui/ai-sdk`): wrap `useChat`. `useAISDKRuntime` takes `UseChatHelpers` ([API](https://www.assistant-ui.com/docs/api-reference/integrations/ai-sdk)). They inherit every mismatch in [§3](#3-is-the-transport-pluggable). **No.**
- **`LocalRuntime`:** the runtime owns the state, and you supply a `ChatModelAdapter` that runs one turn. That's request-scoped too. **No.**
- **`AssistantTransport`:** POSTed commands plus a streamed state protocol, "layered on ExternalStoreRuntime" ([docs](https://www.assistant-ui.com/docs/runtimes/custom/assistant-transport)). It would add assistant-ui's wire format next to tRPC. **No.**
- **`useExternalStoreRuntime`: yes.** "You provide messages and callbacks; the runtime renders whatever you give it. UI features turn on based on which callbacks are present" ([external store](https://www.assistant-ui.com/docs/runtimes/custom/external-store)).
  - `messages: T[]` plus `convertMessage: (m: T) => ThreadMessageLike`
  - `isRunning`
  - **`isDisabled`** "disables typing, attaching, sending … and editing", which suits watchers. `isSendDisabled` is the narrower version.
  - `onNew` (required), `onCancel`
  - **`onRespondToToolApproval`**, `onAddToolResult`, `onResumeToolCall`
  - `hasEarlier` plus `onLoadEarlier` for paging
  - `adapters.attachments`
  - `queue` (with a steer lane)
  - `activeRunId`

**Fit for "external, server-owned, multi-viewer, only the driver sends":**
- The server's per-viewer capabilities decide which handlers ostra passes.
- **The driver** gets `onNew`, `onCancel` and the approval handler.
- **A watcher** gets `isDisabled: true` and no `onRespondToToolApproval`. "Any of `onAddToolResult`, `onResumeToolCall`, and `onRespondToToolApproval` turns on `s.thread.capabilities.answerToolCall`." Without them it's `false`, and the kit renders requests "without its controls" ([tool UI](https://www.assistant-ui.com/docs/tools/tool-ui)). `ReadonlyThreadProvider` gives the same for embedded read-only transcripts.
- The server still enforces all of this ([Recommended architecture](#driver-only-sending-and-many-viewers)).

**Custom tool UIs:**
- `makeAssistantToolUI` is **deprecated**.
- Register render-only renderers in a toolkit with `Tools({ toolkit })`.
- For tools that run elsewhere (ostra's case), a plain `"use client"` toolkit entry `{ type: "backend", render }` works without assistant-ui's `"use generative"` build plugin ([defining tools](https://www.assistant-ui.com/docs/tools/defining-tools)). Recommendation: use this. The `withAui` Next.js plugin isn't needed.
- `MessagePrimitive.Parts` takes inline per-surface overrides.
- The renderer gets `args`, `result`, `status` (`running`, `requires-action`, `incomplete`, `complete`), `approval` and `respondToApproval`.
- ostra needs four renderers, keyed by ACP `kind`, not by agent tool name (adapter parity):
  - `read`, a one-line row
  - `edit`, a row with `+added −removed`, expanding to a diff
  - `execute`, the command plus its output and exit status
  - the approval card
- Everything else falls back to a generic row.

**Human-in-the-loop and approvals.** These are first-class:
- **The three-state signal.** `approval.approved` is undefined (open, ask the user), `true` or `false`.
- **Options.** `options[]` with `kind` set to `allow-once`, `allow-always`, `reject-once` or `reject-always`, plus `id`, `label`, `grants` and `confirm`. "scope semantics like session versus global belong to the option's `id` and `label`, which only the host interprets". `respondToApproval({ optionId })` resolves it.
- **Questions.** `prompt`, `display: decision | select | text | questions`, and `questions[]` with typed answers.
- **Closed without a decision.** `resolution: "cancelled" | "expired"`.
- **Receipts.** Settled approvals render as a record of the decision, not as live controls ([tool UI](https://www.assistant-ui.com/docs/tools/tool-ui)).
- The four option kinds are ACP's `PermissionOptionKind` with dashes instead of underscores, which makes the mapping mechanical.

**Attachments.**
- `adapters.attachments` (`add`, `send`, `remove`) on the external store ([attachments guide](https://www.assistant-ui.com/docs/guides/attachments)).
- For ostra: upload to the server, then the runner writes the file into the workspace and sends an ACP `resource_link` with a `file://` URI, which OpenCode attaches ([OpenCode ACP](https://opencode.ai/docs/cli/acp), "Prompt content").
- Not needed for the spike.

**Theming.**
- The styled kit is installed as source through the shadcn CLI. Its registry is style-aware (`"@assistant-ui": "https://r.assistant-ui.com/styles/{style}/{name}.json"`) and serves the Radix or Base UI flavour to match `components.json` ([Base UI](https://www.assistant-ui.com/docs/base-ui), [manual install](https://www.assistant-ui.com/docs/manual-installation)).
- That fits ADR 0007 (shadcn/ui plus Tailwind 4).
- The concept (`brand/app-concepts/02-task-v2.png`) differs from the default kit (compact one-line tool rows, an amber approval card, Interrupt plus Send), so expect custom renderers built on the primitives.

**Accessibility.**
- Primitives are "unstyled, accessible building blocks" in the Radix pattern (`Root`, parts, `asChild`), with submit on Enter, focus management and an accessible error primitive ([primitives](https://www.assistant-ui.com/docs/primitives)).
- I found no published WCAG audit (**unverified**). F-081 needs our own axe and keyboard pass.

**Performance with long sessions.**
- By default the kit renders message bodies with `content-visibility: auto`.
- For "hundreds to thousands of messages", assistant-ui documents row virtualization with `@tanstack/react-virtual`: `createThreadRowsSelector` turns the thread into one row per user message, per assistant *part* and per turn end, and `ThreadPrimitive.Row` renders each. Its row keys stay stable while tokens stream ([virtualization](https://www.assistant-ui.com/docs/guides/virtualization)).
- That suits agent turns, which are often one message with hundreds of tool parts.
- **Paging:** `hasEarlier` plus `onLoadEarlier`.
- **Our own duty:** the fold must keep object identity for messages that didn't change, so the converter's per-message cache works. An external-store memory fix was merged on 2026-11-13 ([#10513](https://github.com/assistant-ui/assistant-ui/pull/10513)), so this path is actively maintained.

## 5. Approvals end to end

**The AI SDK has built-in approval states** (`approval-requested`, `approval-responded`, `output-denied`, plus the `tool-approval-request` and `tool-approval-response` chunks), but its response is `approved: boolean` (plus `reason`). ostra's three choices fit assistant-ui's options model, so the choice is carried in `approval.descriptor` and in ostra's own event.

**The flow.** OpenCode offers `once` (`allow_once`), `always` (`allow_always`) and `reject` (`reject_once`) ([OpenCode ACP](https://opencode.ai/docs/cli/acp), "Permissions").

1. **The agent asks.** It sends ACP `session/request_permission`, a JSON-RPC *request* from agent to client with `{sessionId, toolCall, options[{optionId, name, kind}]}` ([tool calls](https://agentclientprotocol.com/protocol/v1/tool-calls)). OpenCode adds `diff` content "if it can build a preview of the change".
2. **The runner records it.** Its ACP driver keeps the pending request open, maps it to `approval.requested {approvalId, toolCallId, options, preview}`, spools it and ships it.
3. **The server saves it.** One transaction inserts the event (`seq`), creates the Approval row (Home's "needs you", F-062) and enqueues notifications such as the Linear comment. Saved before acted on (ADR 0011).
4. **Every viewer sees it.** The event reaches every viewer over SSE. The fold sets the tool part to `approval-requested` with `approval.id = approvalId` and `approval.descriptor.options` set to ostra's three options: `{id: "once", kind: "allow-once"}`, `{id: "task", kind: "allow-always", label: "Approve for this task"}` and `{id: "deny", kind: "reject-once"}`. The converter puts them on the assistant-ui part, and the message status becomes `requires-action`.
5. **It renders.** The approval renderer draws the concept's card.
   - **Members allowed to answer** get buttons wired to `respondToApproval({ optionId })`.
   - **Everyone else** sees "Waiting for approval", because `answerToolCall` is false.
6. **A member answers.** `onRespondToToolApproval({ approvalId, optionId })` calls the tRPC mutation `approval.answer({taskId, approvalId, decision, idempotencyKey})`. The server:
   - authorizes the member, team and role
   - runs a compare-and-set on the Approval row (`pending → answered`), so the first answer wins and a second member gets a conflict error
   - writes `approval.answered {decision, memberId}` in the same transaction
   - enqueues the runner command in the durable queue (ADR 0011, ADR 0017)
7. **The runner answers the agent** with `outcome: {outcome: "selected", optionId}`:
   - **"Approve once"** maps to the agent's `allow_once` option.
   - **"Approve for this task"** becomes an **ostra-owned rule** on the task (tool kind plus command or path pattern). The runner answers `allow_once`, and auto-answers later requests that match, recording each as `approval.auto_answered`.
   - Don't rely on the agent's own `allow_always`. OpenCode stores it as a durable, project-scoped rule in its own store, which is gone on a fresh box (`rivet.md` §4).
8. **Everyone converges.** The agent continues. `tool_call_update` moves the part to `output-available`, keeping `approval.approved = true`. A denial ends in `output-denied`. Every viewer's card becomes the receipt "Approved once by Alex", from the event.
9. **Cancelled or expired.** If the turn is cancelled, the runner restarts, or the request waits past the working-value timeout that `rivet.md` recommends (cancel the turn, keep the request in Postgres, re-prompt with the decision later), the server writes `approval.closed {reason: cancelled | expired}`. The part shows `resolution`, and nobody can answer a request that's gone. OpenCode itself "rejects pending permission requests" on `session/cancel` ([OpenCode ACP](https://opencode.ai/docs/cli/acp), "Cancellation").

**Questions** follow the same path:
- ACP `elicitation/create` is stable in ACP v1 and is a request from agent to client.
- **Form mode** carries a restricted JSON Schema. **URL mode** opens an out-of-band link. The answer is `accept`, `decline` or `cancel` ([elicitation](https://agentclientprotocol.com/protocol/v1/elicitation)).
- OpenCode asks questions this way only "if the client advertises `elicitation.form`". Otherwise it "cancels the question and tells the model to continue without an answer" ([OpenCode ACP](https://opencode.ai/docs/cli/acp), "Questions"). **So the runner must advertise `elicitation.form`.**
- The fold renders a question as an approval with `display: "select" | "text" | "questions"`.

## 6. Server side

**Where to build the AI SDK UI stream. Recommendation: nowhere.**
- The server serves ostra's typed events (committed, with `seq`) and the live-text frames, over the tRPC subscription `live-sync.md` already proposes.
- The fold lives in a shared package, so it runs in the browser and, when wanted, on the server too:
  - first paint (a server component prefetching history)
  - PR and Linear summaries
  - `ostra attach` (F-041)

**Does AI SDK UI work without AI SDK Core? Yes.**
- `createUIMessageStream` takes a writer you fill by hand.
- The protocol page documents custom backends "implemented in a different language such as Python" ([stream protocol](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)).
- `UIMessage` is a plain type.

**The "you must call a model" assumptions live in the hooks:**
- `useChat` posts the history for the server to run a model on.
- `regenerate` exists.
- `sendAutomaticallyWhen` re-posts after tool results and approvals.
- `DirectChatTransport` needs an AI SDK `Agent`.
- The resume recipe wraps a `streamText` result.

None of that applies if ostra uses only the types. Using only the types also means `@ai-sdk/react` isn't needed.

## 7. Type safety

**Written once.**
- One Zod schema per tool kind, for its normalized input and output.
- ostra's event union (ADR 0018) and the stream-frame union are Zod schemas, imported by the runner, the server and the panel.
- The UI types are derived from them, never written by hand:

```ts
// packages/task-view (illustrative)
import type { UIMessage } from "ai";
import { z } from "zod";

export const toolSchemas = {
  read: { input: z.object({ path: z.string() }), output: z.object({ lineCount: z.number().int().optional() }) },
  edit: { input: z.object({ paths: z.array(z.string()) }), output: z.object({ files: z.array(fileChange) }) },
  execute: {
    input: z.object({ command: z.string(), cwd: z.string().optional() }),
    output: z.object({ output: z.string(), truncated: z.boolean(), exitCode: z.number().int().nullable() }),
  },
  // delete, move, search, fetch, think, switch_mode
} as const satisfies Partial<Record<AcpToolKind, { input: z.ZodType; output: z.ZodType }>>;

type ToolSchemas = typeof toolSchemas;
export type TaskUITools = {
  [K in keyof ToolSchemas]: { input: z.infer<ToolSchemas[K]["input"]>; output: z.infer<ToolSchemas[K]["output"]> };
};
export type TaskUIMessage = UIMessage<TaskMessageMeta, TaskDataParts, TaskUITools>;
```

**How the types are built:**
- `InferUITools<ToolSet>` needs AI SDK `tool()` objects. Deriving `TaskUITools` from Zod with `z.infer`, as above, gives the same `{input, output}` shape and keeps `ai` an `import type`-only dependency of the view package, erased under `verbatimModuleSyntax`.
- `TaskDataParts` (`plan`, `question`, `compaction`, `driver-change`, `session-status`, …) is a map of `z.infer` types, which satisfies `UIDataTypes`.
- `validateUIMessages({ messages, metadataSchema, dataSchemas, tools })` exists for checking stored UI messages. ostra stores none, so use it only in the fold's tests.

**Exhaustive switches:**
- The fold switches over ostra's event union with `satisfies never`.
- Renderers switch over the AI SDK's tool-part `state` union. The AI SDK docs say typed parts include the approval states "so exhaustive" switches cover them ([tool usage](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage)).

**Friction with assistant-ui:**
- `ThreadMessageLike`'s data part is `data: any`, and its tool part has `result?: any` (published `@assistant-ui/core` 0.3.37, `thread-message-like.d.ts`). Reading them trips `no-unsafe-*`.
- Fix: renderers don't read `args` or `result` from assistant-ui. They take the `toolCallId` and read the typed `TaskUIMessage` part from ostra's store through a hook, or `safeParse` with the shared schema.
- Experimental assistant-ui APIs carry `@deprecated` tags (see §1). Avoid them, or list them in `no-deprecated`'s `allow`.

**`exactOptionalPropertyTypes`.** The AI SDK's types use `?:` fields. Build parts with conditional spreads, never `{ x: undefined }`.

**Branded IDs.** `TaskId`, `ApprovalId` and `SegmentId` are branded in ostra's events. The fold converts them to the AI SDK's plain `string` ids at the edge, and the mutations parse them back with the Zod brand.

## 8. Alternatives, for comparison

| Option | What it is | When it would be better | Why not now |
|---|---|---|---|
| **AI Elements in shadcn/ui** ([docs](https://ui.shadcn.com/docs/ai-elements)) | Patterns copied into the repo, with no package: Chat (Message Scroller), Message, Tool, Confirmation, Terminal, Plan, Reasoning, Queue, Subagent, Context. They take AI SDK `UIMessage` parts as props ("Trace does not read tool parts. Map each part's `state` to a `status`", [tool](https://ui.shadcn.com/docs/ai-elements/base/tool)). They replace the deprecated `ai-elements` | If assistant-ui's churn or `any` friction costs more than its composer, scrolling and approval plumbing save. It's the lightest fit for ADR 0007, and it renders the same `TaskUIMessage[]`, so switching changes the renderer only | The examples use `useChat`, so the state, composer gating, approval options and virtualization are ours to build. **Recommendation: the fallback renderer.** Keep the fold renderer-neutral |
| **AG-UI + CopilotKit** | AG-UI 1.0: a POSTed run input with an SSE event stream (text, tool calls, state snapshots and deltas, interrupts) ([spec](https://docs.ag-ui.com/llms.txt)). CopilotKit adds its own runtime server and a large React dependency tree (`lit`, `katex`, `recharts`, a `maplibre-gl` peer) | If ostra had to expose its agent stream to third-party frontends in a standard protocol, or hosted LangGraph or Python agents | It's another protocol to map ACP into, and it's run-scoped like the AI SDK's. assistant-ui can read it later (`@assistant-ui/react-ag-ui` 0.1.11) if ever needed |
| **Rivet's UI pieces** | `@sandbox-agent/react`: headless `AgentTranscript` (message, tool, reasoning, meta and permission entries, with TanStack Virtual), `ChatComposer`, a ghostty-web `ProcessTerminal`. **Gigacode** attaches OpenCode's TUI and web UI to Sandbox Agent's experimental `/opencode` API (rivet.md §8) | A quick internal viewer of raw ACP | It ties the panel to Rivet's types (ADR 0024 keeps every Rivet import in one runner package), and `rivet.md` drops Rivet from the runtime path |
| **OpenCode's web UI, or `@assistant-ui/react-opencode`** | The browser talks to an OpenCode server | A single developer on their own machine | The browser would reach into the box (ADR 0012: no inbound ports), bypassing Postgres and ADR 0011. It's OpenCode-only (adapter parity) |
| **AI SDK harnesses** (`@ai-sdk/harness-opencode`, `-claude-code`, `-codex`, `-pi`, `-acp`) | Experimental. They drive coding agents and project their events "into AI SDK stream and response types", so `useChat` can render them ([overview](https://ai-sdk.dev/docs/ai-sdk-harnesses/overview), [UI](https://ai-sdk.dev/docs/ai-sdk-harnesses/ui)) | The most AI-SDK-native option: if the maintainer wanted the AI SDK to *be* the agent interface, replacing ADR 0018 and ADR 0024 | Bridge harnesses need "a real network sandbox" with a sandbox-exposed port ([HarnessAgent](https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-agent)), which conflicts with ADR 0012's dial-out runner. "Expect breaking changes." It's still request-scoped `useChat` for the UI. Worth a line in spike 1's bake-off notes, nothing more |
| **Plain shadcn components, our own state** | No chat library | Never clearly better than the AI Elements patterns above, which are exactly that | — |

---

## Recommended architecture

*(A proposal, to settle with the maintainer under Q50 and record as an ADR if accepted.)*

```
 agent (OpenCode, opencode acp) ─ ACP v1 over stdio ─▶ runner: AgentAdapter (@agentclientprotocol/sdk 2.7)
                                                        │ 1. parse ACP; normalize tool input/output per agent (ADR 0025)
                                                        │ 2. segment text by messageId or by boundary;
                                                        │    completed segment → agent.message event
                                                        │ 3. partial text → live.text frame every ~250 ms (ephemeral, Q23)
                                                        │ 4. spool events with seq; ship over the runner protocol
                                                        ▼
                    core service: one transaction → INSERT events (task_id, seq), approval rows, queue jobs
                                  live.text → upsert task_live_text (UNLOGGED, one row per open segment)
                                  batched NOTIFY (wake-up only, live-sync.md)
                                                        ▼
                    Next.js: tRPC v11 subscription task.live({taskId, lastEventId})
                       yields tracked(String(seq), {kind: "event", …})    ← committed, resumable
                       yields {kind: "live-text", segmentId, offset, delta} ← untracked, display only
                                                        ▼
 browser: history query (whole turns) + subscription → foldTaskEvents(events, liveText) → TaskUIMessage[]
          → toThreadMessageLike → useExternalStoreRuntime → assistant-ui primitives + ostra renderers
```

**Packages** (dependencies need the maintainer's yes, AGENTS.md):
- **`ai`**, for types (`UIMessage` and the part types), plus tree-shaken helpers such as `isToolUIPart` if wanted.
- **`@assistant-ui/react`**, plus the kit components installed as source through the shadcn registry.
- **`@assistant-ui/react-markdown`** for assistant text.
- **Later, `@tanstack/react-virtual`**, if the spike shows long tasks need it.
- **Not used:** `@ai-sdk/react`, `@assistant-ui/ai-sdk` and `@assistant-ui/react-ai-sdk`, `resumable-stream`, Redis, Assistant Cloud, the `"use generative"` plugin.

**Runtime and transport:** `useExternalStoreRuntime`, fed by ostra's own tRPC v11 SSE subscription. There's one stream per task page, multiplexing committed events and live-text frames, to stay within the browser's per-origin connection limit (`live-sync.md`).

**Live text (Q23).**
- The runner sends partial text at most every 250 ms (`runner-transport.md` working value).
- The server keeps only the *latest accumulated text* per open segment, in an `UNLOGGED` table (`task_live_text`):
  - Every subscriber, on any replica, reads it through the same tailer.
  - A late joiner gets the current partial at once.
  - It writes no WAL and grows no index.
  - It's deleted when the segment's `agent.message` commits.
- The subscription sends each viewer `offset` plus `delta` frames, and a full snapshot (`offset: 0`) on (re)connect.
- The fold appends when `offset` equals its length, ignores gaps until the next snapshot, and drops live text for any segment that already has its committed message.
- **Fallback:** if the spike shows the table is too costly, carry the deltas in the batched `NOTIFY` payload instead. Either way they never enter the event log.

**The fold.**
- `foldTaskEvents(events, liveText): TaskUIMessage[]` is pure, shared, and tested on recorded ACP traces.
- One user message per `user.message`. One assistant message per turn (`turn.started` to `turn.ended`), with a `step-start` between agent steps. System messages for ostra-only events.
- It preserves object identity for unchanged messages.
- Unknown event kinds become a visible "unsupported event" row, never a silent drop (ADR 0018: agent schemas tolerate unknown events).

### The mapping

This maps ACP **v1**, which is what `opencode acp` and claude-agent-acp speak today. `@agentclientprotocol/sdk` 2.7.0 exports v1 by default and v2 under `experimental/v2`. The v1 `SessionUpdate` set in SDK 2.7.0 is `user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `available_commands_update`, `current_mode_update`, `config_option_update`, `session_info_update`, `usage_update`, `notice`, `compaction_update` and `compaction_summary_chunk` ([prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn); published `dist/v1/schema/types.gen.d.ts`). ✓ fits; ◐ fits with an ostra convention; — not a message part.

| # | ACP v1 source | ostra event (runner → Postgres) | `TaskUIMessage` (AI SDK) | assistant-ui (`ThreadMessageLike`) | Fit |
|---|---|---|---|---|---|
| 1 | Runner sends `session/prompt` for the driver's message | `user.message {memberId, clientMessageId, text, files}`, written by the **server** at send time | `role: "user"`, `text` + `file` parts, `metadata.author` | user message + `attachments` | ✓ (author in metadata only) |
| 2 | `user_message_chunk` (agent echo; `session/load` replay) | dropped, because #1 is authoritative | — | — | ✓ by design |
| 3 | `agent_message_chunk` text, optional `messageId` ("Chunks with the same `messageId` belong to the same message", [prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)) | `live.text` frames (ephemeral) → `agent.message {segmentId, text}` when the segment closes (new `messageId`, any non-text update, or turn end) | `text` part, `state: "streaming"` → `"done"` | text part; message `status: running` | ✓ (a partial is lost if the runner crashes, Q23) |
| 4 | `agent_message_chunk` image, `resource_link` or `resource` | `agent.content {block}` | `file` (image) or `source-document`; audio dropped | image or file part | ◐ |
| 5 | `agent_thought_chunk` | as #3, `agent.thought` | `reasoning` part | reasoning part | ✓ |
| 6 | `tool_call {toolCallId, title, kind, status, rawInput, locations, content}` | `tool.called {toolCallId, kind, title, input (normalized), raw (capped), locations}` | `tool-${kind}` for `read`, `edit`, `delete`, `move`, `search`, `execute`, `fetch`, `think` and `switch_mode`, state `input-available` (`input-streaming` while `rawInput` is still empty), `title`, `toolMetadata {locations, raw}`; `other` or unknown → `dynamic-tool` with `toolName` = title | `tool-call {toolName: kind, args, argsText}` | ✓ |
| 7 | `tool_call_update` `in_progress` + content | `tool.progress` (coalesced to 250 ms, durable) | `output-available`, `preliminary: true` | `result`, `isPreliminary` | ✓ |
| 8 | `tool_call_update` `completed`: content `content` (text), `diff {path, oldText, newText}`, `terminal {terminalId}`, `rawOutput` | `tool.completed {output}`, normalized per kind: edit → `files[{path, added, removed, patch (capped)}]`; execute → `{output (capped), exitCode?}` | `output-available` | `result` | ◐ large output capped (the full branch diff is the Changes tab, F-027). `terminal` content needs a client-side terminal (see [agent gaps](#agent-specific-gaps)) |
| 9 | `tool_call_update` `failed` | `tool.failed {error}` | `output-error {errorText}` | `result`, `isError` | ✓ |
| 10 | `session/request_permission {toolCall, options[{optionId, name, kind}]}` | `approval.requested {approvalId, toolCallId, options, preview}` + Approval row | the tool part goes to `approval-requested`, `approval.id`, `approval.descriptor.options` | `approval {id, options[{id, kind: allow-once…, label}]}`; message `requires-action` | ◐ the AI SDK response is a boolean; options ride in `descriptor` |
| 11 | The runner's response `{outcome: selected, optionId}` or `cancelled` | `approval.answered {decision, memberId}` / `approval.auto_answered` / `approval.closed {cancelled \| expired}` | `approval-responded` → `output-available` or `output-denied`; closed → `output-error` | `approved`, `optionId`, `resolution` | ◐ who answered, and "expired", live in metadata |
| 12 | `elicitation/create` (form `requestedSchema`, optional `toolCallId`; URL mode) | `question.asked {questionId, toolCallId?, message, schema}` | `data-question` part (no AI SDK type), or an approval on the linked tool part | `approval {display: select \| text \| questions, questions[]}` | ◐ the JSON Schema → questions converter is ours. URL mode → a link card |
| 13 | Elicitation response `accept` / `decline` / `cancel` | `question.answered` / `question.closed` | `data-question` updated (same `id`) | `approval.answers` | ◐ |
| 14 | `plan {entries[{content, priority, status}]}` (replaces the plan) | `plan.updated` | `data-plan` with a fixed `id` (reconciled) | `data-plan` part → Plan renderer | ✓ |
| 15 | `available_commands_update` | task state `agent.commands` | — | composer slash suggestions | — |
| 16 | `current_mode_update`, `config_option_update` | `session.config_changed` | task header state; `data-config-change` row | data part | ✓ |
| 17 | `session_info_update` (title; OpenCode's `_meta["opencode/retry"]`, `_meta["opencode/compaction"]`) | task state; retry → `agent.retrying` (display) | — (retry → transient status) | banner | — |
| 18 | `usage_update {used, size, cost}` | task state `usage` | `metadata.usage` on the turn | `metadata.custom`; context meter | ✓ token totals for the footer come from the model proxy (Q26), not from here |
| 19 | `notice {severity, title}` ("not part of session history") | ephemeral `notice` frame | — | sonner toast | ✓ |
| 20 | `compaction_update`, `compaction_summary_chunk` | `compaction.updated {status, summary}` | `data-compaction` | divider row | ✓ |
| 21 | `session/prompt` response `stopReason` (`end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`) | `turn.ended {stopReason}` | `metadata.finishReason`: `stop`, `length`, `other`, `content-filter`, abort | `status complete` / `incomplete {reason}` | ✓ |
| 22 | JSON-RPC error on the prompt; agent process exit | `turn.failed {error}` / `session.crashed` (ADR 0011 #5) | `data-session-status`, `metadata.error` | `incomplete {reason: error}` + a system row | ✓ |
| 23 | Subagents: OpenCode child updates with `_meta["opencode/child-session"]` and prefixed `toolCallId`s; Claude's draft `subagent_update` | `subagent.*` linked to the parent `toolCallId` | `toolMetadata.childSessionId`; children folded into their own `TaskUIMessage[]` | `ToolCallMessagePart.messages` (nested, read-only) | ◐ the AI SDK has no nesting |
| 24 | (ostra only) driver changed, runner connected or lost, session restored, PR opened | `driver.changed`, `runner.*`, `session.restored`, `pr.opened` | `role: "system"` message carrying the typed event in `metadata` | system row (our component) | ✓ |
| 25 | Steering: Claude `_session/steering` → `outcome: injected`; OpenCode → queue, or cancel and re-prompt | `user.message {delivery: steer \| queued \| after-interrupt}` | a user message marked as steered. The AI SDK's `steering-message` part is **experimental**; avoid it | user message | ◐ |
| 26 | Interrupt: `session/cancel` | `turn.cancel_requested {memberId}` → `turn.ended {cancelled}`; tools left `failed` | abort; unfinished tools → `output-error "cancelled"` | `incomplete {cancelled}` | ✓ |

**Lossless?** The event log is lossless for what it stores. That's everything except partial text (Q23) and notices, which are display-only by the protocol's own definition. The fold is a deliberate view. The doubtful rows are ◐, and each has an ostra convention that loses nothing ostra needs.

**ACP v2 is closer to this model.** It's still a draft, gated behind version negotiation ([v2 migration](https://agentclientprotocol.com/protocol/v2/migration)). claude-agent-acp already serves it experimentally.
- **What changes:**
  - Messages are upserts by `messageId` (`agent_message`, `user_message`).
  - Foreground state arrives as `state_update` (`running`, `requires_action`, `idle`, with the stop reason).
  - There's `tool_call_content_chunk`.
  - Agent-owned display terminals (`terminal_update`, `terminal_output_chunk`) give live command output.
  - `plan_update` replaces plans by `planId`.
  - Prompts carry an `idempotencyKey` and aren't rejected while work is active.
- **What it costs ostra:** a v2 driver changes only the runner's AgentAdapter. ostra's events and the fold stay the same.

### Agent-specific gaps

| | OpenCode (`opencode acp`, ACP v1) | Claude Code (`claude-agent-acp` 0.108, ACP v1) |
|---|---|---|
| Steering mid-turn | **None.** "A session runs one prompt at a time. OpenCode returns an error for a second `session/prompt` while the first is active" ([OpenCode ACP](https://opencode.ai/docs/cli/acp)). Steering means queueing until the turn ends, or cancelling and re-prompting ("It reports tool calls that don't finish after a cancel as `failed`"). The UI must say which happened. Capability `steerMidTurn: false` (ADR 0025) | `_session/steering {sessionId, prompt}`, advertised at `initialize` `_meta.steering.supported`. Outcomes: `injected`, `startedNewTurn` or `promptRequired`. "Steering is v1 only for now" ([README](https://github.com/agentclientprotocol/claude-agent-acp), [example](https://github.com/agentclientprotocol/claude-agent-acp/blob/main/examples/steering.ts)) |
| Permission options | `once` (`allow_once`), `always` (`allow_always`), `reject` (`reject_once`); no `reject_always`. A diff when it can build a preview | Permission requests with presentation extensions (opt-in AIR `_meta`). Exact options **unverified** (spike) |
| Questions | `elicitation/create` form mode, only if the client advertises `elicitation.form`. A `<key>_custom` field allows a typed answer | Elicitation listed as supported (README); details **unverified** |
| Live command output | Not documented. Output arrives with the tool update (**unverified**; the spike records it) | "Interactive (and background) terminals" use ACP *client* terminals (`terminal/create`), which the client would execute. **Recommendation: the runner doesn't advertise `terminal` or `fs`.** The agent runs as a separate OS user (Q27), and the runner must not run its commands. So command output arrives at completion in v1; ACP v2's agent-owned display terminals fix that later |
| Message boundaries | `messageId` on chunks **unverified**; segment by boundary as a fallback | **unverified** |
| Usage | `usage_update` with `cost`, "only if the prompt used tokens and OpenCode knows the model's context size" | **unverified** |
| Subagents | Child-session updates inline, IDs prefixed `<childSessionId>:` | Nested subagent transcripts (README; ACP draft `subagent_update`) |
| Running or idle state | None in v1: derive it from whether `session/prompt` is in flight. Retry status in `session_info_update._meta` | Same in v1. v2 has `state_update` |

### Driver-only sending and many viewers

- **The server owns the driver.** `task.driverMemberId` changes only through the `task.takeOver` mutation (compare-and-set). Each change is a `driver.changed` event in the task log, so history shows "Alex took over at 14:02" and every viewer converges through the same stream.
- **Per-viewer capabilities** come with the task query and update on `driver.changed`: `{canSend: isDriver, canInterrupt: isDriver, canAnswerApprovals: policy, canTakeOver: role ≥ member}`.
- **The runtime is built from those capabilities:**

```tsx
const runtime = useExternalStoreRuntime<TaskUIMessage>({
  messages,                                   // foldTaskEvents(events, liveText)
  convertMessage: toThreadMessageLike,        // ours: ~150 lines, typed
  isRunning: task.status.type === "running",
  isDisabled: !viewer.canSend,                // watchers: read-only composer
  onNew: (m) => send.mutateAsync({ taskId, text: textOf(m), clientMessageId: newClientMessageId() }),
  onCancel: () => interrupt.mutateAsync({ taskId }),
  ...(viewer.canAnswerApprovals
    ? { onRespondToToolApproval: (r) => answerApproval.mutateAsync({ taskId, approvalId: r.approvalId, decision: toDecision(r) }) }
    : {}),
});
```

- **The concept's composer.** It shows **Interrupt** and **Send** together while the agent runs. Build it from `ComposerPrimitive.Input` plus ostra's own buttons:
  - Send during a run calls `task.send`.
  - The server routes the message as a steer (Claude) or a queued message (OpenCode).
  - The queued message is shown in the thread for everyone, as an event.
  - This avoids assistant-ui's client-side `queue` adapter. Whether `onNew` fires while `isRunning` is true without that adapter is **unverified** (spike).
- **Watchers** get a "Sam Rivera is driving · Take over" bar in place of the composer.
- **The server enforces it all.** `task.send` and `task.interrupt` reject non-drivers with `FORBIDDEN`, and `approval.answer` checks the policy. The UI only hides controls.
- **Optimistic sends.** The driver's own message shows at once, keyed by `clientMessageId`, and is replaced when the committed `user.message` with the same key arrives. The fold deduplicates.
- **Fan-out** is `live-sync.md`'s design, unchanged. Every viewer's subscription reads committed rows by `seq`, plus the live-text row.

---

## What we build

1. **The ACP AgentAdapter's event mapping** (runner): ACP v1 → ostra events, per-agent input and output normalization, message segmentation, and the 250 ms partial-text coalescer. Spool and ack stay as in `runner-transport.md`.
2. **ostra's event and stream-frame Zod unions**, shared by the runner, the server and the panel (ADR 0018), with exhaustive switches.
3. **The live-text channel:** the `UNLOGGED` `task_live_text` table (raw SQL in a migration, since Prisma doesn't declare `UNLOGGED`; **to verify**), and its snapshot-then-delta frames in the subscription.
4. **`task.live` (subscription), `task.history` (paged by turn), and the mutations** `task.send`, `task.interrupt`, `task.takeOver` and `approval.answer`, plus `question.answer` later. Each one authorizes, uses compare-and-set where two members can race, and enqueues its runner command durably.
5. **`foldTaskEvents`**, pure and shared, with structural sharing. Golden tests on recorded ACP traces.
6. **`toThreadMessageLike`** (`TaskUIMessage` → assistant-ui). assistant-ui's own `UIMessage` converter is internal: `@assistant-ui/ai-sdk` doesn't export `converters/convertMessage` from its root.
7. **Renderers** in ostra's brand: the read row, the edit row with diff, the command row with output, the approval card with three options and a receipt, the question card, the plan, and system rows. Render-only `"use client"` toolkit entries keyed by ACP kind.
8. **The task-page composer:** driver gating, Interrupt plus Send, a queued or steered indicator, and Take over.
9. **The approval policy and the "approve for this task" rule store**, used by the runner to auto-answer.
10. **Markdown hardening:** `react-markdown` with no raw HTML, safe links, plain-text command output. Agent output is untrusted (AGENTS.md).

## Spike plan

**`spikes/agent-ui-stream/`.** The question: *can a task page built on AI SDK `UIMessage` types and assistant-ui's `useExternalStoreRuntime` render a real OpenCode session from ostra's own event stream, live, in two browsers, with driver-only sending and one approval?* A proposed addition to milestone 0, beside the live-event-stream spike in `live-sync.md`. Time box: **4 days.**

**Setup:**
- OpenCode 2.3.2 (`opencode acp`), driven by a throwaway Node runner on `@agentclientprotocol/sdk` 2.7.0, against a test repo in the ostra GitHub org.
- The runner advertises `elicitation.form`, but not `fs` or `terminal`.
- OpenCode's permissions are set to `ask` for shell.
- Postgres 18, Next.js 16.4.6, tRPC 11.29.4, `@assistant-ui/react` 0.15.37 (pinned exactly), and `ai` 7.0.176 (types).
- It can reuse spike 1's runner if that exists. Otherwise it starts from recorded traces, so it isn't blocked.

**Steps:**
1. **Record.** Save raw ACP traces (JSON lines, no secrets) of sessions that produce text, reasoning, read, edit (with diff), execute (with output), a plan, a permission request, a question, a driver message mid-turn, and an interrupt. Repeat one trace with claude-agent-acp to see the gaps, including whether `_session/steering` returns `injected`.
2. **Map and fold.** Build the runner mapping, the segmenter and the fold, plus Vitest golden tests on the traces. Log each ACP field that has nowhere to go.
3. **Stream.** Build `task.live` (tracked events plus untracked live-text frames; verify that `httpSubscriptionLink` keeps `lastEventId` across untracked frames), `task.history`, and the `task_live_text` table.
4. **UI.** Build one task page matching `02-task-v2.png`: the thread, the four renderers, the approval card, the composer, and Take over.
5. **Two browsers.** Members A (the driver) and B (a watcher), on plain `http://`. Check:
   - **Latency:** runner → both browsers, p50 and p95 for live text and for committed events.
   - **Reload:** B reloads mid-message, and the partial reappears within 1 s, with no duplicates.
   - **Network drop:** B's network drops for 10 s mid-turn, and resume shows no gaps or duplicates (assert `seq`).
   - **Send gating:** B can't send. The UI hides the control, and a direct tRPC call is rejected.
   - **Approval:** A approves once, and B sees the receipt. Both click at once: one wins, and the other's control comes back with an error.
   - **Take over:** B takes over, and A becomes a watcher.
   - **Mid-turn on OpenCode:** a message sent mid-turn shows as queued; "Interrupt and send" re-prompts.
6. **Long task.** Replay a synthetic 5,000-event task. Measure fold time, first render, memory and typing latency, with and without TanStack Virtual (ask before adding it).
7. **Strict typing and policy.**
   - `tsc` strict and `eslint` strict-type-checked over the spike. Count the `any` leaks and `no-deprecated` hits from assistant-ui.
   - Capture the network log to confirm that no request goes to `assistant-api.com` or `assistant-ui.com` (ADR 0021).
   - Run axe over the page.

**Pass** *(working values)*:
- **Coverage:** every event kind in the traces renders, and nothing is dropped silently.
- **Latency:** p95 under 500 ms from runner to browser, for two viewers.
- **Resume:** a reload restores the partial within 1 s, and there are zero gaps or duplicates across steps 5 and 6.
- **Approvals:** the round trip and the race both behave.
- **Driver gating:** a non-driver can't send.
- **Long task:** 5,000 events render in under 1.5 s on a mid-range laptop.
- **Strict typing:** clean, with only documented suppressions.

**Fail:**
- **If assistant-ui fails:** keep the fold and `TaskUIMessage`, and swap the renderer for the shadcn/ui AI Elements patterns.
- **If live text fails:** try the `NOTIFY`-payload variant.
- **Either way:** bring the findings to the maintainer.

---

## Conflicts with ADR 0011, Q23 and `live-sync.md`, and how to resolve them

- **Q23 is still open.** `open-questions.md` lists it in round 7 as a recommendation awaiting the maintainer. This design assumes the recommendation (deltas display only; completed messages and everything acted on are saved). **The UI is the same either way.** If the maintainer chooses to save deltas, live-text frames become committed `agent.message_delta` events, and the fold appends them.
- **`live-sync.md` saves deltas.** Its diagram merges "token deltas per task into ~100 ms windows" and saves them, and its rule says "nothing reaches the browser that isn't stored".
  - **Resolution:** replace its step 2 with "segment the text; coalesce partials every 250 ms into `task_live_text`; save completed segments as events".
  - Partials are then still rows read from Postgres, so the letter of the rule holds.
  - Reword the rule as: "the browser treats only committed events as history; partial text is marked ephemeral and replaced by its committed message".
  - Use 250 ms (`runner-transport.md`), not 100 ms.
- **`live-sync.md`'s connection budget.** A task page uses one stream that multiplexes events and live text. Home's team stream is a second one. Keep it at most two per tab (the HTTP/1.1 limit).
- **ADR 0011 ("saved before acted on").** No control acts on an ephemeral frame:
  - Approvals and questions render only from committed events.
  - An answer is committed, with its runner command queued durably, before anything reaches the agent.
  - Partial text lost in a runner crash is display-only, and the completed message is what's saved (consistent with Q23 and ADR 0011 #5).
- **ADR 0018 and ADR 0024.**
  - AI SDK types are a **view model only**. They never cross the runner protocol and are never stored. Otherwise a major every ~6 months would force data migrations.
  - The panel imports no ACP or Rivet types. It sees only ostra's events.
- **ADR 0025 (adapter parity).**
  - Renderers key on ACP `kind` and on normalized inputs from each AgentAdapter.
  - The adapters declare `steerMidTurn`, `questions`, `subagents` and `liveCommandOutput`, so the UI shows "queued" in place of "steered" and hides what an agent lacks.
- **ADR 0017.** The AI SDK's resumable streams need Redis. That path is avoided.
- **ADR 0021.** `@assistant-ui/react` bundles the `assistant-cloud` client, with endpoints `backend.assistant-api.com` and `cloud.assistant-ui.com` (published 0.15.37 and `assistant-cloud` 0.2.13). By the code, it's used only by cloud runtimes and cloud renderers (**to verify** with a network log in the spike).
- **ADR 0007.** `ai` and `@assistant-ui/react` are new dependencies, and need the maintainer's yes.

## Risks

1. **assistant-ui churn** (pre-1.0; deprecations with under a month's notice; 0.16 pending).
   - Pin the exact version.
   - Use only `useExternalStoreRuntime`, primitives and render-only toolkit entries, inside one `task-thread` package.
   - Avoid `unstable_` APIs.
   - Keep the fold renderer-neutral, so the shadcn AI Elements fallback stays one swap away.
2. **AI SDK velocity** (about 69 releases a month; majors about every six months). Use it only through `import type`, never store it, and pin it.
3. **Expectation mismatch.** The maintainer asked for the AI SDK "for the live typing". In this design the AI SDK gives the message format and ostra builds the live path. Settle this explicitly under Q50.
4. **Fan-out of live text** from the core service to Next.js (ADR 0016: two processes even on one machine). The spike measures the `UNLOGGED` table against `NOTIFY` payloads.
5. **Long tasks.** Folding thousands of events on every page load. If it's slow: page history by turn, cache a server-side snapshot per finished turn, and virtualize rows.
6. **Approvals that outlive the agent's request** (runner restart, box released under Q37, long waits). Use `approval.closed` with `expired`, and re-prompt with the decision (`rivet.md` §4).
7. **OpenCode can't steer.** Tell the driver plainly ("queued until the turn ends" or "Interrupt and send"). Don't fake steering.
8. **`any` from assistant-ui's types.** Renderers read typed parts from ostra's store, never from the props assistant-ui passes.
9. **Untrusted content.** Agent text, diffs and command output are untrusted. Use markdown without raw HTML, never `dangerouslySetInnerHTML`, and render ANSI as text or through a vetted renderer (that's a dependency question).
10. **ACP v2.** It reshapes messages and state. The runner's AgentAdapter absorbs it, and the fold and UI don't change.

## Unverified

- Whether `opencode acp` and claude-agent-acp send `messageId` on chunks, stream command output before completion without client terminals, and send `usage_update`.
- claude-agent-acp's permission options and its elicitation details.
- Whether `_session/steering` behaves as its example describes against a real model.
- Whether `httpSubscriptionLink` keeps `lastEventId` when untracked frames are interleaved with `tracked()` ones, and how tRPC types a mixed yield.
- Whether assistant-ui's `onNew` fires while `isRunning` is true with no `queue` adapter.
- That `@assistant-ui/react` makes no network calls without cloud configuration (inferred from the code).
- assistant-ui's accessibility beyond its documented primitives (no audit found).
- Prisma 7 with an `UNLOGGED` table created in a raw migration.

## Questions for the maintainer (candidates for Q50)

1. **The AI SDK's role:** the message format and types only, not `useChat` or its transport? (Recommended: yes.)
2. **The runtime:** assistant-ui's `useExternalStoreRuntime`, with shadcn/ui AI Elements as the fallback renderer? (Recommended: yes.)
3. **Who may answer an approval?** The driver only, any member, or by role? F-026 says "a member approves or denies it". (Recommended: any member with the member role; viewers can't.)
4. **"Approve for this task":** an ostra-owned rule scoped to the task, while the agent is always answered `allow_once`? (Recommended: yes.)
5. **A driver's message mid-turn on OpenCode:** queue it by default, with "Interrupt and send" as an explicit choice? (Recommended: yes.)
6. **Dependencies:** `ai`, `@assistant-ui/react` and `@assistant-ui/react-markdown` now; `@tanstack/react-virtual` only if the spike needs it.
