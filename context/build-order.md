# v1 build order

**Status:** agreed (2026-11-17), with the plan's sign-off. Each milestone ends in something a team could actually use, and builds only on what's already done. Feature IDs come from `features.md`, and every v1 row appears below exactly once, or once per milestone that grows it.

## Built in from the first milestone

These aren't a milestone of their own. Every milestone is built on them, and they're checked at each milestone's end:

- **Team-scoped data** (ADR 0010). It's the model from the first migration, even with one team.
- **The event log and the durable queue** (ADR 0011, ADR 0017). Nothing is acted on before it's saved.
- **Strict typing end to end** (`AGENTS.md`).
- **Dark first, responsive, English text in message files:** F-082, F-075 and F-083.
- **ACP as the only way to talk to an agent** (ADR 0018).

## Milestones

| # | Milestone | Features | Ends with |
|---|---|---|---|
| 0 | Spikes | None. Six throwaway experiments (below), whose findings go into `research/` | Every assumption the plan rests on has been tried for real |
| 1 | First PR | F-001 one-command install · F-076 setup in the panel (first version) · F-006 GitHub App · F-005 Linear, plain API · F-007 boards and repos · F-010 ticket inbox · F-064 ticket context · F-013 runner (built-in only) · F-016 workspace per task · F-050 environments · F-018 Claude Code · F-023 live activity · F-025 stop · F-030 open the PR · F-078 repo conventions · F-065 no empty PRs · F-031 ticket sync | An admin installs ostra on one machine, connects GitHub and Linear, and picks a ticket. They watch Claude Code work live and get a PR linked on the ticket |
| 2 | Robust core | F-043 nothing is lost · F-044 drift gets fixed · F-045 runners can drop out · F-046 no duplicates · F-047 crashes don't kill tasks · F-048 failure tests · F-068 runaway protection · F-060 protected default branch · F-055 signed-commit repos · F-079 cleanup and retention | The failure suite passes: kill the runner, drop webhooks, restart the server mid-task, and nothing is lost or duplicated. Everything after this is built on a proven core |
| 3 | Step in and come back | F-021 agent profiles · F-024 steer and take over · F-026 approvals · F-063 plan first · F-062 home ("needs you") · F-036 notifications in the panel and Linear · F-027 diff · F-072 diff comments · F-028 take it local · F-041 `ostra attach` · F-070 update branch · F-054 checks before the PR · F-053 `@ostra` on the PR · F-032 reopen · F-066 after the merge · F-084 usage | A member steers, approves, answers and reviews in the panel, and reopens a task from the panel, from GitHub and from their own terminal, on the same branch and PR |
| 4 | The team | F-002 team accounts · F-003 roles · F-049 several teams · F-013 runner (sign-in code, reconnect) · F-014 local runners · F-015 remote runners · F-039 runner image · F-069 choosing a runner · F-067 capacity and queue · F-061 runner versions · F-033 reopen anywhere · F-073 audit log · F-080 search | The maintainer's team works one board together, each on their own laptop plus a shared server. Any member picks up anyone's task, on any runner |
| 5 | From the tracker | F-011 intake rules · F-012 start from Linear (agent mode) · F-040 approval for outside tasks · F-042 private installs · F-077 sub-issues | Anyone in Linear hands a ticket to ostra and follows it there. Rules pick up labelled tickets by themselves, and outside tasks wait for a member's approval |
| 6 | Launch | F-058 docs site · F-081 keyboard and accessibility · F-085 signed runner downloads · F-076 setup in the panel (complete, measured) · and the final check of F-075, F-082 and F-083 | Public v1. A team new to ostra goes from `docker compose up` to its first agent-made PR in under 30 minutes, following only the docs |

## Milestone 0: spikes

Throwaway code in `spikes/<kebab-question>/` (`AGENTS.md`). Each finding goes into `research/`:

1. **Claude Code through ACP** (ADR 0018). Start, stream, steer mid-turn, interrupt, and resume through `claude-agent-acp`, on the maintainer's own Claude Code login, with no API key. An approval that waits for hours.
2. **Moving a session** (ADR 0006). Archive a Claude Code session on one machine and restore it on another (step 2). Rebuild from ticket, summary and branch, and judge how well that works (step 3).
3. **Linear agent mode** (ADR 0013). A test workspace through a tunnel: the 5-second and 10-second deadlines, delegation, stop and follow-up.
4. **GitHub App** (`research/platform-auth-github.md`). The manifest flow from a local server, and one-repo push tokens handed to a runner through a git credential helper.
5. **The runner** (ADR 0023). As an npm package on Node and as a Bun-compiled binary, on Windows, macOS and Linux: spawning `claude-agent-acp` and reconnecting to a server.
6. **The durable queue** (ADR 0017). Compare Postgres-backed queue libraries, then ask the maintainer before adding one.

## Outside the code (long lead times)

| What | Needed for | Status |
|---|---|---|
| A Linear workspace for development and tests | Milestone 0 | The maintainer will provide access |
| A GitHub org with test repos, and the public ostra repo | Milestone 0 | Not started |
| An Anthropic API key, for shared remote runners and CI test runs (ADR 0014). The spikes use the maintainer's own Claude Code login, which Anthropic's terms allow on their own machine | Milestone 4 | Not needed yet |
| A public HTTPS address for the dev server (a tunnel) | Milestone 0 (spike 3) | Not started |
| The name, checked 2026-11-17. **Taken:** npm `ostra` (abandoned since 2023), GitHub `ostra` (a personal account), ostra.dev, ostra.ai, ostra.app (a board game) and ostrahq.com. **Free:** npm `ostra-runner`, GitHub `ostrahq` and `getostra`, and getostra.com. **To confirm at a registrar:** ostra.sh, ostra.so and ostra.io showed no record | Before the repo goes public | Open |
| Signing the runner binary: an Apple Developer Program membership and a Windows code-signing certificate (ADR 0023) | Milestone 6 | Agreed; not started |

## How each milestone runs

1. The milestone's panel screens are designed first, image first, through the `ui-taste` skill against `brand/brief.md`. The approved pictures land in `brand/app-targets/`.
2. A spec in `specs/<milestone>/spec.md` (the `to-spec` skill) names the milestone's feature IDs. Its test seams and schema changes are agreed before building.
3. Tickets come from the spec (the `to-tickets` skill), each with its blocking edges.
4. The milestone ends with a demo against the test workspaces. Every feature it finished is set to `done` in the ledger in the same commit.

## ostra builds ostra

Once the maintainer provides Linear access, ostra's own tickets move from `specs/` into a Linear workspace. From milestone 3 on, ostra's development runs through ostra itself, which makes the maintainer's team its first real users.
