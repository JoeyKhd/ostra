# 20: Runner: `kubernetes` boxes and the task token's secret

Status: ready-for-agent
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

- [ ] Tests against the fake API, named for `F-093` and `F-015`: the offer accepted before the pod is scheduled; the waiting and scheduled events; the sidecar connected on its task token in process mode while the runner restarts; the runner adopting its pods; nothing left after release.
- [ ] Break-it: accepting only after scheduling makes a 3-minute unschedulable pod time out the offer and fails its test; recorded in `context/proof/F-093.md`.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ run kubernetes boxes from the runner`.

## Comments
