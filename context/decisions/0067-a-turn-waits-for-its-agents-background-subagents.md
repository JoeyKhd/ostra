# A turn waits for its agent's background subagents

**Status:** accepted (2026-11-20). The maintainer approved the fix ("yes") after `research/opencode-subagents.md`. Amends ADR 0018 (a new optional agent capability, `subagents`) and ADR 0032 (what ends an OpenCode turn, and what a cancel reaches). Comes before F-138's subagent window (milestone 7, ticket 39), which builds on it. Covers F-023, F-025 and F-138's "a task doesn't end while one still runs".

## Why

OpenCode 2.3.2 runs every subagent in the background. Its `subagent` call ends at once, the agent is told to end its turn, and each subagent's report wakes the agent later, with no prompt in flight. With a real model, `session/prompt` was answered `end_turn` 4.2 s in, and the agent gave its real answer 12 s in (research, summary items 2 and 3, run H). Without OpenCode's client capability `opencode/child-session-updates`, a subagent's updates also stop once the turn that started it ends.

So, before this decision:
- a one-shot task ended the agent right after the prompt answered, killing any running subagent and losing the real answer;
- a session across turns filed the wake-up's output under a turn that had already ended.

## The turn

**A turn ends only when all of these hold:**
1. its prompt has been answered;
2. no subagent of the session is `created` or `running`;
3. the agent was seen at work after the last subagent ended, and is idle again.

Everything the agent and its subagents say until then belongs to that turn. The runner neither ends the agent nor moves the task to its end state before it. That holds for one-shot tasks and for sessions across turns alike, on every executor, because the driver runs in the runner process or in the box's sidecar, which reads the same setting.

**How ostra knows.** The driver sends `_meta["opencode/child-session-updates"]: true` at `initialize`. OpenCode then sends each child session's updates and states (`created`, `running`, `completed`, `failed`, `interrupted`) as `opencode/session/child_update`, past the prompt's answer too. The updates are mapped as before: flat, the child's tool call IDs prefixed with its session. F-138 gives them their own tree.

**Whether the agent is idle, ACP doesn't say.** OpenCode sends nothing when a wake-up run ends. The driver asks with `_session/steering`, OpenCode's steering extension, and a prompt OpenCode refuses before it reaches the session: an image block with neither data nor URI.
- OpenCode checks for a running turn first (`ACPTurn.steer`), so an idle session answers `promptRequired`.
- A busy one refuses the prompt in `ACPPrompt.prepare` (`-32602`, `data.field: "prompt"`).
- Nothing is ever injected.

The probe runs only once no subagent runs, every second. The agent counts as "seen at work" when it sent an update of its own, or the probe found it busy, after the last subagent ended. If neither happens within 10 s, the report counts as already read in the turn: the wake is local work, no model call.

**Without both extensions** (the client capability and steering advertised), a turn ends with its prompt's answer, as before.

**The bound.** `OSTRA_RUNNER_SUBAGENT_WAIT_MINUTES`, default 30, is how long a turn waits after its prompt's answer. Past it:
- the driver stops the subagents still running and ends the turn;
- each one's starting call gets a `tool.failed` that says so, the clear event a member sees;
- the runner logs the bound and the count, with the task's IDs, never what a subagent was asked.

The wait counts inside the task's turn limit, which still cancels the turn first if it's shorter.

**A member's "Send" during the wait.** When the agent idles waiting on a subagent, OpenCode has no turn to steer. The driver sends the message as the turn's next `session/prompt`, inside the same turn, instead of refusing it.

**An agent's own cancel (a deny) doesn't wait.** The runner's re-prompt starts the next turn, which inherits the running subagents (OpenCode carries them into the next prompt's state), and that turn waits for them.

## Cancel

`session/cancel` reaches only the prompt in flight (OpenCode's `ACPTurn.cancel` removes the turn's fiber). It reaches no subagent, and no wake-up run after the answer. Interrupting the parent doesn't interrupt its children either: core interrupts children only when a session is deleted (`Session.remove`). So a stop, an interrupt, or a member's "interrupt and send" does three things, all within the cancel's 5 s budget (F-023):
1. sends `session/close` for each running child session, which interrupts that subagent and nothing else (OpenCode's `ACPTurn.close` on a session with no prompt in flight);
2. once the prompt is answered, sends `session/close` for the session itself, which interrupts a wake-up run and ends OpenCode's follower of the session, so nothing more is sent;
3. sends `session/resume` to attach the session again for its next turn.

Past the budget, the agent's process tree is ended, as for a cancel the agent never answers.

## The capability

`AgentCapabilities.subagents` (ADR 0025 parity):
- `background`: the agent's subagents outlive its prompt and it reports their states. OpenCode, and the `rich` fake.
- `none`: a turn ends with its prompt's answer. The `plain` fakes and the tiny agents.

The agent contract suite runs both ways, and the parity table names the case for each adapter:
- "a subagent that outlives its agent's prompt holds the turn …"
- "an agent without background subagents ends its turn with its prompt's answer"
- "a cancel while a subagent runs stops it with the turn …"

## Since F-138 (2026-11-20, milestone 7's ticket 39)

The subagents' updates are no longer mapped flat. Protocol minor 6 carries a subagent's start and states (`subagent.started`, `subagent.status`) and names the subagent on the agent's output and its approvals; the driver reads them from the same child-session notices this decision asked for, and reports `interrupted` itself for the subagents it stops on a cancel or past the wait's bound. An adapter with `subagents: "none"` names no subagent, and a minor-5 server gets none of it: either way the calls show flat, as before (`research/opencode-subagents.md`, section 6).

## What it costs

- A turn with subagents ends later: at the agent's real answer.
- The probe depends on OpenCode's order of checks in `ACPTurn.steer` and `ACPPrompt.prepare`. The suite runs on the pinned binary, so a bump that changes it fails the case.
- A background shell (OpenCode's other "pending" work) isn't reported over ACP, so a turn doesn't wait for one. The research lists it.
- After a cancel, a subagent's `interrupted` report can still wake the agent once OpenCode no longer follows the session. That run's words never reach ostra, and its model calls are still counted at the key proxy.
