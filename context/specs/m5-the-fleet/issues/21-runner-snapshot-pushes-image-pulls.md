# 21: Runner: snapshot pushes and image pulls

Status: done
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

- [x] Tests against the fake engine, the fake API and the fake registry, named for `F-120`: a push only after a clean scan, with the push credential; a pull with the pull credential, which is in no file of the runner's data folder afterwards; `node` auth fetching nothing; the local path without a registry.
- [x] Break-it: writing the pull credential to the runner's state file fails its test; recorded in `context/proof/F-120.md`.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ push snapshots and pull boxes' images`.

## Comments

- 2026-11-20: built.
  - **Credentials:** `fetchPullCredential` and `fetchPushCredential` (`apps/runner/src/task-host/server-link.ts`) ask core's endpoints from ticket 17 with the runner's access token, one per lease or per build. Each is handed on at once and kept nowhere: never in a file, an event or a log line.
  - **`docker`** (`apps/runner/src/box-dispatcher.ts`): a dispatch's `box.image` is pulled by digest with the lease's pull credential, in the Engine's pull call only, and wins over a snapshot this host keeps. Its `box.size` goes to the agent's container as limits; no ticket wired the runner's half of ticket 09's sizes, so it's done here. A `snapshot-build` with `push` fetches the push credential and passes it to `buildSnapshot`, which pushes only after the scan passed. A scan hit pushes nothing. `snapshot.built` carries the registry's digest, which boxes pull by. Without `push`, milestone 3's path: build and keep, ask for nothing.
  - **`kubernetes`** (`apps/runner/src/kubernetes-dispatcher.ts`): the pull credential goes to the box's pull secret only. A build with `push` runs on rootless BuildKit through the executor, with its credentials and its push credential. Without a registry it's refused (`not-supported`): core never sends one (ticket 17).
  - **Departure: `node` auth.** The dispatch doesn't say how the registry authenticates, and core answers the pull-credential request `409 no-image` when it's `node` (ticket 17). So the runner asks, reads `no-image` as "no credential", and pulls with none: the pod has no pull secret. It still makes one request, where the text says "fetching nothing".
  - **Tests:** `apps/runner/src/registry-images.test.ts` (the fake Engine with the real `createDockerSnapshots` and a stand-in build, and a fake server that issues the credentials as core does) and two cases in `apps/runner/src/kubernetes-dispatcher.test.ts` (the fake API; the build in process mode with ticket 08's stand-in BuildKit and ticket 06's fake OCI registry). Milestone 3's `box-dispatcher-m3.test.ts` is kept.
  - **Break-its,** each failing its test: the pull credential written to `state.json` in the runner's data folder; kept beside a `kubernetes` box's record; the push dropped; `no-image` read as a failure; a push with another credential.
