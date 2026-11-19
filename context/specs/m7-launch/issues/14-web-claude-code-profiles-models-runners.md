# 14: Web: Claude Code in agent profiles, models and runners

Status: ready-for-agent
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
