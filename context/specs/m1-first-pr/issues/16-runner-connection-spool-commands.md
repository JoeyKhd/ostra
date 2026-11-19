# 16: The runner's connection, spool and commands

Status: resolved
Builder: runner
Blocked by: 01, 02
Features: F-013 (WebSocket), F-045 (the runner's side)
Packages: `apps/runner` (`src/connection/`)
Spec: `../spec.md`, sections 4 and 5.1

## What to build

The peer side of ADR 0034, WebSocket only (`ws` 8.23.0, exact pin; the HTTP carrier is milestone 5).

- **Connect:** the access token at the upgrade, `hello` with the peer (`runner`), version and the last command seq it applied; `welcome` negotiates the minor. No `welcome` within the 10 s handshake timeout is a failed connect. Reconnect with full jitter from 1 s to 60 s.
- **The spool:** a disk spool per session under the data folder. Events are numbered per session, written before they're sent, and deleted only when acked. On reconnect, resend from the first unacked event; on `ack { resendFrom }`, resend from there. A quota of 1 GiB per runner: when full, stop reading from the agent so it blocks on its own pipe, and never drop an event.
- **Backpressure:** the credit window of 256 frames or 4 MiB, counted on both, frames at most 1 MiB.
- **Live text:** untracked frames, at most every 250 ms, never spooled.
- **Commands:** apply each once by its `id`, ack the highest contiguous seq, refuse one past `notAfter` judged by server time, report `outcome-unknown` after a crash between start and finish. Hand each command to a typed handler interface (the task host, ticket 21, implements it).
- **Self-fence:** after 9.5 minutes with no server, stop the task's agents and keep the workspace.
- **Status:** executor, capacity, labels, version and free slots, sent on connect and on change.
- `evict` and close codes `4403` and `4409` handled as the protocol says.

## Port from

`spikes/runner-transport/src/runner/peer.ts`, `spool.ts`, `state.ts`.

## Done when

- [x] Against a fake gateway from ticket 01's schemas: a batch is resent after a dropped connection and stored once; a gap gets `resendFrom` and recovers; a command is applied once across a reconnect; `notAfter` is honoured; the self-fence fires on a fake clock.
- [x] A test kills the runner between spool write and ack, restarts it, and sees every event acked once.
- [x] The whole-repo checks pass (spec section 9: the runner protocol).
- [x] Committed as `✨ add the runner's connection and spool`.

## Comments

- 2026-11-18, runner: done in a5bdc27 (`✨ add the runner's connection and spool`); another session fixed two orderings in `peer.ts` after it (c48b470, 1df63f3). `src/connection/`: the WebSocket peer (`ws` 8.23.0), a disk spool per session with a 1 GiB runner quota that blocks the producer instead of dropping, resend from the first unacked event and from `resendFrom`, the credit window counted in frames and bytes, commands applied once by ID with the highest contiguous seq acked, `notAfter` judged by `welcome.serverTime`, `outcome-unknown` after a crash mid-command, live text at most every 250 ms with a snapshot after a reconnect, the self-fence on an injectable clock, and `4403`, `4409`, `4401`, `evict` and `goaway` handled. A choice to confirm with the gateway: a `credit` frame adds to the window, and acks free it. Tests run against a fake gateway built from the protocol's schemas, including a child process killed between spool write and ack. Whole-repo checks green.
