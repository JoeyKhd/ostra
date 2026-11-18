# Build our own, borrowing ideas and small, credited ports

**Status:** accepted (plan signed off 2026-11-17). Chosen on 2026-11-17 in grilling round 2. Amended 2026-11-18: the title and text now allow small ports of logic with attribution (Q21), and the Omnara point no longer assumes Claude Code as the agent.

ostra is written from scratch. It's not a fork of Cyrus, Vibe Kanban, Kandev or Multica (`research/landscape.md`). It borrows ideas freely. It may also borrow a small piece of logic as a port, with attribution, never as a copied file (see Borrowed code).

## Considered options

- **Fork Cyrus** (TypeScript, Apache-2.0, a real Linear agent). Rejected for three reasons:
  - It's built around one machine per team, while ostra's core is a server with many runners.
  - Its team panel is the paid product.
  - Forking would tie ostra to that roadmap.
- **Fork Vibe Kanban.** Rejected: the company behind it shut down, it has no tracker support, and v0.1.44 broke its team boards.
- **Kandev** (Go, AGPL) and **Multica** (not open source). Rejected for the language and the license.
- **Building on Omnara** (Apache-2.0, Go; looked at on 2026-11-18 when the maintainer asked). Rejected:
  - It runs its own agent loop on model API keys instead of driving existing coding agents over ACP (ADR 0018, ADR 0032).
  - It's Go (ADR 0008), and heavier to self-host.
  - Its product overlaps ostra's.

  Its architecture confirms ostra's, and its runner design is worth borrowing as an idea (`research/landscape.md`, addendum).

## Borrowed code

A port is allowed under these rules (Q21):
- It is a small piece of logic, retyped to ostra's own rules (`AGENTS.md`). A vendored file is never allowed.
- Each port is listed in this section and in `NOTICE`.
- A port that would pass a few hundred lines gets an ADR of its own.

This section is the record of every port. The first two:
- Rivet's agent launch table (milestone 1). Rivet itself isn't a dependency (ADR 0032).
- Cyrus's rules for turning agent events into Linear activities (milestone 6). `research/integrations-platform.md` found its files too coupled to reuse and too loosely typed for `AGENTS.md`, while its rules are proven in production.

## Consequences

Before ostra's own versions are designed, three designs get read closely:
- Cyrus's Linear agent code
- Vibe Kanban's agent drivers, with resume and rewinding to a message
- Claude Code's self-hosted environments (runner leases, heartbeats, runners locked to one owner)
