# OpenCode's subagents over ACP, and what ostra keeps of them

**Question.** The maintainer, 2026-11-20, wants a task to show its agent's subagents: "just a badge in the conversation that shows the amount of agents and then you can click on it and see a modal and see the parent of each subagent". Before a screen is drawn: what does OpenCode 2.3.2 send over ACP for a subagent (its session, its parent call, its type and prompt, its calls, its answer, its times, its usage, how deep it nests)? Does ostra count a subagent's spend? And what does ostra keep of a subagent today?

**Checked:** 2026-11-20, against the pinned binary run for real and against OpenCode's source at the same tag. Every claim cites a source key from the list below; a claim no source settles is marked **inferred** or **unverified**.

**How it was run.** A throwaway probe (a vitest file in `packages/adapters/adapter-opencode`, deleted after the run) launched the pinned `@opencode/cli` 2.3.2 with ostra's own per-task files (`OpenCodeAdapter.prepareLaunch`) and spoke ACP to it with a raw JSON-RPC client that recorded every message. Runs A to G and I used the stub model of `@ostra/adapter-sdk/testing`, scripted per session; run H used the development endpoint of `model.env`, through a stand-in for the key proxy. Run G drove the same scenario through ostra's real `OpenCodeAdapter` and kept the `TaskEvent`s it emits. Windows 11, Node 24. The cleaned log is [EV]; each run is cited as `[EV A]` and so on.

**How it was read.** OpenCode's repo at the tag `v2.3.2`, commit `c0ad18b`, the one `context/research/opencode-reasoning-effort.md` read, cloned into a scratch folder and read, never built.

## Summary

1. **A subagent is a tool call of the main agent, and its work arrives on the main agent's session.** The model calls OpenCode's `subagent` tool with `agent` (the type: `general` or `explore` under ostra's config), `description` (a 3 to 5 word label) and `prompt` ([OC] `core/src/tool/plugin/subagent.ts:31-45`; [EV A]). The call ends at once with the child's session ID in `rawOutput.metadata.sessionID` and `status: "running"` ([EV A]; [OC] `subagent.ts:19,217`). The child's own tool calls, thoughts and text then come as `session/update`s on the main session, each with `_meta["opencode/child-session"] = {id, parentID, depth, title}`, where `title` is the description; a child's tool call ID is `<childSessionId>:<its own ID>` and its title is prefixed `<description>: ` ([OC] `cli/src/acp/child.ts:49-66`; [EV A]).
2. **Subagents always run in the background, and the main agent is told to end its turn.** The tool's own description: "Subagents always run in the background ... Keep working on non-overlapping tasks, or briefly tell the user what you launched and end your response" ([OC] `subagent.ts:52-54`). The real model did exactly that: it started both subagents and `session/prompt` was answered `end_turn` 4.2 s in, while both still worked; the main agent then woke twice, with no prompt in flight, and gave its real answer 12 s in ([EV H]).
3. **Without a client capability, a subagent's updates stop when the turn that started it ends.** OpenCode projects a child's updates onto the main session only while `ctx.start` is the turn that started it ([OC] `cli/src/acp/translate.ts:150-152,452-456`). After the answer, a background follower keeps reading, with no start ([OC] `cli/src/acp/turn.ts:324-350`): the child's later calls and its answer are never sent, while the main agent's wake-up turns are sent as plain `session/update`s ([EV C], [EV H]). ostra's driver advertises no such capability ([OS] `packages/adapter-sdk/src/agent/acp/driver.ts:431-440`).
4. **With `_meta["opencode/child-session-updates"]: true` in the client's capabilities, OpenCode sends everything, with a lifecycle.** OpenCode advertises the extension at `initialize` ([OC] `cli/src/acp/service.ts:140`; [EV A]). A client that sends it back gets each child's updates as the notification `opencode/session/child_update`, `{rootSessionId, childSessionId, parentSessionId, depth, title, type: "update", update}`, plus `type: "status"` notices: `created`, `running`, `completed`, `failed` (with `error`) and `interrupted` ([OC] `child.ts:3-36`; `translate.ts:217-280`). They keep coming after the turn ends ([EV D]). This is the only source of a subagent's start, end and outcome: ACP updates carry no time, so without it a subagent's duration can only be read from arrival times **(inferred)**.
5. **No usage per subagent crosses ACP.** OpenCode adds a step's tokens only for the main session ([OC] `translate.ts:243-245,483`); the prompt's `usage` and the `usage_update` (with `cost`) are the main session's alone ([OC] `turn.ts:366-385`). In run H the endpoint's own figures were $0.005239 for the main agent and $0.008578 for the subagents, while OpenCode's `usage_update` said $0.00444856 ([EV H]).
6. **ostra counts a subagent's spend.** A subagent runs in the same OpenCode process, and its model is `override ?? agent.model ?? parent.model`, where an override must be one of the available models ([OC] `subagent.ts:70-100,171`). ostra's config names one provider, the key proxy, so every call of every session goes through it ([OS] `packages/adapters/adapter-opencode/src/config.ts:131-170`). The proxy meters each HTTP call, whoever made it ([OS] `apps/runner/src/sidecar/key-proxy.ts:288-316`), and ingest gives a call after the turn to the session's latest turn, the task, the session and the project's day ([OS] `packages/domain/src/use-cases/ingest-events.ts:259-330`). Two tests now prove it with break-its (F-089, F-084, F-037): `apps/runner/src/task-host/task-host.opencode.test.ts` ("a subagent's model calls go through the key proxy, and each one is counted", real OpenCode) and `apps/core/src/ingest/usage.test.ts` ("a call that ends after its turn ... counts to the task, its session, that turn and the project's day").
7. **Nesting stops at one level under ostra's config.** `experimental.subagent_depth` defaults to 1 ([OC] `core/src/session/subagent-depth.ts:14`), so a subagent's own `subagent` call fails "Subagent depth limit reached (1)" ([EV E]). With it at 2, a grandchild reports `depth: 2` and `parentID` the middle child; its call IDs carry only its own session ID ([EV F]; [OC] `translate.ts:217-235`).
8. **A subagent's approvals reach ostra.** A child's `session/request_permission` comes on the main session, with the prefixed tool call ID and `toolCall._meta["opencode/child-session"]`; its title isn't prefixed ([EV I]; [OC] `cli/src/acp/permission.ts:55-68`). ostra's driver keeps neither the `_meta` nor a parent ([OS] `driver.ts:355-372`), so its approval card can't say which subagent asks.
9. **ostra keeps a subagent's work, flattened, and shows its answer as the main agent's.** Run G: the `subagent` calls become `tool.called` with kind `think` and their `{agent, description, prompt}` input, and `tool.completed` with the child's session ID; the child's calls become top-level `tool.called`s with prefixed IDs; and each child's answer becomes an ordinary `agent.message` of the turn ("child answer: the README says hello"), indistinguishable from the main agent's text ([EV G]; [OS] `packages/adapter-sdk/src/agent/acp/map.ts:354-449`). Nothing stores a parent link, a status or a time of a subagent.

## Sources

| Key | Source |
|---|---|
| [OC] | OpenCode at tag `v2.3.2`, commit `c0ad18b402eb2827fc1ee71c171b1177b3fc02d1`, `https://github.com/anomalyco/opencode`. Paths are under `packages/` |
| [EV] | `packages/adapters/adapter-opencode/evidence/opencode-subagents-acp.txt`: the probe's runs A to I, cleaned of paths and of the development endpoint's address, key and model ID |
| [OS] | ostra at the commit that adds this file |

## 1. What arrives, field by field

| What the screen wants | Without the capability (ostra today) | With `opencode/child-session-updates` |
|---|---|---|
| The child's session ID | `_meta["opencode/child-session"].id`, and the prefix of its call IDs; the main agent's `subagent` call's `rawOutput.metadata.sessionID` ([EV A]) | `childSessionId` on every notice ([EV B]) |
| Its parent | `parentID`: the main session, or the middle child at depth 2 ([EV F]) | `parentSessionId` ([EV F]) |
| The call that started it | The `subagent` call whose `rawOutput.metadata.sessionID` is the child's ID ([EV A]). No field on the child names the call **(the join is ostra's)** | The same join |
| Its type | `rawInput.agent` of that call: `general`, `explore` ([EV A], [EV H]) | The same |
| What it was asked | `rawInput.description` (also the child's `title`) and `rawInput.prompt` ([EV A]) | The same |
| Its calls | `tool_call` and `tool_call_update` with prefixed IDs, kinds as the main agent's ([EV A]) | Inside `type: "update"` ([EV B]) |
| Its answer | `agent_message_chunk`s with the child's `_meta` ([EV A]) | Inside `type: "update"` ([EV B]) |
| Its state | None: inferred from the last update | `created`, `running`, `completed`, `failed` with `error`, `interrupted` ([OC] `child.ts:13-17`; [EV B], [EV D]) |
| Its start and end | Arrival times only | The `created` and `completed` notices' arrival ([EV B]) |
| Updates after the turn ended | Dropped ([EV C], [EV H]) | Sent ([EV D]) |
| Its tokens and cost | None ([OC] `translate.ts:243-245`) | None |
| Its approvals | `session/request_permission` on the main session, prefixed ID, `toolCall._meta` ([EV I]) | The same ([OC] `translate.ts:105-112`) |
| Depth | `depth`, 1 under ostra's config ([EV E]) | The same |

A subagent can run more than once: the main agent may call `subagent` again with the child's `sessionID` to send it a follow-up, which "joins its current run" or starts a new one ([OC] `subagent.ts:41-45,140-160`). So a subagent node can have several rounds, each ending `completed` **(inferred from the source; not run)**.

## 2. The turn doesn't end when the agent does

OpenCode answers `session/prompt` when the main session's own run ends, and keeps the turn's children and background shells "pending" ([OC] `translate.ts:145-148`; `turn.ts:324-350`). When a child goes idle, OpenCode wakes the main session with a `<subagent sessionID=... state="completed" description=...>` message holding the child's answer, which starts a new run of the main agent with no prompt in flight ([OC] `core/src/session/subagent-completion.ts:77`; [EV C], [EV H]).

For ostra this means:
- **A one-shot task** (a spec below minor 1) ends the agent right after the prompt is answered ([OS] `apps/runner/src/task-host/task-run.ts:2056-2080`): a subagent still working is killed with the box, and the main agent's real answer, given when the subagent reports back, never comes. In run H that answer came 8 s after the prompt was answered ([EV H]).
- **A session across turns** keeps the agent, so the wake-up runs happen, but their updates reach the adapter with no turn running. The adapter maps them under the last turn's ID, after its `turn.ended` ([OS] `packages/adapter-sdk/src/agent/base.ts:547-560`, where `#turns` keeps the last turn's ID).
- **Spend** is counted either way, for every call made before the agent ends (summary item 6). A call cut off when the agent is killed is counted as an estimate when its answer had begun, and not counted when it hadn't ([OS] `key-proxy.ts:419-445`); a background subagent makes that cut likelier. **Unverified:** whether a provider bills a request cut before its answer begins.

## 3. Tools a subagent gets under ostra's config

OpenCode's built-in `general` agent denies `question` and `subagent`, and `explore` denies everything but reading, searching, the shell and the web ([OC] `core/src/plugin/agent.ts:63-93`). ostra's config starts with `allow *` ([OS] `config.ts`, `permissionRules`), and OpenCode pushes the config's permissions onto every agent after the built-in ones, so the last match, ostra's, wins ([OC] `core/src/config/plugin/agent.ts:65-73`). In every probe run each subagent was offered the main agent's 13 tools, `subagent` and `question` included, `explore` too ([EV A] to [EV I], "tools offered per call"). So under ostra an `explore` subagent can edit, and a subagent can ask the member a question **(inferred for the question: not run)**. ostra's own `ask` rules still reach a subagent's calls ([EV I]). The plan agent's denies are written under `agents.plan`, so they come after and still hold (`packages/adapters/adapter-opencode/README.md`, "Plan first").

## 4. What the subagent screen needs that ostra lacks

1. **The driver:** advertise `_meta["opencode/child-session-updates"]: true` (from the adapter, as OpenCode's own extension) and read `opencode/session/child_update` beside `session/update` ([OS] `driver.ts:325-345` takes only `session/update` off the wire).
2. **The events:** a subagent's start (`toolCallId` of the call that started it, child session, parent, depth, type, description, prompt), its status changes with times, and a parent on `tool.called`, `agent.message` and `agent.thought`. Minor 6's `parentToolCallId` (`context/specs/m7-launch/issues/01-protocol-minor-6.md`, postponed with F-018) covers the parent; the start and the statuses are new. Either way it's a new protocol minor, since the event shapes cross the runner protocol (ADR 0018).
3. **The turn:** a decision on what ends a turn when a subagent outlives the prompt (section 2). Without one, the screen can show a subagent `running` under a turn ostra already called ended, and a one-shot task kills it.
4. **Tokens per subagent:** nothing in ACP gives them (section 1). The key proxy sees every call but not whose it is. **Inferred:** a subagent's every call opens with the message `You are a subagent spawned by another session.` followed by its prompt ([OC] `subagent.ts:199`), so the runner could tell its calls apart in memory by that opening, joined to the `subagent` call's prompt, without logging it. An ADR decides it.
5. **Approvals:** the driver's `PermissionRequest` gains the child's session from `toolCall._meta`, so the card names the subagent that asks.

## Unverified

- Whether a subagent's question (`question` tool, an elicitation) reaches ostra as it does from the main agent.
- A subagent's follow-up rounds (`subagent` called again with its `sessionID`).
- `failed` and `interrupted` notices: not produced in a run.
- Whether `session/cancel` interrupts a background subagent, or only the main session ([OC] `turn.ts`, `windDown`, interrupts the main session only).
