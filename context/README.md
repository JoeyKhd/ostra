# Planning

**Phase:** plan signed off 2026-11-17, reworked 2026-11-18 from the maintainer's delegated answers (`history/answers-2026-11-18.md`); next: milestone 0 spikes (`build-order.md`). Decisions can still change when a spike teaches us something: a new ADR supersedes the old one. Rules for working in this repo are in `../AGENTS.md`.

| # | Step | Where it lands | Status |
|---|------|----------------|--------|
| 1 | Brief: who it's for, core loop, principles, non-goals | `project.md` | Signed off; reworked 2026-11-18 |
| 2 | Similar tools: what to borrow, where we differ | `research/landscape.md` | Done |
| 3 | Integration research: agents, trackers, accounts, GitHub, runners, live streaming, queues, credentials | `research/` | Done: thirteen files. The rework departs from six of their recommendations: hosted sandboxes (`elastic-sandboxes.md`), the Rivet Sandbox Agent (`rivet.md`), a six-agent v1 (`agent-roster.md`), DBOS first (`durable-execution.md`, ADR 0037), a Zero spike and saved token deltas (`live-sync.md`, ADR 0035), and a loopback key proxy with runner-side push and a separate OS user for `docker` and `kubernetes` (`credential-proxy.md`, ADR 0030). Section 1 of the answers file lists them, and each ADR says where it differs. The project-memory research (Q91) is still to land |
| 4 | Domain model: what exists, lifecycles, rules that always hold | `domain-model.md`, `GLOSSARY.md` | Signed off; reworked 2026-11-18 (organizations, projects, task kinds, boxes) |
| 5 | Scope: v1 and later, each with a checkable "done when" | `features.md` | Signed off; reworked 2026-11-18. The ledger holds the current count |
| 6 | Architecture: packages, server ↔ runner protocol, storage, security | `decisions/` | ADRs 0001–0025 accepted, most of them amended or superseded on 2026-11-18 (ADR 0009, the license, by ADR 0048), and ADRs 0026–0048 added. The package layout (ADR 0045) and the runner protocol (ADR 0034) are settled on paper, and milestone 0's spikes try them |
| 7 | Risks and spikes: settle every open question | `open-questions.md`, `build-order.md` (milestone 0) | 1 open: Q91, the project-memory research, which blocks no v1 row. Every other question is settled: rounds 1–6 on 2026-11-17, and rounds 7–15 by 2026-11-18, with the delegated answers recorded in `history/answers-2026-11-18.md`. Ten spikes in milestone 0 |
| 8 | Build order: milestones, each ending in something a team can use | `build-order.md` | Agreed; reworked 2026-11-18 to milestones 0–7 |

## Contents

| Path | What it is |
|------|------------|
| `project.md` | The brief: the job, who it's for, the core loop, the shape, principles and non-goals |
| `features.md` | The feature ledger: every feature, its "done when" and its status |
| `domain-model.md` | What exists, its lifecycles, and the rules that always hold |
| `GLOSSARY.md` | The name of every domain concept |
| `build-order.md` | The milestones (0–7) and the spikes of milestone 0 |
| `open-questions.md` | What's still undecided |
| `decisions/` | ADRs: one file per hard-to-reverse decision |
| `research/` | Findings on agents, trackers, vendors and similar tools, every claim cited |
| `history/` | The record of how and why the plan changed. `answers-2026-11-18.md` holds every open question as the maintainer delegated it, with each answer's decision, reason, confidence and what would reopen it |
| `architecture/` | The system overview diagram |
| `brand/` | The identity, the console layout and the screen concepts |

**System overview:** `architecture/system-overview.png`, a diagram of the whole system. Its source is `system-overview.html`; re-render it after a change, and keep it in step with the ADRs as decisions settle.

**Brand:** the identity is done: palette, logo and type (`brand/brief.md`), with every derived file in `brand/assets.md`. Panel screens come next, image first, through `ui-taste`.

The sign-off rule still holds after the rework: every v1 row has its "done when", no open question blocks a v1 row, and the build order is agreed. The one open question, Q91, blocks none: the v1 cut for memory stands until its research lands.
