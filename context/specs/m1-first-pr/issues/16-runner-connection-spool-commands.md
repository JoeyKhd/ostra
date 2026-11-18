# 16: The runner's connection, spool and commands

Status: ready-for-agent
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

- [ ] Against a fake gateway from ticket 01's schemas: a batch is resent after a dropped connection and stored once; a gap gets `resendFrom` and recovers; a command is applied once across a reconnect; `notAfter` is honoured; the self-fence fires on a fake clock.
- [ ] A test kills the runner between spool write and ack, restarts it, and sees every event acked once.
- [ ] The whole-repo checks pass (spec section 9: the runner protocol).
- [ ] Committed as `✨ add the runner's connection and spool`.

## Comments
