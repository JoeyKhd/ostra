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

## Comments
