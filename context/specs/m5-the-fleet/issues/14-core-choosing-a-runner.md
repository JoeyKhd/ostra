# 14: Core: choosing a runner

Status: done
Builder: core
Blocked by: 05, 13
Features: F-069, F-014, F-095
Packages: `apps/core` (`src/dispatch/`), `packages/domain` (`chooseRunner`'s body, `dispatch-wait.ts`), `packages/domain/src/testing/` (a helper that makes a task with no member, for the sources milestone 6 adds)
Spec: `../spec.md`, section 4 ("Choosing a runner"); ADR 0059; section 11, item 6

## What to build

- **`chooseRunner`'s body,** called by the admission: the task's own personal runner when its member picked it, and nothing else then; otherwise the project's pools in `ProjectPool.position` order. In a pool, the candidates are `online`, approved, carry every required label, declare what the task needs (`services` when the environment has services, `registry` when the pool's executor requires one and the organization has none set: the reason `needs-registry`), have a free slot, and have room for the project's size where sizes apply. The pick: the most free room, then the runner holding the project's ready snapshot (milestone 3's rule), then the oldest `lastOfferedAt`.
- **The wait reason,** when nothing fits, is the nearest miss across the pools, in this order: `needs-registry`, `needs-services`, `no-runner-with-labels`, `size-too-large`, `project-share-reached`, `pool-full`, `no-runner-online`.
- **Who may use a personal runner:** a task a member started and picked it for. A task no member started (the test helper's, standing for milestone 6's rules, schedules and agent mode) goes to pools only, and is never offered to a personal runner even when its member is known.
- **The dispatch spec** carries `box.size` from the project's default (resolved against `BoxSize`) on executors with sizes, and `box.image` when the chosen runner should pull the project's snapshot (ticket 17).
- Milestone 3's rule that services never go to `host` keeps its test, now through `chooseRunner`.

## Done when

- [x] Tests named for `F-069`: the table of section 9.1 (pools in order, labels, capacity, personal runners only for their member's own picked tasks, tasks with no member to pools, services never to `host`), each reason the right one; the pick's tie-breaks.
- [x] Break-it: offering a no-member task to a personal runner fails its test; recorded in `context/proof/F-069.md`.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ choose a runner by pool, labels and room`.

## Comments

- 2026-11-20: `chooseRunner`'s body was ticket 05's; this ticket calls it from every dispatch (`dispatchTask` in `packages/domain/src/use-cases/dispatch-task.ts`, with the rows from `fleet-rows.ts`, built with ticket 13) and proves it through the real admission in `apps/core/src/dispatch/choose.test.ts`. `seedTaskStartedByNobody` in `@ostra/domain/testing` makes a task no member started. Every F-069 row is `proved`; the feature stays `building` until ticket 37's demo (step 7) runs it end to end.
  - "Started by a member" is `creatorMemberId` set. A task with none goes to pools only, even when it names a personal runner or has a driver.
  - The dispatch's `box.size` (from the project's default, resolved against `BoxSize`) goes only to a runner whose capabilities say `boxSizes` (ticket 13's commit). `box.image` is ticket 17's.
  - A runner below minor 4 reports no capabilities: core reads them from its executor and minor (`olderCapabilities`): services from minor 2 and never on `host`, no sizes, no registry. So milestone 3's rule keeps its own test (`services.test.ts`) through `chooseRunner`, with its `needs-services-runner` words when only runners that can't start services are online.
  - `needs-protocol` (a profile or a level a runner's minor can't run) is found by choosing again without the minor filter.
- 2026-11-20: committed as ff1fb15e (✨ choose a runner by pool, labels and room).
