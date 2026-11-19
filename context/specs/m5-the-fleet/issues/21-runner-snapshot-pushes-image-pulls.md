# 21: Runner: snapshot pushes and image pulls

Status: ready-for-agent
Builder: runner
Blocked by: 08, 09, 17
Features: F-120, F-051 (grown)
Packages: `apps/runner` (`src/snapshots.ts`, `src/box-dispatcher.ts`)
Spec: `../spec.md`, section 4 ("A snapshot with a registry"); ADR 0060, ADR 0038

## What to build

- **A build with a push:** on `snapshot-build` with `push`, the runner fetches the push credential for that snapshot, runs the executor's `buildSnapshot` (`docker` on the host, `buildkit` on a cluster), reports `snapshot.built` with the digest or `snapshot.failed` with the reason, and forgets the credential. A scan hit pushes nothing (ADR 0038).
- **A box from the registry:** when the dispatch's `box.image` is set, the runner fetches the pull credential for that task's lease, hands it to the executor's `create` (`docker` pulls with it; `kubernetes` puts it in the box's pull secret), and keeps it nowhere. With `auth: "node"` there's none to fetch.
- **No registry** keeps milestone 3's path: a `docker` runner builds and keeps its own.

## Done when

- [ ] Tests against the fake engine, the fake API and the fake registry, named for `F-120`: a push only after a clean scan, with the push credential; a pull with the pull credential, which is in no file of the runner's data folder afterwards; `node` auth fetching nothing; the local path without a registry.
- [ ] Break-it: writing the pull credential to the runner's state file fails its test; recorded in `context/proof/F-120.md`.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ push snapshots and pull boxes' images`.

## Comments
