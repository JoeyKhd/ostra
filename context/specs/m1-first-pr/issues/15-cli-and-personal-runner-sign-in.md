# 15: The `ostra` CLI and personal-runner sign-in

Status: ready-for-agent
Builder: runner
Blocked by: 01
Features: F-013, F-014 (sign-in)
Packages: `apps/runner`
Spec: `../spec.md`, sections 4 ("A personal runner joins") and 5.1

## What to build

- `apps/runner` becomes the `ostra` CLI (ADR 0046): `bin: { ostra: ... }`, `engines.node` `>=24.5` (ADR 0034, ADR 0046), and a root script `pnpm ostra` that runs it from source.
- Commands: `ostra runner` (start), `ostra runner status`, and an internal `ostra sidecar` mode reserved for ticket 22. `ostra login` and `ostra checkout` are later (F-103) and print that.
- **Config** from ticket 02's runner config: flags and `OSTRA_*` variables, the data folder (default under the user's config folder, `ostra/runner`).
- **Sign-in, the first time** (ADR 0029 as amended, Q115):
  1. `GET <server>/runner/v1/info`: refuse a server whose minor is outside the window, with the fix.
  2. The device flow against the panel's better-auth (`/api/auth/device/code`, then poll `/api/auth/device/token`), printing the user code and the panel's `/device` address. Never print the session token.
  3. Make an Ed25519 key pair with `node:crypto`. The private key is written to the data folder with owner-only permissions (on Windows, an ACL for the current user through `icacls` with an argument array), and never leaves the machine.
  4. `POST /runner/v1/register` with the session as a bearer token and the public key. Store the runner ID. Forget the session: the server revokes it.
- **Every connect after:** a signed assertion to `POST /runner/v1/token` for a 10-minute access token, held in memory only.
- `ostra runner status`: the runner ID, the server, the version window, and the last refusal reason if any.

## Port from

`spikes/auth-foundation/src/scenarios/device-code.ts` (the flow), `spikes/runner-transport/src/shared/auth.ts` (assertions), `src/runner/run-runner.ts` (args).

## Done when

- [ ] Against a fake server built from ticket 01's schemas: first sign-in registers and stores the key; a second start skips the device flow; a revoked runner gets a clear message.
- [ ] The private key file is readable only by its owner on this machine (checked in the test).
- [ ] No token or key appears in output or logs (a test captures both).
- [ ] The whole-repo checks pass (spec section 9: credentials).
- [ ] Committed as `✨ add the ostra CLI and runner sign-in`.

## Comments
