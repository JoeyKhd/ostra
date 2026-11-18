# 01: Protocol: the runner protocol

Status: ready-for-agent
Builder: contracts
Blocked by: none
Features: F-013, F-045, F-061 (schemas only)
Packages: `packages/protocol`
Spec: `../spec.md`, section 5.1

## What to build

The Zod schemas every peer of the runner protocol imports (ADR 0034). Strict objects, discriminated on `type`, branded IDs from `src/ids.ts`. Schemas and pure helpers only: no sockets, no I/O.

- `src/runner/version.ts`: `PROTOCOL_MAJOR = 1`, the server's minor (0), `negotiate(serverMinor, peerMajor, peerMinor)`, the window of one minor older or newer, and codecs that encode down to the negotiated minor.
- `src/runner/peer.ts`: the `hello.peer` union, `{ kind: "runner", runnerId }` or `{ kind: "sidecar", taskId, boxId, leaseEpoch }`.
- `src/runner/messages.ts`:
  - up: `hello` (loose, the one message that tolerates unknown fields), `events`, `command-ack`, `status`, `live-text`
  - down: `welcome`, `ack` (`upTo`, or `resendFrom`), `credit`, `command`, `goaway`, `error` (with an error-code enum), `evict`
  - close codes (`4403` revoked, `4409` replaced, and the spike's others)
  - `parseUpFrame(text, minor)` and `parseDownFrame(text, minor)`, which return a result union and never throw on bad input
- `src/runner/commands.ts`: the command union with `seq`, `id`, `notAfter`: `dispatch`, `steer` (`delivery: "queue" | "interrupt"`, `clientMessageId`), `interrupt`, `stop`, `approval-answer`, `drain`, `update-hint`. Commands carry references, never secrets.
- `src/runner/http.ts`: request and response schemas for `GET /runner/v1/info`, `POST /runner/v1/register`, `POST /runner/v1/token` (the signed assertion: runner ID, issued-at, nonce, Ed25519 signature over a canonical string this file defines), `GET /runner/v1/tasks/:taskId/spec`, `POST /runner/v1/tasks/:taskId/credentials`. The bodies of the last two are ticket 02's schemas, so this file imports them or leaves a typed slot that 02 fills.
- `src/runner/limits.ts`: the working values as one `as const` object (spec 5.1), each with a comment naming its ADR.
- Export everything from `src/index.ts`.

## Port from

`spikes/runner-transport/src/protocol/messages.ts`, `ids.ts`, `timers.ts`. Keep its codec-per-minor shape; widen the command set to the product's.

## Done when

- [ ] Every message, command and endpoint above has a schema and an inferred type, and nothing is typed by hand.
- [ ] Tests: each message round-trips; an unknown field is refused everywhere except `hello`; a bad frame gives an error result, not a throw; `negotiate` accepts N-1, N, N+1 and refuses N±2 with the window in the result; a down-encoded frame parses under the older minor.
- [ ] The signed assertion's canonical string is documented in its schema's description, with a test vector (a fixed key pair, made in the test with `node:crypto`).
- [ ] The whole-repo checks pass (spec section 9: this is the runner protocol).
- [ ] Committed as `✨ add the runner protocol schemas`.

## Not in this ticket

Agent events and the task spec (02). The WebSocket and HTTP code (16, 24).

## Comments
