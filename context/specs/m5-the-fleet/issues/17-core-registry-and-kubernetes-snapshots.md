# 17: Core: the registry, and snapshots for `kubernetes` pools

Status: done
Builder: core
Blocked by: 05, 06
Features: F-120, F-051 (grown), F-093
Packages: `apps/core` (`src/registry/` (new), `src/snapshots/`, `src/dispatch/endpoints.ts`), `packages/domain` (`setRegistry`, `checkRegistry`, `issuePullCredential`, `issuePushCredential`)
Spec: `../spec.md`, section 4 ("A snapshot with a registry"); ADR 0060, ADR 0038

## What to build

- **`setRegistry`:** the URL, prefix, auth kind and the two credentials, stored in the secret store (the values never in a row), with `registry.set` in the audit log and a `registry.check` job.
- **`registry.check`:** core's own HTTP calls to the OCI distribution API (`/v2/`, the token flow, a push scope on `<prefix>/` checked by starting and cancelling an upload, and a pull scope checked on the seeded or any existing manifest). No image is pushed. The result is stored with the time.
- **Snapshots:** milestone 3's `snapshot.schedule` sends a build to a `docker` runner of the project's pools (as before) or, for a project whose pools include a `kubernetes` pool, to that pool's runner with `builder: "buildkit"`; with a registry set, the command carries `push.ref`. `snapshot.built` with a digest marks it ready and `pushedAt`. A `kubernetes` pool without a registry builds nothing, and its tasks wait with `needs-registry` (ticket 14).
- **Credentials:** `POST /runner/v1/snapshots/:id/push-credential` answers the push credential to the runner the build was given to, while it's `building`; `POST /runner/v1/tasks/:taskId/pull-credential` answers the pull credential to the runner holding the task's current lease when its spec names an image. Each issuance is one audit entry (`registry.credential-issued`, milestone 4's rule for credentials). With `auth: "node"` there's no pull credential and the box's pod uses the node's identity.
- **The spec's image:** the dispatch names the project's ready snapshot by digest when the chosen runner pulls from the registry.

## Done when

- [x] Tests against the fake OCI registry, named for `F-120`: the check's three results (both allowed, pull only, refused); the push credential to the builder only and only while building; the pull credential to the lease holder only and refused with a stale epoch; a `kubernetes` pool's task waiting without a registry; a `docker` host without one still building its own (milestone 3's test kept).
- [x] Break-it: answering the pull credential to any runner of the organization fails its test; recorded in `context/proof/F-120.md`.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add the snapshot registry`.

## Comments

- 2026-11-20: built. `setRegistry`, `checkRegistry`, `issuePushCredential` and `issuePullCredential` in `packages/domain/src/use-cases/registry.ts`; the `registry.check` job, its probe (core's own `fetch` calls to the distribution API: `/v2/`, the token flow, an upload started and cancelled, an existing manifest or the tag list) and the two credential endpoints in `apps/core/src/registry/`. `planSnapshotBuild` (domain's `snapshots.ts`) replaces the build's runner pick: with a registry, a `kubernetes` runner with `builder: "buildkit"`, else a `docker` runner at minor 4, each with `push.ref`; without one, milestone 3's `docker` path. The dispatch names the ready pushed snapshot (`box.image`, by digest) to a runner whose executor pulls from the registry, and the box row keeps `imageRef` and `imageDigest`. Tests in `apps/core/src/registry/registry.test.ts` (eight, F-120) against ticket 06's fake OCI registry, bearer and Basic; milestone 3's `snapshots.test.ts` passes unchanged. Break-its: dropping the lease's `runnerId` from the pull credential's check (the other runner got 200), dropping the builder check from the push credential's, and collapsing the probe's pull-only into push-and-pull each failed their test; recorded in `context/proof/F-120.md`. Departures: the check's result for a registry that refuses the pull is `refused` whatever the push did, as the three results allow; a `node` registry answers the pull credential with `no-image` (the protocol's refusal codes have no other), and a stale `registry.check` writes what it finds for the row as it is now. Decisions of today: none applies here (one organization per install doesn't change the per-organization rows). Commit: 6b90768e.
