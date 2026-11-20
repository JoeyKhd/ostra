# 28: API: the registry

Status: done
Builder: api
Blocked by: 17
Features: F-120
Packages: `packages/api` (`src/routers/registry.ts` (new), `src/routers/environments.ts`)
Spec: `../spec.md`, section 11, item 11

## What to build

- **`registry.get`:** the address, prefix, auth kind, whether each credential is set (never its value), the last check's result and time, the pools that need it, and the organization's snapshots in it with project, digest and when pushed.
- **`registry.set { url, repositoryPrefix, auth, push?, pull? }`** and **`registry.clear`**, admins only; a credential left out keeps the stored one. **`registry.check`** enqueues the check and returns at once.
- The environment's snapshot section returns the registry's reference and digest, the builder, and the runner it was built on.

## Done when

- [x] Tests named for `F-120`: as an admin, a member and another organization's admin; no credential's value in any answer or error; a kept credential when left out; the check queued once per settings' version.
- [x] Committed as `✨ add the registry to the API`.

## Comments

- 2026-11-20: built in `packages/api/src/routers/registry.ts` (new: `registry.get`, `set`, `clear`, `check`), `packages/domain/src/use-cases/registry-clear.ts` (new: `clearRegistry`) and `environment-services.ts` (the ready snapshot's `registry`, `builder` and `runnerId`). Tests: `packages/api/src/routers/registry.test.ts`; proof row in `context/proof/F-120.md`. Decisions:
  - Every procedure is for organization admins, `get` too: it lists every project's snapshots, restricted ones included. Another organization's admin reads and changes their own registry only.
  - The settings' version is the row's `updatedAt`. `setRegistry` (ticket 17) now writes it as the time its own `registry.check` is queued with, so the set's check and an admin's "Check" for the same settings share one job key; a check asked for while one is queued joins it.
  - `registry.clear` is new (the ticket names it, and ticket 17 had no use case for it): in one transaction the snapshots it held stop naming it, the row goes and `registry.cleared` (a new audit action) is recorded; its two credentials are deleted from the secret store after the commit. The images stay in the registry, which the organization owns. With no registry, a `docker` host builds its own snapshots again and a `kubernetes` pool's tasks wait with `needs-registry`.
  - "The pools that need it": pools with a runner (not revoked) whose capabilities say `registry: required`, or a `kubernetes` runner that hasn't reported them.
- 2026-11-20: commits 11ba61b2 (`🐛 version the registry check by its row's time`) and e54a8979 (`✨ add the registry to the API`).
