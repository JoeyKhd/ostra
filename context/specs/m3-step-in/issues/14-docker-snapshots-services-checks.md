# 14: Docker executor: snapshots, services and checks

Status: ready-for-agent
Builder: runner
Blocked by: 05
Features: F-051, F-094, F-054
Packages: `packages/adapters/adapter-executor-docker`
Spec: `../spec.md`, sections 1 ("On this machine"), 4 ("Snapshots", "Services") and 5.2; ADR 0038 (amended)

## What to build

Written in full with unit tests on the fake engine. The live run waits for a Linux machine with Docker (`build-order.md`).

- **`buildSnapshot`:** generate the Dockerfile (port `spikes/what-is-inside-a-box/src/snapshot/dockerfile.ts`): the base image, each repo's checkout at the workspace path, the setup script, with every setup secret as a BuildKit secret mount for that step only. Tag it `ostra-snapshot/<projectId>:<snapshotId>` in the host's own Docker; no push (F-120 is milestone 5).
- **The scan before use** (port `src/snapshot/image-scan.ts` with its negative control): export the image's layers and search each for every setup secret's value, raw and base64; a hit fails the build with `secret-found`, deletes the image, and names the secret, never its value. The negative control (a planted value) runs in the tests.
- **A box from a snapshot:** `create` with `snapshot.kind: "image"` starts the agent's container from it, with no mount over the workspace (Q153), then fetches the task's branches and runs the incremental install; without a ready snapshot it falls back to milestone 1's full setup and says so in an event.
- **Services:** each as a container on the box's private network, named by the service's name, with its variables (secrets from the credentials endpoint after the lease check), its port and its health check polled until healthy or until 120 s *(working value)*; `service.healthy` and `service.failed` events; removed with the box. The egress baseline (F-116) applies to them as to the box.
- **`runChecks`:** `docker exec` in the agent's container as the agent's user, in each check's repo folder (or the workspace root), with the timeout, and the output written to a file the runner uploads.
- **`hasSnapshot`** reads the local image by tag and digest.

## Done when

- [ ] Tests: against the fake engine, the generated Dockerfile for a two-repo environment with a setup secret, the scan finding the planted value and passing a clean image, a box created from a snapshot with no mount over the workspace, services started and torn down, checks run with their timeouts.
- [ ] The live tests exist, gated on a Docker host, and are listed in ticket 50's "waits for Linux".
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add docker snapshots, services and checks`.

## Comments
