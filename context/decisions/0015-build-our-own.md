# Build our own, borrowing ideas, not code

**Status:** accepted (plan signed off 2026-11-17). Chosen on 2026-11-17 in grilling round 2.

ostra is written from scratch. It's not a fork of Cyrus, Vibe Kanban, Kandev or Multica (`research/landscape.md`).

## Considered options

- **Fork Cyrus** (TypeScript, Apache-2.0, a real Linear agent). Rejected for three reasons:
  - It's built around one machine per team, while ostra's core is a team server with many runners.
  - Its team panel is the paid product.
  - Forking would tie ostra to that roadmap.
- **Fork Vibe Kanban.** Rejected: the company behind it shut down, it has no tracker support, and v0.1.44 broke its team boards.
- **Kandev** (Go, AGPL) and **Multica** (not open source). Rejected for the language and the license.

## Consequences

Before ostra's own versions are designed, three designs get read closely:
- Cyrus's Linear agent code
- Vibe Kanban's agent drivers, with resume and rewinding to a message
- Claude Code's self-hosted environments (runner leases, heartbeats, runners locked to one owner)
