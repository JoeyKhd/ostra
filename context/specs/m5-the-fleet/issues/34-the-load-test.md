# 34: The load test

Status: done
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

- [x] Tests named for `F-117`: a simulated runner speaks the real protocol against a real core (one task end to end); the steer timer against a known delay; the CPU sampler on the test's own process; the summary's verdict from recorded results.
- [x] `pnpm load:run --ramp` ran on this machine, its summary kept in `context/specs/m5-the-fleet/demo/load-windows.md` with the machine's description, as live evidence for the rows it shows and as the record of the scale it held.
- [x] Committed as `✅ add the load test`.

## Comments

- 2026-11-20: built in `e2e/load/` (`@ostra/e2e-load`, `pnpm load:run`), committed as `✅ add the load test`. On this machine, shared with three other builds' agents, the ramp held **250 tasks**; 500 failed (3 tasks not dispatched in time, a steer at 3.4 s p99), with every event stored once and no steer lost at every step. The record is `../demo/load-windows.md`; F-117 stays `building` for ticket 38's 1,000-task run on Linux. Where the build departs from the ticket:
  - The simulated runners join as `host` runners: on `docker` and `kubernetes` a task's events and commands travel on its box's sidecar connection (a steer goes to the sidecar's command queue), which a script can't stand in for without the sidecar's task token. A runner has 1 slot by default (`--slots`), so the fleet has one connection per task, as a sidecar fleet does.
  - The spool is `apps/runner`'s real disk spool in a temp folder per runner, not an in-memory one, so nothing in the runner is changed for the test. `apps/runner` exports `register`, `generateRunnerKeyPair` and `createAccessTokens`, and its connection takes an optional `onAcked` hook (observation only) for the ack latency.
  - Ingest time comes from core: each frame's ingest is timed (`apps/core/src/ingest/timing.ts`) and an `ingest.timing` line every 10 s gives counts in fixed buckets, so the harness merges replicas and intervals (p50 and p99 at the bucket's bound).
  - `packages/api` runs in the harness's own process, composed as `apps/web` does it, signed in as the first admin through better-auth; the project, its repo row and a model row are seeded straight to the database, since nothing measured calls them. The panel serves the browsers only.
  - Only the window's steers are timed against the bar; the 20 sent after the reconnect storm are counted as lost or not. A ramp stops at its first failed step.
