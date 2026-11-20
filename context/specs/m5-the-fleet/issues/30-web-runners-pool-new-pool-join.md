# 30: Web: the Runners page, a pool, a new pool and joining

Status: done
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

- [x] Playwright, named for `F-092`, `F-091` and `F-067`: an admin makes a pool and sees its token once, a reload doesn't show it again; the fleet's counts change as a seeded runner takes a task; the queue's order and "Cancel"; a member sees "Your machine" and not the pools' details.
- [x] Phone width: no page scroll sideways, the tables scroll inside their sections.
- [x] Committed as `✨ add the fleet view`.

## Comments

- 2026-11-20: built. The Runners page (`components/runners/runners-view.tsx`, `pools-table.tsx`, `runner-rows.tsx`) gains the Queue and Labels columns, the capability chips (`not isolated`, its same-user form, `direct internet`), rows that open the pool, the carrier and version chips, the row menu (`runner-actions.tsx`: Drain or Resume, Revoke, Approve and Reject, with their confirms) and Your machine's containment and slots line. The pool's page (`organization/runners/pools/[pool-id]`, `pool-view.tsx`): its runners, its projects' busy boxes against their shares, the queue in order with Cancel and its confirm, the caps, the approval switch, the token lifetime, the tokens with Revoke, and the isolation and internet lines. New pool, Edit and New token share one sheet (`pool-sheet.tsx`), and the token is shown once with the three install paths (`join-commands.ts`), each reading the token from a file. Every sentence is in `messages/en.json` (the old `runners.pool` string became `runners.poolKind`). The live refresh is a 5 s poll, as milestone 1's Runners page.
- API, additive and in its own commit (`✨ add a runner's key and pool boxes to the API`, 90d5dee1): `pools.get`'s projects carry `busy` (their slot-holding boxes on the pool's runners), and `runners.get` carries `keyFingerprint` and the join token's `createdBy` (ticket 31). Tests: `packages/api/src/routers/fleet-pages.test.ts`.
- Proof: `apps/web/e2e/14-fleet.spec.ts` against seeded rows (`apps/web/e2e/seed-m5.ts`): a pool made and its token shown once and gone after a reload; the counts moving as a seeded runner takes a box, with no reload; the queue's order and Cancel; a member's Runners page without the pools; no sideways page scroll at phone width with the tables scrolling inside, and a `host` pool's `not isolated` chip. One e2e run with every break at once failed each test (rows in `context/proof/F-092.md`, `F-091.md`, `F-067.md`). Screens compared with `m5/pool`, `m5/pool-new` and `m5/pool-join`.
- Departures: (1) the Runners page and the pool's page live under `organization/runners/` as on `main`, not `runners/`. (2) The HTTP carrier's trigger isn't reported by the runner yet, so no trigger sentence. (3) The e2e suite's earlier specs 01 to 03, 07, 08, 09 (keys) and 10 (reset) failed on this machine before and after this change, on copy and flows other tickets changed; they aren't this ticket's.
- 2026-11-20: commits 90d5dee1 (`✨ add a runner's key and pool boxes to the API`) and dbaf8254 (`✨ add the fleet view`); its F-092 and F-091 proof rows landed with ticket 31's commit, 45c80a7d, which cites both specs.
