# 39: Subagents on the task page: the badge and the tree

Status: ready-for-agent
Builder: full stack
Blocked by: the subagent turn fix (a turn doesn't end while its subagents run; `explore` stays read-only), on main before this starts
Features: F-138 (F-023 note)
Packages: `packages/protocol`, `packages/adapter-sdk`, `packages/adapters/adapter-opencode`, `apps/runner`, `apps/core` (ingest and the task view's fold), `packages/api`, `apps/web` (`components/tasks/`)
Spec: targets `../../../brand/app-targets/m7/task-subagents-badge` and `task-subagents-tree` (`task-subagents-tree.md`), approved by the maintainer on 2026-11-20 ("Yes"); the data in `../../../research/opencode-subagents.md` and `packages/adapters/adapter-opencode/evidence/opencode-subagents-acp.txt`

## Why

The maintainer, 2026-11-20: "just a badge in the conversation that shows the amount of agents and then you can click on it and see a modal and see the parent of each subagent". OpenCode starts subagents with its `subagent` tool; today their calls show flat in the thread, as the main agent's.

## What to build

- **The protocol:** a new minor after the newest on main. Events `subagent.started` (the starting call's ID, the subagent's ID, its parent, depth, type, description and prompt) and `subagent.status` (`created`, `running`, `completed`, `failed` with its error, `interrupted`), and a subagent ID on `tool.called`, `agent.message`, `agent.thought` and `plan.updated`. Permission requests carry the subagent too. Keep ADR 0034's one-minor window: an older runner sends no subagent fields, and the page shows its calls flat.
- **The adapter:** a `subagents` capability on the agent interface (ADR 0025); OpenCode declares it. The driver maps `_meta["opencode/child-session"]`, the prefixed tool call IDs and `opencode/session/child_update` onto the events above, joining a child to its starting call through `rawOutput.metadata.sessionID`. Each child's answer is its own message, never the main agent's. The scripted fakes cover an agent with subagents and one without.
- **Core and the API:** the per-turn tree, rebuilt from the task's events, so a reload or a second tab shows the same.
- **The page:** the badge on the agent's turn (`{n} subagents`, with how many run, need approval or failed) and the window with the tree, 1:1 with the approved targets and their spec: every state, the keyboard, phone width. A subagent's call that needs approval asks in the thread like any other and names the subagent.
- **Not in this ticket:** tokens and spend per subagent. They need an ADR on attributing calls at the key proxy first; until then the nodes show no tokens line (the spec says so) and the task's spend already counts every call (proved in F-089, F-084, F-037).

## Done when

- [ ] Tests named for `F-138`: OpenCode's real child-session updates (the recorded log, and a run against the stub model) become the tree with its parents, types, prompts, states, calls and answers; a nested subagent sits under its parent; an agent without the capability shows flat calls; a reload rebuilds the same tree; an approval inside a subagent names it.
- [ ] Playwright, desktop and phone: the badge, the window, a selected node, a running and a failed subagent, and the keyboard path; screenshots compared with the targets.
- [ ] Break-its for each, then restored; proof rows in `context/proof/F-138.md`; `pnpm check:proof` passes.
- [ ] Typecheck, lint and tests of every touched package and its consumers pass.

## Comments

- 2026-11-20: opened after the maintainer approved the targets and the subagent turn fix.
