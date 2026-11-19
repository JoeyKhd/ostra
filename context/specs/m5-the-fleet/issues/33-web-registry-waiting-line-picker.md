# 33: Web: the registry, the task's waiting line and the runner picker

Status: ready-for-agent
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

- [ ] Playwright, named for `F-067`, `F-069` and `F-120`: each wait reason's sentence for a seeded task; the picker's disabled reasons; the registry's check result; no credential's value in the page's HTML.
- [ ] Committed as `✨ add the registry and the waiting line`.

## Comments
