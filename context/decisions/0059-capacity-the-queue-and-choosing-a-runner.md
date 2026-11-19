# Capacity, the queue and choosing a runner

**Status:** accepted (2026-11-19, on the maintainer's delegation for milestone 5's spec). Settles Q231 to Q236, Q247 and Q248. Covers F-067, F-069 and F-095, and builds on ADR 0029 (pools, box sizes, dispatch by labels and capacity), ADR 0034 (a dispatch is an offer), ADR 0037 (a share is counted from ostra's own rows, never from a queue's limit) and ADR 0038 (services never go to `host`).

ADR 0029 says a task goes to one of its project's pools by labels and free capacity, that sizes exist, and that a pool caps its total and each project's share. It doesn't say what a runner offers, in what order waiting tasks start, what a share counts, how labels match, or which of several fitting runners wins. This ADR does.

## What a runner offers

- **Slots everywhere, and CPU and memory where sizes apply.** Every runner reports its slots in each `status`. A `docker` runner also reports the CPU and memory it offers: the engine's, less a reserve (1 vCPU and 2 GiB *(working values)*), less what its live boxes hold. A `kubernetes` runner reports its namespace's `ResourceQuota` less what its pods request, or its own settings when there's no quota. `host` reports slots only, as ADR 0029 allows.
- **A box takes a slot and, where sizes apply, its whole footprint:** the agent's size, the sidecar's fixed limit and each service's limit. So a runner can't be offered a box it can't hold.
- **A personal runner offers 2 slots** by default *(working value)*, which its member can change on the runner.

## Box sizes

- **Three names per organization:** `small`, `medium` and `large`, each with CPU and memory an admin can change. No other names in v1, so a profile or a rule can name a size without a migration later.
- **A size limits the agent's container.** The sidecar (1 vCPU, 256 MiB) and each service (its own, or 1 vCPU and 1 GiB) have their own limits *(working values)*. On `kubernetes`, requests equal limits, so the scheduler never overcommits a box. On `docker`, swap equals memory.
- **A project picks its default,** and every task of the project gets it. A size per task isn't in v1.

## The queue

- **One queue per pool:** the queued tasks the pool could run, as a query over ostra's rows, not a stored list. A task its project's pools could all run is in each of their queues and starts in whichever admits it first.
- **The order:** ticket priority (Urgent, High, Medium, Low), then the time it was queued, then its ID. A prompt task and a ticket with no priority rank as Medium. A requeued task (an offer declined or timed out, a box with no node, a revoked runner) keeps its first queued time.
- **Admission** is a job keyed by pool, enqueued by every change that can free or need room, plus a sweep every 5 s *(working value)*. Under the pool's lock it walks the queue in order and admits each task that fits, each in its own transaction.
- **Cancel:** an admin cancels any queued task from the pool's queue, and a member their own. The task stops with the new reason `cancelled` and can be reopened like any stopped task.

## A project's share

- **A cap in boxes,** per project and pool, none by default. It's counted from `Box` rows in the admitting transaction, under the pool's lock, so three core replicas admitting at once can't pass it (ADR 0037).
- **A project at its share is passed over,** and the next task in the queue is considered. One project's backlog never blocks another's task behind it.
- A pool's own cap, in boxes, applies on top.

## Labels

- **A runner's labels** come from `OSTRA_RUNNER_LABELS`, plus `executor:<kind>`, `os:<platform>` and `arch:<arch>`, which only ostra sets; a runner that sends a reserved one has it dropped.
- **A profile names the labels its tasks need.** A runner fits when it carries every one, compared exactly. No expressions, no "not", no weights.

## Choosing a runner

- **A member's personal runner** only for a task that member started and picked it for. A task no member started (intake rules, schedules and Linear's agent mode, in milestone 6) goes to pools only.
- **Otherwise the project's pools in the project's order.** In a pool, the runners that are online and approved, carry the labels, declare what the task needs (services; a registry where the executor requires one), and have room. Among them: the most free room, then the runner holding the project's snapshot, then the one offered least recently.
- **When nothing fits,** the task stays queued and its page says the nearest miss across the pools, in a fixed order: a registry is needed, services are needed, no runner has the labels, the size is larger than any runner, the project's share is reached, the pool is full, no runner is online.

## Notices and cancel

- **Every join** notifies the organization's admins in the panel and by mail, and a join that waits for approval is also a needs-you item for them, resolved by the approval or the reject (F-091, Q247).
- **`task.cancelled`** is an audit entry and a server-only event on the task (Q248).

## Considered options

- **A stored queue per pool,** with a row per waiting task. Rejected: a task allowed on several pools would need a row in each and a way to remove the others when one admits it. A query over the task rows needs neither.
- **First come, first served.** Rejected: F-067 asks for ticket priority, and a backlog of low tickets would hold an urgent one.
- **Fair share by default,** splitting a pool evenly between the projects with waiting tasks. Rejected for v1: it needs a rule for projects that come and go, and explicit caps do what admins asked for. It can come later as a pool setting.
- **Shares in CPU and memory.** Rejected for v1: boxes are what admins count, and sizes already keep a runner from overfilling.
- **Label expressions** (`gpu && !arm64`). Rejected: an exact subset is easy to explain and to show as a reason; expressions can be added without changing stored labels.
- **Spreading boxes across runners** instead of filling the roomiest. The roomiest is the spread for equal runners; a "pack" mode for autoscaled pools can come later.

## Consequences

- `Task` gains its queue priority, queued time, required labels and who cancelled it; `Box` its size; `ProjectPool` its position; `AgentProfile` its labels; a new `BoxSize` table (milestone 5's migration).
- The wait reasons join milestone 2's typed `dispatchWait`, and the panel words each one from its message file.
- `chooseRunner` is a pure function over rows, so every reason is tested from a table without a database.
- Ledger rows: F-067, F-069, F-095, F-014 (two slots), F-086 (the ordered pool list).
