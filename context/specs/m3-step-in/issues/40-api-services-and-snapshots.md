# 40: API: services and snapshots

Status: ready-for-agent
Builder: api
Blocked by: 26, 27
Features: F-094, F-051, F-054 (the checks list)
Packages: `packages/api` (`routers/environments.ts`)
Spec: `../spec.md`, section 4 ("Snapshots", "Services"); ADR 0038 (amended)

## What to build

- **Services:** `environments.services.list`, `.save`, `.delete` (project admins): name, image, port, variables (each a plain value or a secret written to the secret store), health check. A change enqueues `snapshot.schedule`. The list returns each service's health on the project's last box that ran it.
- **Checks:** `environments.checks.list`, `.save`, `.reorder`, `.delete`: name, command, repo (or the workspace root), timeout.
- **Snapshot:** `environments.snapshot.get`: the ready snapshot (built when, by which runner, its digest), the one building, the last failure with its reason, and for `host` runners "worktree and dependency cache"; `environments.snapshot.rebuild` queues a build (project admins).
- **Where a task can run:** `environments.get` says when the environment has services and no runner that can start them is online in the project's pools.

## Done when

- [ ] Tests: service and check edits by a project admin only, secrets stored as refs and never returned, a change queues one snapshot build, the snapshot state reads back, the "no runner can start services" flag; another organization's environments are invisible.
- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `api`.
- [ ] Committed as `✨ add services and snapshots to the API`.

## Decided 2026-11-19

Decided on the maintainer's delegation while preparing the build, from the open points of the milestone 3 targets (`context/brand/app-targets/m3/`) and the spec's gaps. If the maintainer disagrees with one, it goes back to `context/open-questions.md` and this section changes.

- **`environments.get` adds** (`environment-services.md`, "Data"): the project's pool names, the count of online runners that can start services, and the executors online, so the runner note and "Where tasks run" stay. Per service, its last box's runner name and time, and a failed service's reason, read from `service.healthy` and `service.failed`. The snapshot's duration from `Snapshot.buildDurationMs` (ticket 06).

## Comments
