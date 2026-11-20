# 26: API: the fleet, drain, resume, revoke and the queue

Status: done
Builder: api
Blocked by: 13, 15
Features: F-092, F-067
Packages: `packages/api` (`src/routers/runners.ts`, `src/routers/pools.ts`, `src/routers/tasks.ts`)
Spec: `../spec.md`, sections 3 (steps 4, 6 and 9) and 4

## What to build

- **`runners.list`** grows to the fleet: per pool, its busy boxes against its slots, its queue's length, its runners' versions (a range when they differ) and labels; per runner, its state, connection, carrier, executor, containment, install, version state, slots and resources, labels, busy boxes, and the line its capabilities call for ("not isolated"; "the agent has direct internet access" on `kubernetes`; "same user (development only)").
- **`runners.get { runnerId }`:** the runner's page, with the token it joined with, who approved it, its boxes now and its last 20 audit entries.
- **`runners.drain`, `runners.resume`** (admins), and milestone 2's `runners.revoke`, with the counts their confirms show.
- **`pools.queue { poolId }`:** the queued tasks the pool could run, in order, each with its project, priority, queued time, wait reason and place; `tasks.cancelQueued { taskId }` for an admin, or the task's member.
- **`tasks.get` and the task lists** return the new wait reasons and the queue place.
- Members see their own personal runner and the pools' names only; admins see everything.

## Done when

- [x] Tests named for `F-092` and `F-067`: the counts against seeded pools, runners and boxes; each capability line; drain, resume and revoke as an admin and refused as a member; the queue's order and a member's view of their own task's place; cancel by an admin, by the task's member, refused for another.
- [x] Break-it: counting stopped boxes as busy fails the count test; recorded in `context/proof/F-092.md`.
- [x] Committed as `✨ add the fleet and the queue to the API`.

## Comments

- 2026-11-20: built in `packages/api/src/routers/fleet-view.ts` (new: the counts, the runner view, the lines and a queued task's place), `runners.ts` (`list` grown, `get`, `drain`, `resume`), `pools.ts` (`list` grown, `queue`, `names`) and `tasks.ts` (`cancelQueued`, and `queue` on `get` and `list`). Tests: `packages/api/src/routers/fleet.test.ts`; proof rows in `context/proof/F-092.md` and `F-067.md`. Decisions:
  - Busy boxes are `Box` rows that hold a slot (`creating`, `preparing`, `ready`, `idle`), as admission counts them; milestone 2's count of active leases is gone. A pool's slots are those of its `online` and `draining` runners.
  - The capability lines are codes the panel words (F-083): `not-isolated` (a runner whose capabilities say `isolation: none`, or a runner below minor 4 on `host`), `direct-internet-access` (`kubernetes`) and `same-user-development` (a `host` pool runner while the server's `OSTRA_DEV_HOST_POOL_SAME_USER` is on: the runner doesn't report it, so the server's setting stands for it). A pool's lines are its runners'.
  - The version state compares the runner's minor and release against this server's minor (`PROTOCOL_MINOR`); the server's release isn't known to the API (`CORE_VERSION` is core's), so at the same minor a runner reads `current`.
  - Departure from "`runners.list` ... members see their own personal runner and the pools' names": `runners.list` and `pools.list` stay admin-only so their outputs keep one shape for the panel; a member reads their runners through `runners.mine` and `runners.get` (their own personal runner only; any other is `NOT_FOUND`) and the pools' names through the new `pools.names`.
  - `pools.queue` is admins only. A member sees their own task's place on `tasks.get` (`queue: { poolId, poolName, place, length }`), read from the pool's queue now rather than the place the admission last recorded, which goes stale as the queue moves.
  - `runners.drain` answers `runningTasks`, the busy boxes that will finish; `runners.resume` answers `commandSent` (false below minor 4); `runners.revoke` keeps its `stoppedTasks`.
