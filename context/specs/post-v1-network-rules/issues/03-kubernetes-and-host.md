# 03: The same proxy in a pod and on `host`, and the differences said out loud

Status: ready-for-agent
Builder: runner
Blocked by: 01, 02
Features: F-052 (c4, c5)
Packages: `apps/runner` (the task host's base-environment overlay and its tests), `packages/adapters/adapter-executor-host` (`src/process.ts`, `src/host-executor.ts`, its test), `packages/adapters/adapter-executor-kubernetes` (`src/pod.ts` for the sidecar's `OSTRA_EGRESS_ALLOW`, and its contract test — **no policy change**)
Spec: `../spec.md`, sections 1, 5.3 and 6; ADR 0073; ADR 0029 (fourth and fifth differences)

## What to build

- **`kubernetes`:** the proxy starts in the pod's sidecar from ticket 02 with two changes — the listen host (loopback, the pod's shared `localhost`) and the sidecar container's `OSTRA_EGRESS_ALLOW` in `pod.ts` — and the task's environment reaches it at `http://127.0.0.1:<port>`. **The chart's policy and the executor's `health()` are not touched**: the runner must not gain the right to write a NetworkPolicy (ADR 0060), and no per-box policy is generated.
- **`host`:** the runner process starts the same proxy for a task whose environment has rules, and the agent's processes, setup and checks get the variables from the overlay. This is the same code path as the sidecar's; the executor's `baseEnv` overlay is where the variables enter.
- **The recorded difference made testable:** the probe helper's per-executor expectation is threaded through so the executor contract suites assert what each executor is, not a shared fiction:
  - `docker`'s suite: the same destination without the proxy is `blocked`;
  - `kubernetes`'s suite: without the proxy it is `reachable` (the pod's direct egress, ADR 0029's fourth difference) — this is the assertion that stops a future change from claiming containment it doesn't have;
  - `host`'s suite: the proxy filters the same way, and the runner reports no containment for it; the suite asserts the variables are present and, in the unit test, that a process started without them is not blocked (an honest "nothing enforces it", not a fake).
- **The words' facts** (the panel's sentences are ticket 04's): make sure the three facts the panel and docs will state are each one assertion in these suites — enforced on `docker`; bypassable on `kubernetes`; advisory on `host`.

## Done when

- [ ] Tests named for `F-052/c4`: in the `kubernetes` executor's suite, a pod's agent gets the proxy variables and an allowlisted request succeeds through the proxy; a request with `--noproxy '*'` to a non-allowlisted public destination is `reachable` (the recorded difference), and the executor's capability/health surface is unchanged (no NetworkPolicy call is made — asserted against the fake API).
- [ ] Tests named for `F-052/c5`: in the `host` executor's suite, the agent's environment holds the proxy variables when the environment has rules and none when it doesn't; a program started with the agent's environment resolves an allowlisted host through the proxy; the executor's "not isolated" declaration is what the suite reads, and no test claims containment.
- [ ] The `docker` suite's counterpart of c2/c4 (a `--noproxy '*'` request is `blocked`) is present, so the three suites can't drift apart.
- [ ] No change to `packages/adapters/adapter-executor-kubernetes/src/egress.ts` or `deploy/helm/ostra-runner`; the `baselineProblem`/`health()` tests stay green.
- [ ] Checks for `apps/runner`, `packages/adapters/adapter-executor-host` and `packages/adapters/adapter-executor-kubernetes` pass.
- [ ] Committed as `✨ offer network rules on kubernetes and host`.

## Comments
