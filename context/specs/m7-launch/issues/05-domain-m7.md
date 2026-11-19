# 05: Domain: the agent catalog, profiles and admission by agent

Status: ready-for-agent
Builder: core
Blocked by: 02, 04
Features: F-018
Packages: `packages/domain`
Spec: `../spec.md`, sections 4 and 5.4
Note: the palette's actions, setup's timeline and the theme moved to ticket 36 in the spec's review, so the web and api tickets that need them don't wait on the agent work.

## What to build

- **The agent catalog** from the shipped adapter classes: name, display name, `requires`, `optionsSchema`, capabilities.
- **`saveAgentProfile`** refuses an unknown agent, a model whose provider's format the agent doesn't take (`model-format`, naming the provider), and options its schema refuses.
- **The lifecycles** of an agent on a runner and of an agent image, with every edge tested.
- **`chooseRunner`**, grown: the agent filter and the prepare outcome (spec section 5.4), with the waiting reason naming the nearest miss.
- **The four runner settings** of section 5.4 (`OSTRA_AGENTS_DIR`, `OSTRA_NPM_REGISTRY`, `OSTRA_AGENT_PREPARE`, `OSTRA_AGENT_IMAGE_CLAUDE_CODE`) and `OSTRA_DOCS_URL`, with their defaults and their lines in `docs/configuration.md`.

## Done when

- [ ] Tests named for `F-018`: a Claude Code profile on an OpenAI-compatible provider's model is refused, on an Anthropic-format one saved; a runner without the agent is passed over for one that has it, and a runner that can prepare it gets `agent.prepare` when none has it; a minor-5 runner is never chosen for Claude Code.
- [ ] `packages/domain`'s settings test passes with the new settings in `docs/configuration.md`.
- [ ] The whole-repo checks pass (spec section 10).
- [ ] Committed as `✨ add the milestone 7 domain`.

## Comments
