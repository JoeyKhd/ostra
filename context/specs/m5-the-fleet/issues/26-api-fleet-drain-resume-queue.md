# 26: API: the fleet, drain, resume, revoke and the queue

Status: ready-for-agent
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

- [ ] Tests named for `F-092` and `F-067`: the counts against seeded pools, runners and boxes; each capability line; drain, resume and revoke as an admin and refused as a member; the queue's order and a member's view of their own task's place; cancel by an admin, by the task's member, refused for another.
- [ ] Break-it: counting stopped boxes as busy fails the count test; recorded in `context/proof/F-092.md`.
- [ ] Committed as `✨ add the fleet and the queue to the API`.

## Comments
