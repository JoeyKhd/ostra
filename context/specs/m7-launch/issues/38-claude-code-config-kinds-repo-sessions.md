# 38: Claude Code adapter: its config files, the task kinds, the repo's config and sessions

Status: wontfix
Note: Won't do now (2026-11-19): Claude Code (F-018) moved after v1 (the maintainer: "perhaps we can just skip Claude Code with its ACP for now"), and milestone 7 is the launch alone, on OpenCode. This ticket waits for F-018 after v1; its text stays as written for then (ADR 0062, postponed).
Builder: adapters
Blocked by: 06
Features: F-018, F-021, F-026, F-099, F-100 (their Claude Code halves)
Packages: `packages/adapters/adapter-claude-code`, `apps/runner` (the restore of a hidden repo config path, `src/task-host/`)
Spec: `../spec.md`, sections 4 and 6; ADR 0062; ADR 0049; `context/research/claude-code-acp.md`, section 6
Note: split out of ticket 06 by the spec's review, which also found the frontmatter, "always allow", read-only kind and subagent-plan gaps this ticket closes.

## What to build

- **The files in `<agentDir>/claude/`** (`CLAUDE_CONFIG_DIR`): `CLAUDE.md` (the profile's instructions and the memory block), `skills/<name>/SKILL.md`, and `settings.json`:
  - the profile's approval rules as `ask` rules, the mapped deny list (ADR 0049), the MCP servers in their transports;
  - **hardening, always:** `disableAllHooks: true`, `disableSkillShellExecution: true` and `permissions.disableBypassPermissionsMode: "disable"`. The repo's `.claude/agents/`, `.claude/skills/` and `.claude/commands/` stay visible as the repo's instructions (ADR 0062), but their frontmatter can declare `hooks`, inline shell, `mcpServers`, `permissionMode` and `allowed-tools` (research, D8), and these keys turn off what could run;
  - **the task kinds** (milestone 6's ticket 09 did this for OpenCode): for a review task, and for a refine task whose profile doesn't allow prototyping, `deny` rules for Claude Code's editing tools (`Edit`, `Write`, `NotebookEdit`); the shell allowed (the box contains it, ADR 0031); and the ostra MCP tools a kind doesn't get denied by name (`mcp__ostra__submit_review`, `mcp__ostra__submit_draft`, `mcp__ostra__propose_environment`), since Claude Code's MCP config has no per-tool list.
- **`repoConfigPaths`:** `.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json`; and `.claude/agents/` as well if the frontmatter case (ticket 03) shows a repo agent's `mcpServers` or `permissionMode` still wins over the user settings. The result goes under `## Comments` and into ADR 0062.
- **"Allow for this task":** ostra answers it with Claude Code's `allow_always` option (`packages/adapter-sdk/src/agent/acp/map.ts`), whose effect is a rule written to the repo's `.claude/settings.local.json` (research, P18). The rule lasts the session, which is what ostra means by it. So the runner's restore of `repoConfigPaths` puts back the original file, or deletes one that didn't exist before the task, before every commit and push, and the commit filter refuses those paths if they're ever staged.
- **`parentToolCallIdOf`:** reads `_meta.claudeCode.parentToolUseId` from a tool call, a message chunk and a thought chunk, and the `<call>` of a plan whose `planId` is `plan:<call>`. That plan is the subagent's checklist: it maps to `plan.updated` with its parent and never replaces the task's plan (research, section 6).
- **Plans:** ostra's driver advertises `plan`, so Claude Code sends its checklist as `plan_update` with `planId` `plan` (the task's plan), and an approved plan-mode plan as a `markdown` `plan_update` with `planId` `plan-mode` (research, P16). The shared mapping (ticket 02) reads both. The plan-mode one is the text the member approved through `ExitPlanMode`'s permission request: this ticket decides, from F-063's plan-turn case on the real agent, whether it adds anything the approval didn't carry, and records under `## Comments` which it does (shown as the approved plan, or dropped as a duplicate). Neither becomes `agent.unknown`.
- **`mapUpdate`:** the plans arrive through the shared mapping; everything else `{ handled: false }`.
- **`modeIdFor`:** `plan` to `plan`, `build` to `default`.
- **`exportSession` and `importSession`:** `tar` over `<agentDir>/claude/projects/task/`, as argument arrays, with `stdoutTo` unused; `importSession` unpacks into the fresh box's agent folder. The archive holds that folder only, never the root of `CLAUDE_CONFIG_DIR`, where a credentials file would live.
- **The prompt:** ostra's prompt for a ticket never starts with the ticket's text, since the ACP adapter runs a prompt whose first text starts with `/` as a slash command (research, section 6).

## Done when

- [ ] Tests named for `F-018`: the config files' content for a profile with rules, skills and two MCP servers, with the three hardening keys; each kind's deny rules and denied MCP tools; the repo config paths; the subagent mapping of all four kinds of update, and a stamped plan leaving the task's plan alone; the mode IDs; the archive commands as arrays, and the archive holding no file outside `projects/task/`; a ticket titled `/init` reaching the agent as text. Each with a break-it recorded in `context/proof/F-018.md`.
- [ ] Tests named for `F-026`: after an "allow for this task", the worktree's `.claude/settings.local.json` is back to what it was (or absent) before the commit, with and without a repo file of its own (break-it: the restore skipped).
- [ ] The whole-repo checks pass (spec section 10).
- [ ] Committed as `✨ write Claude Code's task config`.

## Comments

- 2026-11-19, lead: set `wontfix`. Claude Code (F-018) moved after v1 on the maintainer's word, and this ticket waits for it.
