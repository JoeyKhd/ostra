# 28: API: the registry

Status: ready-for-agent
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

- [ ] Tests named for `F-120`: as an admin, a member and another organization's admin; no credential's value in any answer or error; a kept credential when left out; the check queued once per settings' version.
- [ ] Committed as `✨ add the registry to the API`.

## Comments
