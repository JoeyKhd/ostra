# Milestone 5 demo: the fleet

Ticket 37 runs spec section 3 and records it here. The ledger rows it sets, and why each one stays where it is, are in `context/features.md`; the proofs are in `context/proof/`.

## The run of record: 2026-11-20, 12:04 to 12:28 UTC

`pnpm e2e:m5` (`e2e/m5-the-fleet/src/demo/demo.ts`), once, from an empty data folder, on the plan's Windows 11 machine (Node 24, no Docker, WSL or Kubernetes), in a worktree of `origin/main` at `9415a29a` plus this record's demo script. **69 of 69 checks passed in 24 minutes.** The result is [`demo/checks.json`](demo/checks.json), with each step's time in seconds.

How it ran, against section 3's "Before":

- **The stack:** the dev database, **three core replicas** and the panel, on the ports 3930 (web), 9530 (core, the replicas on the next ports) and 55130 (Postgres), started fresh by the script. Signed in as the default first admin (`OSTRA_ALLOW_DEFAULT_PASSWORD=true`), which chose its own password at once.
- **Milestones 1 to 4's setup** through their helpers: the failure suite's stub model as the organization's provider, the existing test GitHub App, projects `test1` and `test2`, `OST` attached to `test1`, Sam invited and joined. 90 s.
- **Ticket 36's dev tools:** the fake cluster in process mode, the OCI registry, the npm registry and the network proxies.
- **The CLI:** `pnpm --filter @ostra/runner pack:cli` packed `ostra-0.0.0.tgz`, and npm installed it from that tarball. **Every pool runner of the demo ran from that install**, on `host` with `OSTRA_DEV_HOST_POOL_SAME_USER=true`. Sam's personal runner ran from the clone (`pnpm ostra runner`), as the panel's "Your machine" tells a member to. The `host` executor needs OpenCode beside the CLI, which the tarball doesn't carry, so the script installed `@opencode/cli@2.3.2` next to it (Q294).
- **Two browsers,** Demo and Sam, driven by Playwright through the panel. Per the maintainer's direction for this milestone, the "run by hand" of ticket 37 is this Playwright run: every step went through the panel's own pages and buttons, and Sam's runner signed in with a real device code that Sam approved in the browser.
- The demo's Linear tickets and GitHub PRs went to the test workspaces only (`ostra-test`, team `OST`; repos `test1` and `test2`), and were cleaned up after: 3 tickets archived, 20 PRs closed, 42 branches and hidden refs deleted.

## Step by step

| Step | Time | What was seen |
|---|---|---|
| 1. A pool that requires approval | 3 s | "New pool" made `build-fleet`: approval on, at most 3 boxes, tokens for 30 days. The token was shown once ([shot](demo/01-join-token.png), the token masked by the script), with three ways to start a runner; the `ostra runner` one reads the token from a file, never from the command line. `test1`'s Runners tab listed `build-fleet`, then `default`, with a share of 2 ([new pool](demo/01-new-pool.png), [test1's Runners tab](demo/01-test1-runners.png)). |
| 2. A runner joins and waits | 13 s | `build-01` (labels `tier:fast`) joined and stayed `joining`. The audit log had `runner.joined` naming the token, Demo had the notice, and Needs you said "build-01 wants to join build-fleet" with its host, system (Windows · x64), executor ("not isolated, same user (development only)"), labels, version and token ([shot](demo/02-runner-approval.png)). A `test1` task wasn't offered to it (0 leases). After Approve it was `online`, `runner.approved` was in the audit log, and the waiting task went to it. |
| 3. Rotation | 4 s | A second token, the first revoked: `build-01` stayed online. `build-02` joined with the new token and was approved. A runner on the revoked token exited 1 with "The pool's join token was refused (revoked)", and one on a token past its lifetime with "(expired)"; neither has a runner row. |
| 4. The fleet view | 4 s | Runners listed `build-fleet` as "not isolated, same user", `host`, 2 of 2 online, its labels and version ([shot](demo/04-runners.png)). `build-fleet`'s page listed both runners, its tokens with the revoked one marked, and an empty queue ([shot](demo/04-pool.png)). After step 12 the view also had `k8s-fake` ("direct internet") ([shot](demo/12-fleet-with-k8s.png)). |
| 5. Box sizes | 1 s | small 2 vCPU · 4 GiB, with the line that `host` counts slots only. Demo set large to 8 vCPU and 32 GB, and the audit log had it ([shot](demo/05-box-sizes.png)). |
| 6. Capacity and the queue | 228 s | Five prompts in `test1`, an Urgent and a Low `OST` ticket started from the Inbox, one prompt in `test2`. `test1` ran 2 (its share), `test2`'s ran on the third slot, and the queue read Urgent, the prompts in the order they came, then Low ([shot](demo/06-pool-queue.png)). A queued task's page said "3rd in build-fleet's queue · test1 is at its share of build-fleet: 2 boxes" ([shot](demo/06-task-queued.png)). Cancel on the pool's page stopped the Low task as "Cancelled by demo", with `task.cancelled` in the audit log ([shot](demo/06-task-cancelled.png)). When a box freed, the Urgent ticket started before any queued prompt. |
| 7. Choosing a runner | 388 s | Two tasks on the profile `Fast` (`tier:fast`) both ran on `build-01`, with `build-02` free. A profile asking for `gpu` left its task waiting with "No runner in build-fleet or default has the label gpu." ([shot](demo/07-task-needs-gpu.png)). A ticket task no member started went to a pool runner (`build-01`). |
| 8. Personal and pool runners | 28 s | Sam's runner signed in by device code, approved in Sam's browser. "Your machine: sam-laptop: Connected, personal, not isolated, contained by a job object, 2 tasks at once" ([shot](demo/08-your-machine.png)). An organization provider was refused on it until allowed for personal runners. Sam's New task offered "A pool" and "Your machine" ([shot](demo/08-new-task-picker.png)); two of Sam's tasks ran on it and the third read "sam-laptop is busy (2 of 2)" ([shot](demo/08-laptop-busy.png)). None of Demo's tasks was leased to it. |
| 9. Drain, resume, revoke | 150 s | Drain while `build-01` ran a task: the turn ended, the next `Fast` task waited, and the fleet view read "draining" ([shot](demo/09-draining.png)). Killed and started again, `build-01` reconnected still draining. Resume: online, and it took the queued `Fast` task. Revoking `build-02` mid-task stopped the task as `runner_lost` at once, the task reopened on `build-01`, and `build-02` exited 3 when started again ([shot](demo/09-revoked.png)). |
| 10. Runner versions | 57 s | `scripts/build-runner-at.ts` built runners at protocol 1.4 and 1.3 from earlier commits (the milestone tags don't exist yet, so by `--ref`). The server speaks 1.5 by now (milestone 4 added it), so its window is 1.4 to 1.6 and these are section 3's "one minor behind" and "outside". The 1.4 runner worked and was marked "behind"; its page said "protocol 1.4 of 1.5, One minor behind the server: it runs tasks" ([shot](demo/10-one-minor-behind.png)). The 1.3 runner stopped with "This runner (ostra 0.0.0, protocol 1.3) is outside the server's window (protocol 1.4 to 1.6). Install ostra 0.0.0, the server's version, and start the runner again." ([fleet](demo/10-fleet-versions.png)). |
| 11. The HTTP fallback | 79 s | Behind the TLS proxy that refuses WebSockets, `build-03` was on HTTP as it started, the fleet view showed its carrier as HTTP ([shot](demo/11-http-carrier.png)), a steer reached its task, and its 4 events were stored once each. With WebSockets passed again it went back to WebSocket within the retry. Through the CONNECT proxy with Basic auth a runner stayed on WebSocket. |
| 12. `kubernetes`, on the fake cluster | 5 s | `helm template` rendered the runner chart and its objects applied to the fake API: the two namespaces, both NetworkPolicies, the service account, Roles and RoleBindings (the fake serves no PersistentVolumeClaim or Deployment, so those two weren't applied). A runner with `--executor kubernetes` joined `k8s-fake` and was online; the fleet view said "direct internet" ([shot](demo/12-fleet-with-k8s.png)). `test2`'s task waited with "k8s-fake needs a registry for snapshots: an admin sets one under Registry." ([shot](demo/12-needs-registry.png)). |
| 13. The registry | 312 s | Registry set to `dev:registry` with a push and a pull credential; Check answered "Push and pull both allowed for ostra-dev/" ([shot](demo/13-registry.png)). With the fake API holding the pod unscheduled, the dispatch was accepted at once and the task page read "Waiting for a node" ([shot](demo/13-waiting-for-a-node.png)). The box's pod is [`demo/13-pod.json`](demo/13-pod.json), secret values left out: the agent with small's limits (2000m, 4096Mi), the sidecar as a native sidecar, no service account token, the task token's secret mounted into the sidecar only. The snapshot build ran as a BuildKit pod in `ostra-builds` under its own egress policy. After release the pod was gone and no secret was left. |
| 14. Images, charts, egress | 5 s | `pnpm check:images` passed (the three Dockerfiles and the compose file). `pnpm check:helm` linted and rendered both charts with their required values and every example, and refused Kubernetes 1.28 ([`demo/helm/check-helm.txt`](demo/helm/check-helm.txt)). F-116's tests showed the `docker` rules and the chart's NetworkPolicy come from the same list. |
| 15. The load test | 0 s | Not run again inside the demo; its record is ticket 34's ramp on this machine, [`demo/load-windows.md`](demo/load-windows.md): **250 tasks held**; at 500, 3 tasks weren't dispatched in time and a steer took 3.4 s at p99. Every event was stored once and no steer was lost at every step. The 1,000-task run is ticket 38's, on Linux. |

## The checks after the run

All passed, in the same run:

- **Nothing leaked:** the event log and 15 log files searched for 36 secret values (join tokens, keys, access and task tokens, registry credentials, the GitHub and model keys) and the GitHub token pattern: none. The runners' folders and worktrees (2,395 files) hold no join token, registry credential or key.
- **Isolation:** milestone 4's generated test with the new models, 13 of 13.
- **Join tokens, the share and the queue, choosing, drain and versions** on the real gateway: 5 files, 39 tests.
- **The compatibility matrix** over recorded fixtures: 5 of 5.
- **The fake cluster's objects:** everything released, nothing outside the runner's namespaces, 24 passed and 2 skipped (the host cache, which isn't kubernetes', and the snapshot case the fixture doesn't supply).
- **Clean-up** in `OST`, `test1` and `test2` only.

## Not run here, and where it runs

- **The agent in a pod.** In `dev:fake-kube`'s process mode the agent's command is the base image's init, which maps to nothing on this machine, so the box's pod ends as it starts. The agent in a pod is ticket 35's `live-kind` job's.
- **The snapshot's build, scan and push** on `kubernetes`. The pod's own ostra steps run, but the BuildKit container has no stand-in in process mode, so no image was pushed. Ticket 35's `live-kind` job.
- **Cgroup limits, pushes and pulls on `docker`, the egress probes from a box, a separate OS user for a `host` pool, the macOS sweep.** Ticket 35's `live-docker` and `live-macos` jobs. **None of ticket 35's jobs has run yet**: this machine has no `gh`, and the maintainer dispatches them with `gh workflow run Proof -f jobs=fleet`. So every row that waits on them stays `building`.
- **The pin** (the CLI at N+1 installing N from npm): proved by `apps/runner/src/pin.test.ts`; the dev npm registry serves stand-ins, not runners.
- **A refused runner shown as outdated:** only a runner that already has a row can be shown so, one that joined before the server moved on. The two-minors-behind runner stops before it signs in. The panel's outdated line is proved by `apps/web/e2e/15-runner.spec.ts`.
- **The demo ran once,** not twice in a row as ticket 37 asks: the maintainer asked for one clean run today.

## What the demo found, and fixed before the run of record

Twelve earlier runs failed on these, each fixed in its own commit on `main`:

- `368d2f17` and `0020b04d`: the queue lost its order across two pools' admission passes, and room freed in the middle of a pass went to a later task instead of the queue's head.
- `5ae20329`: tasks queued in the order they were created, not the order they were started (the Inbox's tickets were created first).
- `29bcc561`: an expired join token didn't read as expired, a personal runner didn't read "contained by a job object", and a task's wait line read "No runner in 's pools" before its project's name had loaded.
- `b893bca7`: the CLI didn't route `ostra internal build-step`, so a BuildKit pod's ostra steps couldn't run.
- `edcbba5d`: the dev CONNECT proxy didn't ask for Basic auth.
- `9415a29a`: a runner's version line was worded for one server minor only.
- Q294 (open): the npm CLI doesn't carry OpenCode or `koffi` for the `host` executor.
