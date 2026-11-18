# 24: The runner gateway

Status: ready-for-agent
Builder: core
Blocked by: 01, 08
Features: F-013, F-014 (registration), F-061 (the version window)
Packages: `apps/core` (`src/gateway/`), `packages/domain` (`registerPersonalRunner`)
Spec: `../spec.md`, sections 4 and 5.1

## What to build

`apps/core` becomes a Node server on `OSTRA_CORE_PORT` (default 8787) that serves `/runner/v1/*` (ADR 0034). Server code uses async APIs only.

- **`GET /runner/v1/info`:** the server's version, the minor window, `OSTRA_PUBLIC_URL` (where the device flow runs) and the device client ID.
- **`POST /runner/v1/register`:**
  - with a device session as a bearer: validate it through better-auth's API (the auth config from `packages/api`, ticket 30; until 30 lands, against an interface the test fakes), create a personal runner owned by that member in the session's active organization, store its public key, **revoke the session** (ADR 0029, Q115), write an audit entry
  - with a join token: the **bootstrap join token** only, which core generates at first start for the default pool, stores hashed, and writes to `OSTRA_DATA_DIR` for the compose file's runner (ticket 22). It's shown nowhere else; F-091 brings the rest
- **`POST /runner/v1/token`:** verify the signed assertion against the runner's key (ticket 01's canonical string), refuse a revoked runner, return a 10-minute access token.
- **The WebSocket** (`ws` 8.23.0) at `/runner/v1/connect`: the access token at the upgrade, `hello`/`welcome` with the minor negotiated, the presence table with a connection epoch (a new connection evicts the old with `4409`), ping every 20 s, dead after 45 s.
- **Commands down:** read the runner's outbox rows after its last acked seq on connect; on each `NOTIFY` for a runner this replica holds, and on a sweep every 2 s, send what's new; apply acks. One dedicated, direct `pg` connection per replica for `LISTEN` (ADR 0034).
- **Events up:** hand each `events` frame to the ingest use case (ticket 25) through an interface, and send its `ack` after it commits. Until 25 lands, a test double stores nothing and acks.
- **Status:** update the runner's capacity, labels, version and free slots, and emit a change notice when they change, never per heartbeat.
- Revoke sends `evict` and closes with `4403`.

## Port from

`spikes/runner-transport/src/server/replica.ts`, `schema.ts`, `src/shared/auth.ts`, `src/harness/scenarios/versions.ts` and `authz.ts` as tests.

## Done when

- [ ] Against a fake peer: register by device session (and the session is revoked), token, connect, a command written in another transaction reaches the peer within the sweep, an ack advances the cursor, a second connection evicts the first, a revoked runner is refused, runners N-1 and N+1 connect and N+2 is refused with the fix.
- [ ] The bootstrap join token is stored hashed, and a second use of it for the same runner name is refused.
- [ ] Every test also checks that a runner of another organization gets nothing.
- [ ] The whole-repo checks pass (spec section 9: credentials, the runner protocol).
- [ ] Committed as `✨ add the runner gateway`.

## Comments
