# 11: API: Claude Code profiles, runners' agents and the theme

Status: ready-for-agent
Builder: api
Blocked by: 05, 09
Features: F-018, F-082
Packages: `packages/api`
Spec: `../spec.md`, sections 4 and 5.4

## What to build

- **`agents.list`:** the catalog for the profile editor: each agent, what it requires, its options' fields, its declared capabilities in words from the message files.
- **`agentProfiles.save`** (grown): the agent, the options, `model-format` refused with the provider named; **`models.list`** gains each model's provider format and `usableBy: ["opencode", "claude-code"]`.
- **`runners.get`** (grown): the runner's agents with state and version, and its agent images; **`runners.prepareAgent`** (organization admin) sends `agent.prepare`.
- **`account.setTheme`** and the theme in the session's payload, with the cookie set on the response.
- Every procedure checks the organization and the role, as milestones 1 to 6's do.

## Done when

- [ ] Tests named for `F-018`: a member can't save a profile; an admin's Claude Code profile on an OpenAI-compatible model is refused with `model-format`; `models.list` marks which agents can use each model; `prepareAgent` is admin only and audited.
- [ ] Tests named for `F-082`: `setTheme` saves the choice and sets the cookie; another member's theme is untouched.
- [ ] The whole-repo checks pass (spec section 10).
- [ ] Committed as `✨ add Claude Code profiles and themes to the API`.

## Comments
