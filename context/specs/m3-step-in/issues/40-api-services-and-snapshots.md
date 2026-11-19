# 40: API: services and snapshots

Status: done
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

- [x] Tests: service and check edits by a project admin only, secrets stored as refs and never returned, a change queues one snapshot build, the snapshot state reads back, the "no runner can start services" flag; another organization's environments are invisible.
- [x] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `api`.
- [x] Committed as `✨ add services and snapshots to the API`.

## Decided 2026-11-19

Decided on the maintainer's delegation while preparing the build, from the open points of the milestone 3 targets (`context/brand/app-targets/m3/`) and the spec's gaps. If the maintainer disagrees with one, it goes back to `context/open-questions.md` and this section changes.

- **`environments.get` adds** (`environment-services.md`, "Data"): the project's pool names, the count of online runners that can start services, and the executors online, so the runner note and "Where tasks run" stay. Per service, its last box's runner name and time, and a failed service's reason, read from `service.healthy` and `service.failed`. The snapshot's duration from `Snapshot.buildDurationMs` (ticket 06).

## Comments

- 2026-11-19, api: done in `✨ add services and snapshots to the API`. In `packages/api/src/routers/environment-services.ts`, mounted on `environments` as `services`, `checks` and `snapshot`; reads are for anyone who can open the project, writes for project admins. **Services:** `list` (by name; each variable plain, or a secret as `{ kind: "secret", set: true }`, never its value or reference; `lastBox` from the project's newest `service.healthy` or `service.failed` for that name: `healthy` with `afterMs`, `failed` with the runner's reason, or `started` for a service with no health check, with the runner's name and the time), `save` (new or by `serviceId`; a secret's value goes to the secret store first, a secret saved without a value keeps its reference, and the references a save replaced are deleted after it commits; the name is unique in the environment, `CONFLICT` "A service with that name exists."; the image is checked as `docker pull` takes it, "An image like postgres:17."; at most `servicesMax`) and `delete`; each change enqueues `snapshot.schedule` (`environment-changed`), with an audit entry and a change notice. **Checks:** `list` (in order, `position` from 1, the repo's name or `null` for the workspace root), `save` (a new one goes last; the repo must be the project's; timeout 1 s to `checkTimeoutMaxSeconds`), `reorder` (every check once) and `delete`; no snapshot build, since the image doesn't hold them. **Snapshot:** `get` returns `kind` (`host-cache` when every runner of the project's pools uses `host`), `hostInstead`, `ready` (built when, duration from `Snapshot.buildDurationMs`, the runner's name, the digest, the reason, the scan), `pending` (queued or building, since when, on which runner), `lastFailure` (the newest failure since the ready one, with its reason and detail from `snapshotFailureFromDb`) and `waitingForDockerRunner`; `requestedBy` names who pressed Rebuild, from its audit entry (`environment.snapshot-rebuild-requested`). `rebuild` enqueues `snapshot.schedule` with ticket 26's `rebuild` reason. **`environments.get`** adds `whereTasksRun` (the decided data): the project's pools by name (its own, else the default pools, as the dispatch reads them), `servicesRunnersOnline` (online runners of those pools and the member's own personal runners that `runnerStartsServices`), `executorsOnline`, `poolExecutors` (the pools' runners, online or not), the service count and `noServicesRunner`. **`environments.save`** now enqueues `snapshot.schedule` (`environment-changed`) in its transaction, ticket 26's environment trigger. Tests: `packages/api/src/routers/environment-services.test.ts`, six cases. Break-it checks: eleven (a member saving a service, a secret's reference read back as a value, no build on a service's change or an environment's save, a new check put first, the minor-2 rule, a building snapshot left out, the wrong audit action for who rebuilt, the replaced secret kept, the host-cache kind, every healthy service read as started), each failing its case. Proof: `context/proof/F-094.md`, `F-051.md` and `F-054.md`, the rows `partial` until the page (ticket 48) and the `docker` executor (ticket 14).
