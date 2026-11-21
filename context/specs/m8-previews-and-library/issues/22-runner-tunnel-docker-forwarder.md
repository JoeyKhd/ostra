# 22: Runner: the tunnel and the `docker` forwarder

Status: ready-for-agent
Builder: runner
Blocked by: 08, 12
Features: F-143, F-144
Packages: `apps/runner` (`sidecar/`, `task-host/`, `connection/`), `packages/adapters/adapter-executor-docker` (`init/`)
Spec: `../spec.md`, sections 4 ("A tunnel") and 5.1; ADR 0068 ("The preview connection")

## What to build

Ported from spike 08.
- **`preview.open` in `tunnel` mode:** open the preview connection, and serve one HTTP/2 connection on it, with the sidecar (on `host`, the runner) as the server, `enableConnectProtocol` on, from Node's own `http2` over the WebSocket's duplex stream.
- **Three kinds of stream:**
  - a plain request (the native preview's) forwarded to the preview's port as HTTP/1.1, with the request's headers as core rewrote them;
  - an extended CONNECT (`:protocol: websocket`) bridged to a WebSocket upgrade on the port;
  - a plain `CONNECT` (`ostra preview`'s) bridged to a raw TCP connection to the port.
- **Reaching the port:**
  - `docker`: the init's forwarder (ticket 03), opened on demand per port and closed with the view;
  - `kubernetes`: the pod's `127.0.0.1`;
  - `host`: `127.0.0.1`.

  A service's preview is reached by its name on `docker` and at `localhost` on `kubernetes`.
- **The reach rule,** checked on every stream: `mayReach` against the task's previews and the reserved ports. A stream to anything else is answered 403 or refused with `RST_STREAM`.
- **Back-pressure:** HTTP/2's per-stream windows, and the WebSocket's `bufferedAmount` for the connection. A stream that stalls never stalls the others past HTTP/2's own head-of-line limit. Spike 08's numbers are written under `## Comments`.
- **The HTTP carrier:** no tunnel. `preview.open` with `tunnel` on it is refused with the reason, and `hello` says `tunnel: false`.

## Done when

- [ ] Tests named for `F-143`, on `host` live with the fixture app:
  - a `CONNECT` carrying an HTTP request and a WebSocket at once;
  - a port outside the previews refused (break-it: skip `mayReach`, and the case fails);
  - the HTTP carrier's refusal.
- [ ] Tests named for `F-144`: a plain request and an extended CONNECT reaching the Vite fixture with HMR.
- [ ] The executor suite's forward case passes on the `docker` fake. The `live-docker` job carries the forwarder live, marked as waiting until it runs. *Its run waits for the launch-gate Proof run (the maintainer, 2026-11-21).*
- [ ] The whole-repo checks pass (spec section 10).
- [ ] Committed as `✨ carry previews over an HTTP/2 tunnel`.

## Comments
