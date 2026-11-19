# 23: Docs: agents, using ostra, security, reference and the adapter guide

Status: ready-for-agent
Builder: adapters
Blocked by: 21
Features: F-058
Packages: `apps/docs/content/` (agents, using, security, reference, contributing)
Spec: `../spec.md`, section 6; ADR 0063 (sections 4 to 8 of "What the site holds")
Note: changed 2026-11-19. Claude Code (F-018) moved after v1, so the agents page covers OpenCode alone; the Claude Code half of it is in this file's history for F-018.

## What to build

- **Agents and models:** providers in either format; OpenCode, the one agent at launch, and that more agents come after v1 through the same interface; the parity table of spec section 6 in plain words (what OpenCode declares, and what ostra does where it lacks a capability); profiles, approval rules, plan first.
- **Using ostra:** one short page per concept, linking the panel's own words.
- **Security:** what the box holds and doesn't, the proxies, `host` isn't isolated, the review's summary and its open mediums and lows (ticket 27), how to report (`SECURITY.md`).
- **Reference:** the configuration reference (rendered by ticket 21), the CLI's commands from its own `--help`, the protocol's window, the ports.
- **Contributing:** the adapter guide for each of the eight kinds (the base class, its capabilities, its contract suite, the tiny adapters as the worked example, ADR 0025), and the contributor agreement: what it asks and how to agree, linked to `CONTRIBUTING.md` (ADR 0048).

## Done when

- [ ] Tests named for `F-058`: the adapter guide's code samples typecheck against `packages/adapter-sdk` (extracted and compiled in the test); the CLI reference matches `ostra --help` (break-it: a renamed flag fails).
- [ ] The pages exist in the built site, each linked from its section.
- [ ] Committed as `📝 write the agent, security and adapter guides`.

## Comments
