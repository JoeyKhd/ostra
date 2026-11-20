# The load test on the plan's Windows machine

Milestone 5's ticket 34 (F-117, ADR 0061). `pnpm load:run --ramp` on the machine the plan is built on, kept as live evidence for the rows of `context/proof/F-117.md` that cite it and as the record of the scale this machine held. It proves the harness and gives a number; it doesn't prove F-117's bar, which is 1,000 tasks on three core replicas and a Postgres of its own on a Linux server of 16 or more vCPUs (ticket 38's run).

## The machine

Windows_NT 10.0.26200 (Windows 11 Pro, win32/x64), 13th Gen Intel Core i9-13900K, 32 logical CPUs, 32 GB, Node v24.14.0. Embedded Postgres 18 on the same disk, three core replicas (`node apps/core/src/main.ts`, `NODE_ENV=production`), one panel (`next start`, a production build), the harness's own `packages/api`, the generator processes and 5 headless Chromium pages, all on this one machine. **The machine was shared**: three other builds' agents ran their own typechecks, tests and stacks at the same time (2026-11-20, 01:10 to 01:40 UTC), so the numbers move with their load, as the two failed runs below show.

## What each step does

Each step starts its own stack in `.data/load/<time>/step-<n>/`, makes a pool that needs approval and its join token through `packages/api`, joins one simulated runner a task (`apps/runner`'s own key pair, `register`, access tokens, peer and disk spool, on the WebSocket carrier, a `host` runner so its own connection carries its tasks' events) from generator processes of up to 250 runners each, approves each runner through `packages/api`, and starts the tasks through `tasks.create`. The real queue admits them and the real dispatcher hands them out across the three replicas. Each task's scripted agent writes spike 10's mix at its own rate (190 to 415 events a minute, about 793 bytes an event, before coalescing), with partial text on for 1 task in 4. After 15 s of warm-up, the 60 s window sends 200 steers through `tasks.send` (timed from the call to the runner's receipt), samples Postgres's CPU (the postmaster and its backends, from `Win32_Process`, every 5 s), reads each replica's `ingest.timing` lines, and has the 5 browsers time marked partial text into their DOM. Then the reconnect storm cuts every runner's TCP connection at once, 20 more steers go out once they're back (counted, not timed), and the runners drain: every event offered is checked as stored exactly once.

## The ramp of record: `pnpm load:run --ramp` (2026-11-20, 01:30 UTC)

```text
Windows_NT 10.0.26200 (win32/x64), 13th Gen Intel(R) Core(TM) i9-13900K, 32 logical CPUs, 32 GB, Node v24.14.0

The largest step that held every bar: **250 tasks**.
The next step, 500 tasks, failed: 3 of 500 tasks were never dispatched; a steer took 3398 ms at p99 (the bar is under 500 ms).

| Tasks | Verdict | Dispatched | Steer p50 / p99 | Steers received | Events stored once / offered | Events a minute a task | Ack p50 / p99 | Ingest p50 / p99 | Postgres cores, mean / max | Core memory MiB | Reconnect storm | Browsers (seen, latency) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 100 | held | 100 | 20 ms / 438 ms | 220/220 | 46336/46336 (dup 0) | 280 | 18 ms / 2156 ms | 25 ms / 500 ms | 1.77 / 2.07 | 623, 614, 641 | 100/100 in 1.3 s | 145/145, p50 394 ms, p99 3725 ms |
| 250 | held | 250 | 288 ms / 463 ms | 220/220 | 135074/135074 (dup 0) | 255 | 7494 ms / 31301 ms | 500 ms / 500 ms | 3.04 / 4.07 | 664, 677, 665 | 250/250 in 2.0 s | 127/145, p50 10577 ms, p99 33455 ms |
| 500 | failed | 497 | 725 ms / 3398 ms | 220/220 | 869067/869067 (dup 0) | 205 | 131748 ms / 147283 ms | 1000 ms / 2500 ms | 2.78 / 3.59 | 910, 905, 888 | 500/500 in 51.7 s | 0/145, p50 -, p99 - |
```

**This machine held 250 tasks.** At 500 (two generator processes, 500 runners) 3 tasks were never dispatched within the step's wait and a steer took 3.4 s at p99; every event was still stored exactly once and no steer was lost. Past the bars: at 250 the ack time's p99 was 31 s and the browsers saw 127 of 145 marks (p50 10.6 s), and at 500 the browsers saw none in the window and the runners took 52 s to come back from the storm. Ingest is a transaction per frame, and at these rates nearly every frame holds one event: as the step grew, ingest's time and Postgres's CPU (3 to 4 cores) rose while each replica stayed under 1 GB. Where the time goes past 250 tasks is the Linux run's question.

## Two earlier runs of the same ramp, under heavier shared load

At 01:17 and 01:20 UTC the same 100-task step failed the steer bar alone (p99 708 ms and 607 ms; every event stored once, no steer lost, ingest p50 100 to 250 ms against 25 ms at 01:30). The first of these timed the 20 steers after the storm with the window's; the harness was changed after it so only the window's steers are timed against the bar, and the ones after the storm are counted as lost or not.

```text
Windows_NT 10.0.26200 (win32/x64), 13th Gen Intel(R) Core(TM) i9-13900K, 32 logical CPUs, 32 GB, Node v24.14.0
No step held every bar.
The next step, 100 tasks, failed: a steer took 708 ms at p99 (the bar is under 500 ms).
| Tasks | Verdict | Dispatched | Steer p50 / p99 | Steers received | Events stored once / offered | Events a minute a task | Ack p50 / p99 | Ingest p50 / p99 | Postgres cores, mean / max | Core memory MiB | Reconnect storm | Browsers (seen, latency) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 100 | failed | 100 | 101 ms / 708 ms | 220/220 | 46054/46054 (dup 0) | 263 | 97 ms / 2548 ms | 100 ms / 500 ms | 1.85 / 2.16 | 640, 628, 654 | 100/100 in 2.3 s | 145/145, p50 468 ms, p99 5022 ms |
```

```text
Windows_NT 10.0.26200 (win32/x64), 13th Gen Intel(R) Core(TM) i9-13900K, 32 logical CPUs, 32 GB, Node v24.14.0
No step held every bar.
The next step, 100 tasks, failed: a steer took 607 ms at p99 (the bar is under 500 ms).
| Tasks | Verdict | Dispatched | Steer p50 / p99 | Steers received | Events stored once / offered | Events a minute a task | Ack p50 / p99 | Ingest p50 / p99 | Postgres cores, mean / max | Core memory MiB | Reconnect storm | Browsers (seen, latency) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 100 | failed | 100 | 168 ms / 607 ms | 220/220 | 48394/48394 (dup 0) | 275 | 409 ms / 10872 ms | 250 ms / 500 ms | 1.99 / 2.74 | 547, 556, 571 | 100/100 in 1.3 s | 145/145, p50 3302 ms, p99 11244 ms |
```

## A lower ramp: `pnpm load:run --ramp 25,50,75` (01:24 UTC)

```text
Windows_NT 10.0.26200 (win32/x64), 13th Gen Intel(R) Core(TM) i9-13900K, 32 logical CPUs, 32 GB, Node v24.14.0
The largest step that held every bar: **75 tasks**.
Every step held.
| Tasks | Verdict | Dispatched | Steer p50 / p99 | Steers received | Events stored once / offered | Events a minute a task | Ack p50 / p99 | Ingest p50 / p99 | Postgres cores, mean / max | Core memory MiB | Reconnect storm | Browsers (seen, latency) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 25 | held | 25 | 23 ms / 406 ms | 220/220 | 10135/10135 (dup 0) | 253 | 12 ms / 376 ms | 10 ms / 500 ms | 0.76 / 0.98 | 608, 440, 553 | 25/25 in 1.3 s | 145/145, p50 311 ms, p99 846 ms |
| 50 | held | 50 | 15 ms / 143 ms | 220/220 | 24644/24644 (dup 0) | 301 | 8 ms / 171 ms | 10 ms / 250 ms | 0.98 / 1.43 | 615, 628, 525 | 50/50 in 1.3 s | 145/145, p50 285 ms, p99 415 ms |
| 75 | held | 75 | 13 ms / 56 ms | 220/220 | 33425/33425 (dup 0) | 274 | 8 ms / 94 ms | 10 ms / 100 ms | 0.90 / 1.38 | 632, 611, 640 | 75/75 in 1.3 s | 145/145, p50 316 ms, p99 418 ms |
```

## What it shows, and what it doesn't

- Shown here (live): three core replicas and one panel over one Postgres, with runners spread over the replicas and each steer routed by Postgres to the replica that holds its runner; Postgres's CPU recorded; the generator as several processes (two at 500); a reconnect storm with every runner back; real browsers on a sample of tasks with partial text on; events stored exactly once at every step, and no lost steer.
- Not shown here: 1,000 tasks under the bars. That is ticket 38's run on Linux, with its own Postgres on its own disk and at least 16 vCPUs; F-117 stays `building` until it passes, and milestone 7 repeats it on the release candidate (ADR 0064).
