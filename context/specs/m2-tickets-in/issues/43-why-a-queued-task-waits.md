# 43: Say why a queued task waits

Status: ready-for-agent
Builder: api, web; core for the reason's shape
Blocked by: none
Features: F-014, F-067, F-069
Packages: `packages/domain` (`use-cases/dispatch-task.ts`, `use-cases/accept-offer.ts`), `apps/core` (`src/dispatch/dispatcher.ts`), `packages/db` (one additive column on `Task`), `packages/api` (`routers/tasks.ts`), `apps/web` (`src/components/tasks/`), `apps/web/messages/en.json`
Spec: `../spec.md`, section 7 (follow-ups); `context/domain-model.md`, "A task's lifecycle" (queued); ADR 0034, "Down, from server to peer"

## Why

Settled as Q132 on 2026-11-19 (`context/open-questions.md`, Settled). A task stays `queued` while a runner's offer is out, and while no runner fits. Core stores why in `Task.dispatchNote`, as an English sentence, and empties it when an offer goes out. No screen reads it. So a queued task says nothing about why it waits, and one that waits on an offer looks like one with no place to run.

## What to build

- **The reason as data.** `dispatchTask`, `acceptOffer` and the offer timeout record why the task waits as a code with its values, in a new nullable JSON column that a strict Zod schema parses: `no-model`, `provider-held { until }`, `provider-cap { cap }`, `personal-runner-not-allowed`, `personal-runner-unavailable`, `no-runner-online`, `offer-declined`, `offer-timed-out`. `dispatchNote` keeps being written for one release (add first, drop later).
- **The offer.** For a queued task, `tasks.get` and the project's task list return `waiting`:
  - `{ kind: "offered", runner: { id, name }, since }`, from the task's active lease that no runner has accepted yet
  - `{ kind: "no-runner", reason }`, from the column above
  - `null`, just after the task was made
- **The panel.** One line under a queued task's state on the task page, and the same words in the list's row: "Offered to build-01, waiting for it to accept", or the reason's sentence. Every sentence is in `apps/web/messages/en.json`, and none comes from the server (F-083). If the task page's target has no place for the line, the target is amended and approved first, and until then the data ships with its tests.

## Done when

- [x] Tests: each reason is stored and returned; an open offer reads as offered, with the runner's name; an accepted, a declined and a timed-out offer each change it; another organization's task returns nothing.
- [x] No sentence shown for a queued task comes from the server.
- [x] Proof (`AGENTS.md`, `context/proof/README.md`): each test that proves a condition of a row's "done when" names the row's ID in its title and has a break-it check, its rows are in `context/proof/`, and `pnpm check:proof` passes.
- [x] Committed as `✨ say why a queued task waits`.

## Comments
- 2026-11-19, core: done in `✨ say why a queued task waits`, data and API only. The task page's target has no place for the line, so the panel's sentences and the line wait for the target to be amended and approved.
  - **The column:** `Task.dispatchWait` (JSONB, nullable, migration `20261119230000_task_dispatch_wait`), parsed by `dispatchWaitSchema` (`packages/domain/src/dispatch-wait.ts`, strict): `no-model`, `provider-held { until }` (epoch ms), `provider-cap { cap }`, `personal-runner-not-allowed` (the provider isn't allowed on personal runners), `personal-runner-unavailable` (the picked runner is offline, busy, revoked or not its creator's), `no-runner-online`, `offer-declined`, `offer-timed-out`. `dispatchWaitColumns` writes it and milestone 1's `dispatchNote` together, for one release; an offer going out clears both.
  - **The read:** `waitingFor(task, lease)` in the domain, used by `tasks.get` and `tasks.list`: `{ kind: "offered", runner: { id, name }, since }`, `{ kind: "no-runner", reason }` or `null`. No procedure returns `dispatchNote`.
  - **Panel copy to add with the line:** one key per code, with `{until}` and `{cap}`, and the offer's "Offered to {runner}, waiting for it to accept".
  - Tests: `apps/core/src/dispatch/waiting.test.ts` (each reason stored by its real path, the offer timeout included) and `packages/api/src/routers/tasks-waiting.test.ts` (each returned from `get` and the list, offered/accepted/declined, null, another organization, no sentence). They're titled `F-014`, whose row carries Q132; no feature's "done when" has a sentence for this yet, so there is no proof row.
