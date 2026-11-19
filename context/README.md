# Planning

**Phase:** plan signed off 2026-11-17, reworked 2026-11-18 from the maintainer's delegated answers (`history/answers-2026-11-18.md`); milestone 0's spikes are done: all ten have written their findings in `research/`, and the plan's ADRs, ledger and build order were amended from them on 2026-11-18 and 2026-11-19 (`build-order.md`, "Where the spikes stand"). Milestone 1 is in progress, milestone 2's build has started, and milestones 2, 3 and 4 are specced (`specs/`). Decisions can still change when a spike teaches us something: a new ADR supersedes the old one. Rules for working in this repo are in `../AGENTS.md`.

| # | Step | Where it lands | Status |
|---|------|----------------|--------|
| 1 | Brief: who it's for, core loop, principles, non-goals | `project.md` | Signed off; reworked 2026-11-18 |
| 2 | Similar tools: what to borrow, where we differ | `research/landscape.md` | Done |
| 3 | Integration research: agents, trackers, accounts, GitHub, runners, live streaming, queues, credentials | `research/` | Done: fourteen files, plus ten spike findings (`spike-*.md`) and one later note, `host-process-containment.md` (Q126). The rework departs from six of their recommendations: hosted sandboxes (`elastic-sandboxes.md`), the Rivet Sandbox Agent (`rivet.md`), a six-agent v1 (`agent-roster.md`), DBOS first (`durable-execution.md`, ADR 0037), a Zero spike and saved token deltas (`live-sync.md`, ADR 0035), and a loopback key proxy with runner-side push and a separate OS user for `docker` and `kubernetes` (`credential-proxy.md`, ADR 0030). Section 1 of the answers file lists them, and each ADR says where it differs. The project-memory research (Q91) is still to land |
| 4 | Domain model: what exists, lifecycles, rules that always hold | `domain-model.md`, `GLOSSARY.md` | Signed off; reworked 2026-11-18 (organizations, projects, task kinds, boxes) |
| 5 | Scope: v1 and later, each with a checkable "done when" | `features.md` | Signed off; reworked 2026-11-18. The ledger holds the current count |
| 6 | Architecture: packages, server ↔ runner protocol, storage, security | `decisions/` | ADRs 0001–0025 accepted, most of them amended or superseded on 2026-11-18 (ADR 0009, the license, by ADR 0048), and ADRs 0026–0052 added (0049 to 0052 came with milestone 3's spec: agent profiles and approval rules, notifications and email, the diff and taking a task local, checks and update branch), and ADRs 0053–0055 with milestone 4's (members, invitations and several organizations; the audit log and search; budgets, spend and Insights), which also amended 0027, 0040 and 0044. The package layout (ADR 0045) and the runner protocol (ADR 0034) were settled on paper, and the ten spikes amended ADRs 0003, 0006, 0007, 0008, 0013, 0018, 0025, 0026, 0029, 0030, 0031, 0032, 0033, 0034, 0035, 0036, 0037, 0038, 0039, 0040, 0041, 0042, 0043 and 0046. The questions milestone 1 raised amended ADRs 0007, 0027, 0029, 0030 and 0034 on 2026-11-19 |
| 7 | Risks and spikes: settle every open question | `open-questions.md`, `build-order.md` (milestone 0) | Open: Q91 and Q134 (research: prior art for project memory, and where OpenCode keeps its tool outputs), and Q109 and Q110 (the CLA and the licensor, for the maintainer and a lawyer). None blocks a v1 row. Every other question is settled: rounds 1–6 on 2026-11-17, rounds 7–15 by 2026-11-18 with the delegated answers in `history/answers-2026-11-18.md`, Q111 to Q125 from the first spikes' findings on 2026-11-18, Q128 and Q150 to Q163 from the second batch's on 2026-11-19, Q127 and Q164 on 2026-11-19, and the questions milestone 1 raised (Q107, Q108, Q126, Q129 to Q133 and Q136) on 2026-11-19, with their reasoning in `history/answers-2026-11-19.md`, Q165 to Q185 for milestone 3's spec on 2026-11-19, and Q191 to Q209 for milestone 4's spec the same night. Ten spikes in milestone 0, all done |
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
| `specs/` | One folder per milestone (`m1-first-pr`, `m2-tickets-in`, `m3-step-in`, `m4-the-organization`): the spec, and the tickets as markdown files in `issues/` |
| `proof/` | The proof ledger: for each feature, a test that shows each "done when" condition holds (`proof/README.md`) |
| `decisions/` | ADRs: one file per hard-to-reverse decision |
| `research/` | Findings on agents, trackers, vendors and similar tools, every claim cited |
| `history/` | The record of how and why the plan changed. `answers-2026-11-18.md` holds every open question as the maintainer delegated it, with each answer's decision, reason, confidence and what would reopen it. `answers-2026-11-19.md` does the same for the questions milestone 1 raised |
| `architecture/` | The system overview diagram |
| `brand/` | The identity, the console layout and the screen concepts |

**System overview:** `architecture/system-overview.png`, a diagram of the whole system. Its source is `system-overview.html`; re-render it after a change, and keep it in step with the ADRs as decisions settle.

**Brand:** the identity is done: palette, logo and type (`brand/brief.md`), with every derived file in `brand/assets.md`. Panel screens come next, image first, through `ui-taste`.

The sign-off rule still holds after the rework: every v1 row has its "done when", no open question blocks a v1 row, and the build order is agreed. Four questions are open, and none blocks a v1 row. Q91 and Q134 are research: the v1 cut for memory stands until Q91's lands, and Q134 has an interim answer in milestone 2's ticket 23. Q109 and Q110 are the maintainer's, due before anyone but the licensor contributes code.
