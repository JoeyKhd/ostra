# Runner pools, executors and boxes

**Status:** accepted (2026-11-18, from the delegated answers in `context/history/answers-2026-11-18.md`). Supersedes ADR 0012. Settles Q9, Q32, Q38, Q43, Q44, Q48, Q93, Q94, Q97 and Q98 (Q95 and Q96 are in ADR 0038), and round 14's problems 1–10. **Amended 2026-11-18 after spikes 1 and 9, and 2026-11-19 after spike 3:** the `host` executor contains a task's processes with a Windows job object or a Linux cgroup, a personal runner trades its device-code session for a runner-only key at once, the `docker` executor owns its boxes' subnets, `kubernetes` differs from `docker` on egress and needs Kubernetes 1.29, and the bridge has deadlines (Q151 to Q155).

The server is the control plane and never runs an agent itself, as ADR 0012 said. A runner is the `ostra` CLI running `ostra runner` on a machine that someone hosts anywhere. It connects out to the server, so it works behind NAT.

**Runners join pools.**
- A runner pool is a named set of runners in one organization. Each project lists the pools it may use (Q9).
- A pool runner starts with the pool's join token in `OSTRA_JOIN_TOKEN`. On first contact it trades the token for its own identity, an Ed25519 key pair whose private half never leaves the runner. After that it uses short-lived access tokens (Q94, `research/runner-transport.md` §8).
- A personal runner signs in with a device code that its member approves in the browser. It runs only that member's tasks, on the `host` executor (Q44, Q94).
- **The device code's credential is narrowed at once.** better-auth's device flow hands out a full member session, good for about a week, and its `scope` narrows nothing (spike 9, `research/spike-auth-foundation.md`, surprise 5). So `ostra runner` uses that session once, to register: it presents the session, receives its own runner identity (the same Ed25519 key pair as a pool runner, whose private half never leaves the machine), and the server revokes the session straight away. The runner can then do what a runner does (connect, receive dispatches, fetch a task's leased credentials) and nothing a member can. The code that remains on disk is the runner key, not a login. The spike showed that the revoke call works. `ostra login` (F-103) is a different credential, a member's CLI session, and the runner never uses it.
- Each runner can be revoked on its own. Rotating a join token doesn't disconnect runners that already joined.
- A runner reports its executor, capacity, labels and version (F-013).

**A join token is as sensitive as every secret of every project that may use its pool** (Q48). So:
- it's shown once, stored hashed, and expires after 30 days by default *(working value)*. An admin can set another lifetime, or none
- a pool can require an admin to approve each new runner
- every join is an audit entry and a notification to admins

**Executors.** A runner gives each task its place to run through its executor. An executor is an `ExecutorAdapter`, which runs in the runner under Apache-2.0 (Q98, ADR 0025). v1 ships three, built in this order:
1. **`docker`:** a box of containers on a private network, with gVisor as an optional runtime.
2. **`host`:** a worktree on the machine, and no box. Personal runners use it. A pool may use it when an admin opts in, for machines that can't run containers for the job, such as Macs that build iOS apps. The panel labels it "not isolated". On a pool, the agent runs as a separate OS user (Q27).
3. **`kubernetes`:** a box as one pod. The cluster's own autoscaler supplies the elasticity.

**A box per task** (Q38).
- A box is the agent's container (the repos and the tools, no credentials), an ostra sidecar (the credentials, both proxies, the ACP driver, the event spool) and the environment's services.
- On `docker` they share a private network. On `kubernetes` they're one pod.
- The pool runner only creates and removes boxes. Each box's sidecar connects to the server itself, with a short-lived token for that one task, tied to the task's lease.
- A box serves one task and is never reused for another.
- The sidecar is the same `ostra` binary in an internal mode (Q80). On the `host` executor, the runner process does the sidecar's work. So the same task code runs on every executor.

**Dispatch.** A task goes to one of its project's pools, by labels and free capacity. A member may choose their own personal runner when they start a task. An organization's model provider is usable on personal runners only when an admin allows it for that provider (Q32, Q47, ADR 0030).

**Box sizes** (Q43). The organization names the sizes: small (2 vCPU, 4 GB), medium (4, 8) and large (8, 16) *(working values)*. A project picks its default. A pool caps its total and each project's share.

**Process containment on `host`.** A box ends every process of its task when its container ends. A worktree has no container, so processes a tool detached from the agent's tree could outlive a crash or a stop. Spike 1 saw that the runner's reap works from the agent's tree, and that a detached helper isn't reached by it. A difference like that is a runner-parity bug unless it's closed or recorded, so the `host` executor puts each task's processes in one containment unit and ends the unit when the task ends:
- **Windows:** a job object per task, set to kill its processes when it closes.
- **Linux:** a cgroup per task, killed as a unit.
- **macOS has neither**, and what to use there is unverified (Q126, `research/spike-how-should-the-runner-drive-opencode.md`, item 6). Until it is settled, `host` on macOS reaps the agent's process group and walks its tree, which can miss a process that detached itself. That is the third allowed difference below, and it ends when Q126 does.
- How a Node runner creates a Windows job object isn't shown by any spike, and may need a native addon or a helper program, both of which need the maintainer's yes before a dependency is added (Q126). Until then, milestone 1's `host` executor on Windows ends the agent's whole process tree on stop and says in the panel that detached processes aren't contained.

**The allowed differences between executors.** `AGENTS.md` requires that every difference between runners is recorded in an ADR. These are the only ones:
1. **No services on `host`.** The `host` executor doesn't start an environment's services. The scheduler never sends it a task whose environment declares them (Q40, ADR 0038).
2. **No box sizes on `host`.** It counts slots only (Q43).
3. **On macOS, weaker process containment on `host`,** as above, until Q126 is settled.
4. **On `kubernetes`, the agent's container has direct internet access** (Q151). In a pod, every container shares one network namespace and one IP, and a NetworkPolicy selects pods, not containers. So the egress baseline (private ranges, the metadata address, other boxes) holds on both executors, but on `kubernetes` the agent can also reach any public host without going through the sidecar. On `docker` the agent's container sits on an internal network whose only exit is the sidecar, and that closes it (an `internal: true` network that no run has tried yet). No credential is exposed either way, because the agent holds none (ADR 0030), but a prompt-injected agent on `kubernetes` can send data out to a public host. v1 accepts and records this, and the panel says it plainly on a `kubernetes` pool: "the agent has direct internet access". Nothing in spike 3 shows a better pod shape, and a pod whose agent has its own network namespace has not been found. F-052 (allowlists, later) can come forward for `kubernetes` if it matters. A NetworkPolicy also has no effect on a cluster whose network plugin doesn't enforce it, and ostra's contract test tells an enforcing cluster from one that isn't (F-116).

**The `docker` executor owns its boxes' subnets** (Q154). Docker's default address pools hold at most 31 networks (15 of /16 and 16 of /20, from moby's source), and a box needs two, so a run of 50 boxes on one host would exhaust them. The runner carves each box's two networks out of a pool it manages, pins both inside it, and writes the egress rules once for the whole pool and not one rule per box. The pool is a setting with a working default that doesn't overlap Docker's own pools, and its line goes into the configuration reference when the executor reads it. The docs tell an admin to keep it clear of their own networks. One shared egress network with inter-container connectivity turned off is the alternative if pinning proves clumsy, and is untried. The fallback of one container per box with the runner as a separate OS user stays on the books: nothing in spike 3 triggers it.

**The `kubernetes` executor needs Kubernetes 1.29 or later** (Q155). The box's services run as native sidecar containers (`initContainers` with `restartPolicy: Always`), which are on by default since 1.29 and stable since 1.33. The configuration reference, the Helm chart (F-118) and the docs state it.

**The bridge has deadlines.** One connection between the sidecar and the init carries stdout, stderr and control, and a stalled reader pauses the socket, so a kill's reply could wait behind a full buffer. Every request on the bridge has a deadline, and stopping a task ends with removing the container when the init doesn't answer.

**Autoscaled pools.** A pool runner accepts a dispatch at once and reports "waiting for a node" while its box is pending. Otherwise the two-minute offer timeout (`research/runner-transport.md` §4) would fire while the cluster is still adding a node (round 14, problem 10).

**A `kubernetes` pool requires a registry.** A cluster can only pull images from one. For `docker` and `host` the registry stays optional (round 14, problem 4, ADR 0038).

**The Docker socket** (Q97). The `docker` executor needs the Docker socket, which is root on that host.
- Pool runners belong on dedicated hosts, and the docs recommend rootless Docker or the gVisor runtime.
- The default compose file mounts the socket into its runner. That's right for a one-machine install, and the docs say so.
- The `kubernetes` executor needs only its own namespace and a service account scoped to it.

**The egress baseline.** A box can't reach private address ranges, the cloud metadata address or another box (`research/elastic-sandboxes.md`, isolation rule 5). v1 ships it as a network policy on `kubernetes` and as host rules on `docker` (round 14, problem 11, F-116). Allowlists per environment (F-052) come later. ADR 0031 lists it with the other safety lines.

**ADR 0012's rule, reworded.** A runner holds no long-lived credential for code or models. Its identity key is long-lived, and grants only the right to connect and receive the tasks dispatched to it.

## Considered options

- **One runner container that runs many tasks in worktrees** (ADR 0012, ADR 0020). Rejected: a pool serves many projects, and their tasks would share one container with no boundary between them (`research/elastic-sandboxes.md`, isolation rule 6).
- **The runner inside each box** (round 9). Rejected on its own: something outside the box has to create it on an autoscaled pool.
- **The runner outside the box, doing all of the task's work** (round 14). Rejected on its own: a pool runner that crashed or upgraded would stop every task it held, and `host` would run different task code. The sidecar keeps both: one program, and the same task code everywhere.
- **A hosted sandbox vendor, E2B first** (`research/elastic-sandboxes.md`, recommendation 1). Rejected by the maintainer (Q36): people run runners where they want and join with a key. Hosted sandboxes may become community executors later (F-127).
- **Build `host` first** (Q93). Rejected: the box layout decides the proxies, snapshots and services, so `docker` comes first.
- **`host` only on laptops** (Q93). Rejected: a pool of Mac minis can only be served by `host`.
- **A one-time code per runner** (ADR 0012, F-013). Rejected: a join token per pool lets one key start any number of runners. The device code stays for personal runners.
- **Join tokens that never expire.** Rejected as the default: a leaked token would let a stranger's runner receive a project's code and secrets. GitHub's runner registration tokens expire after an hour (`research/platform-auth-github.md` §1.7).

## Consequences

- Runner parity holds by construction: the same task code runs in every sidecar. The differences listed above (three on `host`, one on `kubernetes`) are the only allowed ones, and any other is a bug. The contract suite for executors includes a case that starts a detached helper and checks that stopping the task leaves nothing behind, on `docker`, `kubernetes` and `host` on Windows and Linux.
- A pool runner that crashes or upgrades doesn't interrupt its tasks, because each box talks to the server itself.
- New lifecycles, each a discriminated union. A runner is joining (possibly waiting for approval), then online ⇄ offline, then draining, then revoked. A box is creating, preparing, ready ⇄ idle, stopped and released, or failed (ADR 0039).
- Spike 3 (`what-is-inside-a-box`) proves the layout, and has not yet: its Windows rehearsal ran with no containers, passed the 33 checks it could run, failed none, and skipped 17 that need a Linux host with Docker, a cluster that enforces NetworkPolicy, gVisor, BuildKit with a registry (`research/spike-what-is-inside-a-box.md`). The credential handoff, the bridge, the key proxy's swap and a stop that leaves no process held in the rehearsal. A box is ready in under 10 s on Docker with the image present, and in under 60 s on a warm Kubernetes node. 50 boxes run on one host, and the sidecar stays under 100 MB *(working values)*. The sidecar's bar is checked against a Linux measurement of the driver alone first: it was 83 to 88 MB on Windows (spike 1). If it fails, the fallback is one container per box, with the runner as a separate OS user (Q27 as first written).
- The `kubernetes` executor builds snapshots with a rootless BuildKit pod, which spike 3 also checks.
- If expiry gets in the way of autoscaled pools, join tokens can be bound to a cluster's identity instead.
- Pools shared between organizations aren't possible. The hosted version may revisit that.
- **Milestone 1 runs its end-to-end demo on the `host` executor,** because the machine the plan is built on has no Docker. The runner is a personal one with a worktree, and it holds no credential: the key proxy and the git proxy run in the runner's own process, as the sidecar's work (ADR 0030). The `docker` executor is written in full, with unit tests, and its live test and spike 3 wait for a Linux machine with Docker. Until then F-017 stays `planned`.
- Ledger rows: F-013, F-014, F-015, F-017, F-067, F-069, F-091, F-092, F-093, F-095, F-116 and F-118. The fleet view (Q5) ships with them in milestone 5.
