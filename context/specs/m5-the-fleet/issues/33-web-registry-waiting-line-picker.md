# 33: Web: the registry, the task's waiting line and the runner picker

Status: done
Builder: web
Blocked by: 27, 28, 29
Features: F-120, F-067, F-069, F-014, F-093
Packages: `apps/web` (`src/app/(panel)/organization/registry/`, `src/components/tasks/`, `src/components/task-new/`, `src/components/environment/`, `messages/en.json`)
Spec: `../spec.md`, sections 3 (steps 6, 7, 8, 12 and 13) and 12

## What to build

- **The registry page** (`m5/registry`): address, prefix, the credentials as set or not (never shown), "Check" and its result, the pools that need it, the snapshots with digests.
- **The task's waiting line** against `app-targets/m1/task` and `m2/task-limits`: one sentence per wait reason, from `messages/en.json` and never from the server (milestone 2's ticket 43 left the line for this), the queue's place, "Waiting for a node" with how long, "Cancelled by …"; the runner and the box size in the properties panel.
- **New task's runner picker** against `app-targets/m1/task-new`: "A pool" or "Your machine", each disabled with its reason.
- **The environment's snapshot section** against `app-targets/m3/environment-services`: the registry reference, the digest and where it was built.

## Done when

- [x] Playwright, named for `F-067`, `F-069` and `F-120`: each wait reason's sentence for a seeded task; the picker's disabled reasons; the registry's check result; no credential's value in the page's HTML.
- [x] Committed as `✨ add the registry and the waiting line`.

## Comments

- 2026-11-20: built in `apps/web` (`organization/registry/` with `components/organization/registry-view.tsx`; the task page's waiting line, `components/tasks/task-waiting.tsx` and its words; New task's and the Inbox's runner picker, `components/tasks/run-on.tsx`; the box size in the task's and New task's properties; the registry's image and the builder in the environment's snapshot group) and, additively, `packages/api` (`registryUse.get` in `src/routers/registry-use.ts`: who set each credential and when, the `docker` pools, where each snapshot was built, today's issued credentials; `tasks.get`'s box wait in the protocol's spelling, `image-pull`). Tests: `apps/web/e2e/16-registry-waiting.spec.ts`, `packages/api/src/routers/registry-use.test.ts` and the words' unit tests; proof rows in `context/proof/F-067.md`, `F-069.md`, `F-014.md` and `F-120.md`. The registry's check in the e2e is core's own, against the fake OCI registry of ticket 06 on this machine. Each screen was screenshot at 1440 wide and at phone width and compared with its target by eye. Changes against the existing targets (spec section 12's second list):
  - `m1/task`, `m2/task-limits`: one waiting line under the state line: the queue's place first (`3rd in build-fleet's queue`), then why, one sentence per reason; `Waiting for a node · 40s` (or `Pulling the snapshot image`) while the box waits; `Cancelled by Demo` for a task cancelled from the queue. The properties panel gains `Box size` (`small · 2 vCPU · 4 GiB`) once the task has a box; `Runner` was there. The reasons milestones 3 and 4 already word in their own blocks (services, a provider, an installation, no key) keep them.
  - `m1/task-new`: the picker reads `A pool` and `Your machine <name>`. `A pool` shows the project's pools and, when it would wait, `Waits: <reason>`; it is disabled only for a project with no pool. A machine that can't take the task (offline, no services, the provider not allowed on personal runners) is disabled with its reason; a busy one stays pickable with `busy (2 of 2): it waits its turn`, as the demo's step 8 sends a third task to it. The properties panel gains `Box size`: the project's default on a pool, `Your machine counts slots: no size applies` on a machine.
  - `m3/environment-services`: the snapshot group's `Built on` names the builder (`k8s-east, BuildKit`) and `Image` gives the registry's reference by digest, or `Kept on <runner>: no registry set`.
  - `m3/agent-profile`: built in ticket 32.
- Decisions:
  - Default choice (target `m1/task-new` says "A pool" by default): "A pool" when one of the project's pools can take the task now; else the member's first machine that can; else "A pool", where it queues. A fresh install whose only runner is the admin's machine keeps milestone 1's first-task flow.
  - Registry open points: 1, a `docker` pool pulls with the push credential when no pull credential is set or the cluster's identity is chosen (the page says so); 2, "Check" is disabled with unsaved changes; 3, nothing about pruning.
  - The address accepts `http://` only for `localhost` and `127.0.0.1` (the dev registry); `https://` pasted in is dropped. The prefix is sent without its trailing `/`, as `setRegistry` stores it.
  - The check's result arrives by the organization's change notice, which now refreshes `registry` and `registryUse` (`apps/web/src/task/change-scopes.ts`); no polling.
  - "pull-only" on the pull credential's row isn't shown: the check answers for the push credential's rights, not the pull credential's.
