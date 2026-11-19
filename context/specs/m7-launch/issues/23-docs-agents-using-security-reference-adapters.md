# 23: Docs: agents, using ostra, security, reference and the adapter guide

Status: ready-for-agent
Builder: adapters
Blocked by: 21
Features: F-058, F-018
Packages: `apps/docs/content/` (agents, using, security, reference, contributing)
Spec: `../spec.md`, section 6; ADR 0063 (sections 4 to 8 of "What the site holds")

## What to build

- **Agents and models:** providers in either format; OpenCode; Claude Code on keys: that it needs Anthropic's Messages API, that no subscription login is used and `--hide-claude-auth` refuses one, where its binary comes from and that it's downloaded from npm under Anthropic's terms, the one-time image, the repo's Claude settings set aside; the parity table of spec section 6 in plain words; profiles, approval rules, plan first.
- **Using ostra:** one short page per concept, linking the panel's own words.
- **Security:** what the box holds and doesn't, the proxies, `host` isn't isolated, the review's summary and its open mediums and lows (ticket 27), how to report (`SECURITY.md`).
- **Reference:** the configuration reference (rendered by ticket 21), the CLI's commands from its own `--help`, the protocol's window, the ports.
- **Contributing:** the adapter guide for each of the eight kinds (the base class, its capabilities, its contract suite, the tiny adapters as the worked example, ADR 0025), and the CLA's status as it is (Q109): no outside code until it exists.

## Done when

- [ ] Tests named for `F-058`: the adapter guide's code samples typecheck against `packages/adapter-sdk` (extracted and compiled in the test); the CLI reference matches `ostra --help` (break-it: a renamed flag fails).
- [ ] The pages exist in the built site, each linked from its section.
- [ ] Committed as `📝 write the agent, security and adapter guides`.

## Comments
