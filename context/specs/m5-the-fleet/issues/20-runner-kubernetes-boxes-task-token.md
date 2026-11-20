# 20: Runner: `kubernetes` boxes and the task token's secret

Status: done
Builder: runner
Blocked by: 07
Features: F-093, F-015
Packages: `apps/runner` (`src/box-dispatcher.ts`, `src/run-sidecar.ts`, `src/run-runner.ts`)
Spec: `../spec.md`, section 4 ("A box on `kubernetes`"); ADR 0060, ADR 0034 ("The task token")

## What to build

- **The offer on `kubernetes`:** accepted at once (ADR 0029), then the task token fetched with the lease epoch, then the executor's `create` with it, the size and the image. `onWaiting` becomes `box.waiting`, scheduling `box.scheduled`.
- **The sidecar in a pod:** `ostra` in its internal mode reads the task token from its mounted file, connects to the server on its own, and finds the agent's bridge on the pod's loopback with the nonce from its secret. A restart of the pool runner leaves the pod and its sidecar running; the runner, on start, lists its pods by label and adopts them.
- **Release:** after `stop` or `release`, the executor deletes the pod and its secrets; the runner checks by label that nothing of the box is left and logs the count.
- **The fake cluster's process mode** runs this path on this machine (ticket 06), which the demo's step 12 uses.

## Done when

- [x] Tests against the fake API, named for `F-093` and `F-015`: the offer accepted before the pod is scheduled; the waiting and scheduled events; the sidecar connected on its task token in process mode while the runner restarts; the runner adopting its pods; nothing left after release.
- [x] Break-it: accepting only after scheduling makes a 3-minute unschedulable pod time out the offer and fails its test; recorded in `context/proof/F-093.md`.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ run kubernetes boxes from the runner`.

## Comments

- 2026-11-20: built.
  - **The runner:** `ostra runner --executor kubernetes` (`OSTRA_RUNNER_EXECUTOR` gains `kubernetes`) reads its cluster from its pod's service account, or `KUBECONFIG` (development: `pnpm dev:fake-kube`), with `OSTRA_K8S_NAMESPACE`, else the service account's or the kubeconfig's namespace (`apps/runner/src/kubernetes-cluster.ts`). It refuses to start when the executor's `health()` says no (a cluster under 1.29, a missing namespace or role, no egress baseline).
  - **The offer:** `apps/runner/src/kubernetes-dispatcher.ts` accepts at once, then fetches the task token with the lease epoch and calls `create` with the size, the image (with its pull credential, ticket 21's half) and the token, then `prepare` until the sidecar is ready. `onWaiting` becomes `box.waiting` and `box.scheduled`.
  - **Departure: how those events travel.** They go in `runner-event` frames, not the task's session. The sidecar holds the session once it runs, and two writers would number the same session twice. Minor 4 adds both kinds to `runnerScopedEventKinds`, and a minor-3 parser refuses them. Core records them (`apps/core/src/dispatch/box-waits.ts` → `recordBoxWaitInTx` in `packages/domain/src/use-cases/box-wait.ts`): the box's `waitingReason`, `waitingSince` and `scheduledAt` (it stays `creating`), and the event on the task's timeline (`coreRecordedKinds`). Only the box's own runner moves it, and a repeat changes nothing.
  - **A restart:** each box the runner made is a file of IDs (`<dataDir>/kubernetes-boxes/<boxId>.json`, never the token). At start the runner lists the namespace's box pods and adopts the ones it made; a pod whose task ended meanwhile is released. A stopping runner detaches and leaves its pods.
  - **Release:** when the pod's sidecar ends, or on `release` (at once, even while the pod waits for a node), the executor deletes the pod and its secrets; the runner lists what's left by the box's label and logs the count.
  - **Tests:** `apps/runner/src/kubernetes-dispatcher.test.ts` against ticket 06's fake API. In process mode the sidecar is the real `ostra sidecar` (this checkout's `main.ts`) and the init the real one; it connects on its mounted token, and the runner restarts and adopts its pod while the sidecar's connection stays. Also `apps/core/src/dispatch/box-waits.test.ts` over the real gateway, and the minor-4 frame test. Break-its, each failing its test: answering the dispatch only after the box's life; dropping `onWaiting`'s report; adopting nothing; leaving the pod on release; dropping the runner check and the repeat check in `recordBoxWaitInTx`.
  - **Not done here:** a k8s box's services get their plain variables only (the executor's pod), not their secret ones, which `docker`'s dispatcher fetches with the task token.
