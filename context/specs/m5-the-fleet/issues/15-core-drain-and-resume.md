# 15: Core: drain and resume

Status: ready-for-agent
Builder: core
Blocked by: 01, 05
Features: F-092
Packages: `apps/core` (`src/gateway/`), `packages/domain` (`drainRunner`, `resumeRunner`)
Spec: `../spec.md`, section 4 ("Drain and resume"); ADR 0029 ("Drain, resume and revoke"); milestone 2's ticket 41, which left this here

## What to build

- **`drainRunner`:** from `online` or `offline`, one transaction: `draining`, `drainedAt`, `drainedByMemberId`, a `drain` command through the outbox, the audit entry `runner.drained`, the server-only event. Its running tasks finish; the admission offers it nothing.
- **`resumeRunner`:** from `draining`, to `online` when its presence row is live and to `offline` otherwise, a `resume` command for a minor-4 runner (a minor-3 runner gets none, and the result says it takes tasks after it restarts), `runner.resumed`, and a `queue.admit` for its pool.
- **The hold survives** a disconnect, a reconnect, the runner's restart and every core replica's restart: the state is the row's, and `hello` never changes `draining`.
- Admins only, for any runner of the organization; a member can't drain their own personal runner (they stop it instead).

## Done when

- [ ] Tests against the fake peer, named for `F-092`: a drained runner gets no offer while a task it holds finishes; it stays draining through a disconnect, a restart and a server restart; resume to online and to offline; the `resume` command applied once; a minor-3 runner gets no `resume`; a member is refused.
- [ ] Break-it: letting `hello` move a draining runner online fails the restart test; recorded in `context/proof/F-092.md`.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add drain and resume`.

## Comments
