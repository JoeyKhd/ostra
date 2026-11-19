# 34: The load test

Status: ready-for-agent
Builder: core (lead)
Blocked by: 11, 13, 18, 19
Features: F-117
Packages: `e2e/load/` (new), `apps/runner` (its peer and spool exported for a test package, no behaviour change), `package.json` (`load:run`)
Spec: `../spec.md`, sections 3 (step 15) and 11, item 16; ADR 0061

## What to build

Ported from `spikes/runner-transport/src/loadgen/loadgen.ts`, `src/harness/cluster.ts` and `spike1-rate.ts`, onto product code: nothing in the load path is a stand-in for ostra's own.

- **The stack:** three core replicas and one `web`, against one Postgres (embedded here; `DATABASE_URL` for a real one), started by the harness, every child ended when it ends.
- **Simulated runners:** `apps/runner`'s real peer and spool (in memory), on the real protocol and carriers, each with N slots, joined with a real join token and approved; tasks created through `packages/api`, admitted by the real queue and dispatched by the real dispatcher.
- **The agent's events:** a scripted source per task drawn from spike 10's recorded mix (a median of 259 and at most 415 driver events a minute, 793 bytes a wire message, before coalescing), with partial text on for 1 task in 4.
- **The generator** runs as several processes (one per 250 tasks by default), so one process's event loop isn't the limit.
- **What it measures:** a steer from `packages/api`'s call to the runner's receipt (p50, p99), events offered and stored (exactly once, checked after the drain), ack and ingest-transaction latency, Postgres's CPU (sampled from the OS: `/proc` on Linux, the process's counters on Windows), each replica's memory, and a reconnect storm (every simulated runner dropped at once and back).
- **Browsers:** Playwright, a sample of real browsers (5 by default) on task pages with partial text on, timing an event's arrival in the DOM.
- **`pnpm load:run --tasks N`** and **`--ramp`** (100, 250, 500, 1,000 by default): each step's results in `.data/load/<time>/results.json`, and a summary that names the largest step that held every bar (F-117's steer bar, events stored once, no lost command) and how the next failed.

## Done when

- [ ] Tests named for `F-117`: a simulated runner speaks the real protocol against a real core (one task end to end); the steer timer against a known delay; the CPU sampler on the test's own process; the summary's verdict from recorded results.
- [ ] `pnpm load:run --ramp` ran on this machine, its summary kept in `context/specs/m5-the-fleet/demo/load-windows.md` with the machine's description, as live evidence for the rows it shows and as the record of the scale it held.
- [ ] Committed as `✅ add the load test`.

## Comments
