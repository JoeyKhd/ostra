# 08: Kubernetes executor: services, BuildKit snapshots, the egress policy, waiting for a node

Status: done
Builder: adapters
Blocked by: 07
Features: F-093, F-120, F-116, F-094 (its `kubernetes` half), F-051 (its `kubernetes` half)
Packages: `packages/adapters/adapter-executor-kubernetes` (`src/services.ts`, `src/snapshots.ts`, `src/egress.ts`, `src/waiting.ts`)
Spec: `../spec.md`, sections 4 and 11, items 9 and 10; ADR 0060, ADR 0038

## What to build

- **Services** as native sidecars after the sidecar, each with its image, variables, port, health check as a readiness probe and its own limits (`OSTRA_SERVICE_*` when it declares none), reachable from the agent on `localhost:<port>` and by name through a `hostAliases` entry for each, so the environment's names work as on `docker`.
- **Snapshots:** `buildSnapshot` starts a rootless BuildKit pod in the build namespace (spike 3's `buildkit-rootless.yaml` and `build-rootless.sh`, ported), with the setup secrets as a secret volume for the build only, exporting to an OCI tarball on the pod's volume; the scan (milestone 3's, before any push) runs on that tarball in the sidecar of the build pod; only a clean image is pushed with the push credential, and the digest comes back. The build namespace has its own NetworkPolicy: the registry and the package hosts the environment names, and nothing else (ADR 0038). The BuildKit settings spike 3 couldn't justify (`Unconfined` seccomp and AppArmor, `--oci-worker-no-process-sandbox`) are each behind a named switch, off unless a live run shows it's needed, and listed for milestone 7's security review.
- **The egress policy:** `health()` checks that the namespace has the baseline NetworkPolicy (the runner chart's, ticket 23) and refuses to start boxes without it, with the fix; the executor never writes it itself. The policy's one exception is the server's address and DNS, plus `OSTRA_EGRESS_ALLOW` (ADR 0060).
- **Waiting for a node:** the runner's watch on the pod's `PodScheduled` condition and its events: `Unschedulable` with a `TriggeredScaleUp` event calls `onWaiting("node")`; a pull in progress past 10 s calls `onWaiting("image-pull")`; scheduling calls it off with how long it took. Past `OSTRA_K8S_NODE_WAIT_MINUTES` the box fails as `no-node`, which core treats as a requeue (ticket 13), not a crash. Without a scale-up event, `Unschedulable` fails the box at once as `no-room`.

## Done when

- [x] Tests against the fake API, named for `F-093`, `F-120` and `F-116`: a box with two services has them as native sidecars in order; the build pod's shape, its namespace and its egress policy; a scan hit pushes nothing; the waiting reasons and their timeout; `health()` refuses a namespace without the baseline policy.
- [x] Break-it: removing the scale-up check makes an unschedulable pod wait forever and fails its test; recorded in `context/proof/F-093.md`.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add kubernetes services, builds and waits`.

## Comments

- 2026-11-19: built in `✨ add kubernetes services, builds and waits` (this commit). Services are native sidecars after the sidecar, with `hostAliases` for their names, and the pool runner's `prepare` reports their health. `buildSnapshot` runs a pod in the build namespace: a context step, rootless BuildKit exporting an OCI tarball (no push, no registry credential), the scan, then a push step that alone mounts the push credential, so a scan hit ends the pod before any push; the push is this package's own distribution-API client (`oci.ts`, Basic or bearer). `health()` refuses a namespace without the egress baseline (a policy selecting the boxes and carving out the private ranges and the metadata address), and a build refuses a build namespace without its policy; `baselineEgressPolicy` and `buildEgressPolicy` are the typed values ticket 23's chart renders. Tested against the fake API, its process mode (the build pod runs this package's steps, a stand-in BuildKit and ticket 06's fake registry), and the port's in-memory double with a clock the test moves for the waits. Choices and what's left: (1) the steps run as `ostra internal build-step <step>` in the runner image; `build-main.ts` is the entry, and ticket 21 or 22 routes the CLI to `runBuildStep`. (2) BuildKit's three unjustified settings are the executor's `buildkitSwitches`, all off; making them runner settings waits for a live run that needs one (ticket 35). (3) `Unschedulable` without a scale-up fails as `no-room` after a 30 s grace, not on the first look, because a real autoscaler posts `TriggeredScaleUp` seconds after the scheduler's `FailedScheduling`. (4) A pull failure (`ErrImagePull`, `ImagePullBackOff`) fails the box as `image-pull`, a service's included, since a native sidecar that never starts holds the agent back. (5) A service's secret variables aren't in `create`'s input, so a pod's services get their plain variables only until ticket 20 passes them; and a box's in-pod sidecar learns the services' health from the runner (ticket 20), since on `kubernetes` the pool runner can't write the `docker` services file. Whole-repo typecheck and lint passed, and the package's tests.
