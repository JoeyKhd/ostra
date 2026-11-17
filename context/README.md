# Planning

**Phase:** the plan was **signed off on 2026-11-17**. Next is milestone 0, the spikes (`build-order.md`). Decisions can still change when a spike teaches us something: a new ADR supersedes the old one. Rules for working in this repo are in `../AGENTS.md`.

| # | Step | Where it lands | Status |
|---|------|----------------|--------|
| 1 | Brief: who it's for, core loop, principles, non-goals | `project.md` | Signed off |
| 2 | Similar tools: what to borrow, where we differ | `research/landscape.md` | Done |
| 3 | Integration research: agents, trackers, accounts, GitHub | `research/` | Done: `trackers.md`, `platform-auth-github.md`, `agent-harnesses.md`, `agent-roster.md` |
| 4 | Domain model: what exists, lifecycles, rules that always hold | `domain-model.md`, `GLOSSARY.md` | Signed off |
| 5 | Scope: v1 and later, each with a checkable "done when" | `features.md` | Signed off: 84 features, 67 in v1 |
| 6 | Architecture: packages, server ↔ runner protocol, storage, security | `decisions/` | ADRs 0001–0023 accepted; the package layout and runner protocol come with milestone 0's spikes |
| 7 | Risks and spikes: settle every open question | `open-questions.md`, `build-order.md` (milestone 0) | 1 open (Jira sign-in, before Jira work). Grilling rounds 1–6 answered 2026-11-17 |
| 8 | Build order: milestones, each ending in something a team can use | `build-order.md` | Agreed |

**Brand:** the identity is done: palette, logo and type (`brand/brief.md`), with every derived file in `brand/assets.md`. Panel screens come next, image first, through `ui-taste`.

Sign-off held: every v1 row has its "done when", no open question blocks a v1 row, and the build order is agreed.
