# 14: Web: Claude Code in agent profiles, models and runners

Status: wontfix
Note: Won't do now (2026-11-19): Claude Code (F-018) moved after v1 (the maintainer: "perhaps we can just skip Claude Code with its ACP for now"), and milestone 7 is the launch alone, on OpenCode. Every part (the agent picker, the format filter, the profile picker's agent, a runner's agents) shows a second agent, so none applies with OpenCode alone. This ticket waits for F-018 after v1; its text stays as written for then (ADR 0062, postponed).
Builder: web
Blocked by: 11, 12
Features: F-018
Packages: `apps/web` (the agent profile pages, the models page, the runner pages, `messages/en.json`)
Spec: `../spec.md`, sections 3 (steps 1 and 2) and 13; targets `agent-profile-claude-code`, `runner-agents`

## What to build

- **The profile editor:** the agent picker from `agents.list`; with Claude Code, the model list filtered to Anthropic-format providers' models, the others listed apart with why; what the agent declares, in the target's words; its options; the runners it's ready on.
- **The profiles list, the models page, the task start and the Inbox's picker:** each grows as spec section 13's second list says.
- **A runner's agents:** each with its state and version, "Prepare now" for an admin, the failure's reason with "Try again", the agent image's digest, the license note.

## Done when

- [ ] Tests named for `F-018` (Playwright): a Claude Code profile can't pick an OpenAI-compatible model and says why; a saved Claude Code profile shows its agent everywhere a profile is picked; a runner's "Preparing" turns "Ready" when the runner reports it.
- [ ] Built against the approved targets, with the differences under `## Comments`.
- [ ] Typecheck, lint and tests of `apps/web` pass.
- [ ] Committed as `✨ show Claude Code in profiles and runners`.

## Comments

- 2026-11-19, lead: set `wontfix`. Claude Code (F-018) moved after v1 on the maintainer's word, and this ticket waits for it.
