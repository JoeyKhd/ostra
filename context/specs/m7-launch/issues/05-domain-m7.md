# 05: Domain: the agent catalog, profiles, admission by agent, the palette, setup's timeline

Status: ready-for-agent
Builder: core
Blocked by: 02, 04
Features: F-018, F-081, F-076, F-082
Packages: `packages/domain`
Spec: `../spec.md`, sections 4 and 5.4

## What to build

- **The agent catalog** from the shipped adapter classes: name, display name, `requires`, `optionsSchema`, capabilities.
- **`saveAgentProfile`** refuses an unknown agent, a model whose provider's format the agent doesn't take (`model-format`, naming the provider), and options its schema refuses.
- **The lifecycles** of an agent on a runner and of an agent image, with every edge tested.
- **`chooseRunner`**, grown: the agent filter and the prepare outcome (spec section 5.4), with the waiting reason naming the nearest miss.
- **`PaletteAction`**, the registry's type, and the list of spec section 12, item 11, with each action's scope, role and procedure, so the API enforces what the panel offers.
- **`setupTimeline`**, pure over audit entries and the first PR's event.
- **`setTheme`**, and the five settings of section 5.4 with their defaults and their lines in `docs/configuration.md`.

## Done when

- [ ] Tests named for `F-018`: a Claude Code profile on an OpenAI-compatible provider's model is refused, on an Anthropic-format one saved; a runner without the agent is passed over for one that has it, and a runner that can prepare it gets `agent.prepare` when none has it; a minor-5 runner is never chosen for Claude Code.
- [ ] Tests named for `F-081`: every action of the list has a scope, a role and a message key, and no two share a shortcut in one scope.
- [ ] Tests named for `F-076`: the timeline orders the steps and measures each from a given start.
- [ ] `packages/domain`'s settings test passes with the new settings in `docs/configuration.md`.
- [ ] The whole-repo checks pass (spec section 10).
- [ ] Committed as `✨ add the milestone 7 domain`.

## Comments
