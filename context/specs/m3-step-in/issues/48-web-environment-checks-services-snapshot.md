# 48: Web: the environment's checks, services and snapshot

Status: ready-for-agent
Builder: web
Blocked by: 40, 41
Features: F-054, F-094, F-051
Packages: `apps/web` (`components/projects/environment-view.tsx`, `components/projects/environment-services.tsx` (new))
Spec: `../spec.md`, section 12 (`environment-services`; and `m1/environment` growing)

## What to build

- **Checks** in the environment (`environment-services`): the list with order, command, repo and timeout; add, edit, reorder, delete.
- **Services:** the list with image, port, variables (secrets as "set"), health check and health on the last box; add, edit, delete; the note that `host` runners start no services, and the warning when no runner that can is online.
- **The snapshot:** on `docker`, the state, when and where it was built, the last failure's reason, "Rebuild"; on `host`, "worktree and dependency cache".
- A task's dispatch note ("needs a runner that can start services") on the task page, from milestone 1's dispatch note field.

## Done when

- [ ] The screens match their targets, checked by eye, with the differences recorded here.
- [ ] Playwright: a check and a service saved, the "no runner can start services" warning with only a `host` runner online, a task in that project waiting with the note.
- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `web`.
- [ ] Committed as `✨ add the environment's services and checks`.

## Comments
