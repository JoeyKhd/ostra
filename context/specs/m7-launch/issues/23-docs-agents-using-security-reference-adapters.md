# 23: Docs: agents, using ostra, security, reference and the adapter guide

Status: done
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

- [x] Tests named for `F-058`: the adapter guide's code samples typecheck against `packages/adapter-sdk` (extracted and compiled in the test); the CLI reference matches `ostra --help` (break-it: a renamed flag fails).
- [x] The pages exist in the built site, each linked from its section.
- [x] Committed as `📝 write the agent, security and adapter guides`.

## Comments

- 2026-11-19: Written from the code on origin/main: 24 pages under agents-and-models, using-ostra, security, reference and contributing, OpenCode as v1's one agent, with its capability table taken from `opencode-adapter.ts` and what ostra does where it lacks one. Tests: `packages/adapter-sdk/src/adapter-guide-samples.test.ts` takes every `ts` block of the adapter guide, names it by its `title`, and compiles them in memory as files of `@ostra/adapter-sdk` with its own tsconfig (break-it: an unknown capability failed it); `apps/runner/src/cli/cli-docs-reference.test.ts` runs `ostra --help` and checks the CLI page's commands, flags, variables, defaults and words both ways (break-it: `--capacity` renamed on the page, and in the code, each failed it); the export check gained a case that every page of the five sections is built, no longer a skeleton, and linked from its section's navigation. The worked secret store also passed `defineSecretStoreContractSuite` when run by hand.
- 2026-11-19: Open for ticket 27: the security review page states what the review checks and that its summary and open mediums and lows land there when it's signed; `SECURITY.md` doesn't exist yet, so the reporting page points at GitHub's private vulnerability reporting and names `SECURITY.md` as coming with the review. `--transport`'s words on the CLI page are the help's own ("Milestone 1 has websocket only; auto and http come in milestone 5"), since the page is held to them; changing them is a runner change, not a docs one.
