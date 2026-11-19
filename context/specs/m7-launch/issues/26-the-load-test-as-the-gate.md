# 26: The load test as the gate

Status: ready-for-agent
Builder: core
Blocked by: none (it was 07, which is `wontfix` since 2026-11-19)
Features: F-117
Packages: `e2e/load` (the mix), `context/specs/m7-launch/load/` (new), `context/proof/F-117.md`
Spec: `../spec.md`, sections 2 and 10.1; ADR 0061 (amended); ADR 0064 ("The load test as the gate")
Note: changed 2026-11-19. Claude Code (F-018) moved after v1, so the mix stays milestone 5's, on OpenCode's rates. The second agent's rates in the mix wait with F-018; they're in this file's history.

## What to build

- **The mix:** milestone 5's generator, as it is, on OpenCode's rates from spike 10.
- **This machine's ramp** on the release candidate (`pnpm load:run --ramp`), its summary in `context/specs/m7-launch/load/windows.md` with the machine's description, as milestone 5 kept its.
- **The run that counts,** on the maintainer's Linux machine (at least 16 vCPUs and 32 GB, a real Postgres on its own disk; ticket 34, step 7): `pnpm load:run --tasks 1000`, its summary and `results.json` in `context/specs/m7-launch/load/linux.md`.

## Done when

- [ ] This machine's ramp is recorded.
- [ ] The Linux run is recorded and passed every bar, or its failure is recorded with the fix's ticket and the run is repeated. F-117 is `done` only when it passed; launch waits for it (ADR 0064).
- [ ] Committed as `📝 record the load test gate`.

## Comments
