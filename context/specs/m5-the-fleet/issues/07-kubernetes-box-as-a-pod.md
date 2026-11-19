# 07: Kubernetes executor: a box as a pod

Status: done
Builder: adapters
Blocked by: 02, 06
Features: F-093, F-015, F-095
Packages: `packages/adapters/adapter-executor-kubernetes` (`src/kubernetes-executor.ts`, `src/pod.ts`, `src/kube-api.ts`)
Spec: `../spec.md`, sections 4 ("A box on `kubernetes`") and 11, items 7 and 8; ADR 0060, ADR 0029

## What to build

- **`KubernetesExecutor extends ExecutorAdapter`,** one level deep (ADR 0025), with capabilities `isolation: "container"`, `services: true`, `boxSizes: true`, `snapshots: true`, `registry: "required"`, `nodeWait: true`, `processContainment: "container"`.
- **A port, `KubeApi`,** over `@kubernetes/client-node`, with only the calls the executor makes (pods, secrets, events, quotas, version), so unit tests can also use a small in-memory double. The integration tests use ticket 06's fake API over HTTP.
- **`health()`:** the API answers, the version is 1.29 or later (refused below with "This cluster runs Kubernetes 1.28; ostra's boxes need 1.29 or later for native sidecars"), the namespace exists, the service account may do what the executor does there and nothing is asked of other namespaces.
- **The pod,** built as a typed value, never from a string template (spike 3's `box-pod.yaml` ported): the agent as the main container with the box size as its requests and limits; the sidecar first among the init containers with `restartPolicy: Always`, its own fixed limits and the task token's secret as its only secret volume; the bridge on the pod's loopback with its nonce; `automountServiceAccountToken: false`, `enableServiceLinks: false`, no host namespaces, `RuntimeDefault` seccomp, dropped capabilities as the spike had them; the optional `runtimeClassName`; labels `ostra.dev/role: box`, the box, the task and the organization.
- **The secrets:** one per box for the task token and the bridge nonce, and one `kubernetes.io/dockerconfigjson` pull secret when the image has a pull credential. Each is deleted with the pod, and the executor's release deletes anything left by label.
- **The lifecycle:** `create` makes the secrets and the pod and returns when the pod exists; `prepare` waits for the sidecar's readiness; `stop` and `release` both delete the pod (a stopped pod is never kept, ADR 0039); `state` maps the pod's phase and conditions to `BoxState`.
- **`capacity()`:** slots from `OSTRA_RUNNER_SLOTS`, CPU and memory from the namespace's `ResourceQuota` minus what its pods request, or from the runner's settings when there's no quota.

## Done when

- [x] Tests: the executor contract suite passes against the fake API, its live part waiting for ticket 35; the pod's shape is asserted field by field (named for `F-093` and `F-095`); the task token is in the sidecar's volume and in no other container's environment, volumes or arguments (named for `F-015`); a 1.28 cluster is refused; every object is gone after release; nothing outside the namespace was touched.
- [x] Break-it: mounting the token's secret into the agent's container fails `F-015`'s test; recorded in `context/proof/F-015.md`.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add the kubernetes executor's boxes`.

## Comments

- 2026-11-19: built in `✨ add the kubernetes executor's boxes` (7c52e7db). `KubernetesExecutor` makes a box's secret (the task token and the bridge's nonce), its `dockerconfigjson` pull secret and its pod (`pod.ts`, typed values) through the `KubeApi` port (`kube-api.ts`, over `@kubernetes/client-node`); the secrets are made the pod's dependents, and release deletes the pod and everything left with the box's label, then waits until the pod is gone. Tested against ticket 06's fake API (`kubernetes-executor.test.ts`), and the executor contract suite passes on a pod in the fake cluster's process mode (`kubernetes-executor.contract.test.ts`), where the test plays the sidecar. Choices: (1) on a pool runner the task's own calls (`startAgent`, `commitAndPush`, the checks, the workspace) answer `unsupported`, since the pod's sidecar runs them (ticket 20); the `inBox` option gives them to the sidecar's executor through the bridge, which is how the contract suite runs. (2) `capacity()` offers the namespace's ResourceQuota less what its *other* pods request, not ostra's boxes, which core subtracts from its rows (ticket 05's note); without a quota it offers the runner's settings, or no limit but the slots. (3) `Unschedulable` without a `TriggeredScaleUp` waits `scaleUpGraceMs` (30 s) before `no-room`, since an autoscaler posts its event seconds after the scheduler's; ticket 08 tests it. (4) `failureOf(box)` names `no-node`, `no-room` or `image-pull` for ticket 13's requeue. (5) Services are refused until ticket 08. `OSTRA_K8S_NAMESPACE`'s line now says the cluster must run 1.29 or later. Whole-repo typecheck and lint passed; the tests of the package, `protocol`, `docs` and `e2e-m5` passed; `domain`'s two docs-reference tests fail on `origin/main` already (`OSTRA_DEV_CORE_REPLICAS` from ticket 36), untouched by this ticket.
