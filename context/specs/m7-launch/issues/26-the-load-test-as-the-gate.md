# 26: The load test as the gate

Status: ready-for-agent
Builder: core
Blocked by: 07
Features: F-117
Packages: `e2e/load` (the mix), `context/specs/m7-launch/load/` (new), `context/proof/F-117.md`
Spec: `../spec.md`, sections 2 and 10.1; ADR 0061 (amended); ADR 0064 ("The load test as the gate")

## What to build

- **The mix:** the generator takes a second agent's rates, from ticket 07's live run (driver events a minute, bytes a message, per turn), or, without a live run, from the stub run's shape with spike 10's rates scaled to Claude Code's measured events per turn; half the tasks each. If Claude Code's recorded peak is above 415 events a minute, the steer bar is checked at that peak.
- **This machine's ramp** on the release candidate (`pnpm load:run --ramp --mix opencode,claude-code`), its summary in `context/specs/m7-launch/load/windows.md` with the machine's description, as milestone 5 kept its.
- **The run that counts,** on the maintainer's Linux machine (at least 16 vCPUs and 32 GB, a real Postgres on its own disk; ticket 34, step 7): `pnpm load:run --tasks 1000 --mix opencode,claude-code`, its summary and `results.json` in `context/specs/m7-launch/load/linux.md`.

## Done when

- [ ] A test named for `F-117`: the generator draws each agent's rates from its table (break-it: the second agent's table ignored).
- [ ] This machine's ramp is recorded.
- [ ] The Linux run is recorded and passed every bar, or its failure is recorded with the fix's ticket and the run is repeated. F-117 is `done` only when it passed; launch waits for it (ADR 0064).
- [ ] Committed as `📝 record the load test gate`.

## Comments
