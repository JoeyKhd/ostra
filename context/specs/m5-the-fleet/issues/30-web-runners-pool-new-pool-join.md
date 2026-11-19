# 30: Web: the Runners page, a pool, a new pool and joining

Status: ready-for-agent
Builder: web
Blocked by: 25, 26, 29
Features: F-092, F-091, F-067
Packages: `apps/web` (`src/app/(panel)/runners/`, `src/components/runners/`, `messages/en.json`)
Spec: `../spec.md`, sections 3 (steps 1 to 4 and 6) and 12

## What to build

- **The Runners page** grown against `app-targets/m1/runners`, with the changes listed in this ticket's `## Comments` before building: Queue and Labels columns, the `kubernetes` chip, rows that open the pool, the carrier and "outdated" chips, the row menu, "Your machine" with its containment and slots.
- **The pool page** (`m5/pool`): runners, busy boxes per project against each share, the queue with "Cancel" and its confirm, caps, tokens, the approval switch, the isolation and internet lines.
- **New pool** (`m5/pool-new`) and **the token shown once** (`m5/pool-join`): the three install paths, each copying a command that reads the token from an environment variable or a file, never one with the token pasted into a shell line; the tokens list with "Revoke".
- Every sentence in `messages/en.json`; the live stream refreshes the counts.

## Done when

- [ ] Playwright, named for `F-092`, `F-091` and `F-067`: an admin makes a pool and sees its token once, a reload doesn't show it again; the fleet's counts change as a seeded runner takes a task; the queue's order and "Cancel"; a member sees "Your machine" and not the pools' details.
- [ ] Phone width: no page scroll sideways, the tables scroll inside their sections.
- [ ] Committed as `✨ add the fleet view`.

## Comments
