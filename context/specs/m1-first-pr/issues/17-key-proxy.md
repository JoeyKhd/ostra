# 17: The key proxy

Status: resolved
Builder: runner
Blocked by: 02, 12
Features: F-089
Packages: `apps/runner` (`src/sidecar/key-proxy.ts`)
Spec: `../spec.md`, sections 2 and 4

## What to build

The key proxy of ADR 0030, as a module the task host starts per task (ticket 21). On `host` it listens on loopback; on `docker` it listens on the box's network (ticket 22).

- A fake key per task: `ostra-fake-` plus at least 128 random bits, with an expiry, revoked when the session ends.
- On each request: check the fake key, strip every client credential header, set the real one (`Authorization: Bearer` or `x-api-key`, from the task's credentials), open its own TLS connection to the provider.
- Pass the stream through byte for byte: no buffering, headers and body fields unchanged, keep-alive events kept, error bodies as received. Both API formats.
- Count the tokens of **every** call it carries, title calls and other tool-less calls included (ADR 0030 as amended), with ticket 12's usage parser, and emit `usage.recorded` per call, with `estimated` when the stream had none.
- A provider's rate-limit answer is reported (its retry time) so the server holds new dispatches on that provider. An upstream 401 or 403 fails the task at once, with a typed reason.
- Logs carry the task ID, status and counts only.

## Port from

`spikes/how-should-the-runner-drive-opencode/src/lib/key-proxy.ts`, `usage.ts`, `sse.ts`, and `test/key-proxy.test.ts`.

## Done when

- [ ] Against both stub formats: the stream reaches the client byte-identical; the counts match the stubs exactly; a wrong or expired fake key gets 401 and never reaches upstream; a client's own `Authorization` is stripped; a rate-limit answer is reported with its retry time; the no-usage stream is counted as estimated.
- [ ] With `model.env` loaded: one call through the proxy, and its count within 2% of the endpoint's own figure (gated test).
- [ ] A test proves the real token is in no log line, error or event.
- [ ] The whole-repo checks pass (spec section 9: credentials).
- [ ] Committed as `✨ add the key proxy`.

## Comments

- 2026-11-18, runner: done in d2f956e (`✨ add the key proxy`). `src/sidecar/key-proxy.ts`, on ticket 12's usage parser: a fake key of 192 random bits with an expiry, every client credential header dropped, the real one set by auth scheme, its own keep-alive connections to the provider, byte-for-byte pass-through (keep-alives, vendor fields and error bodies), a `usage.recorded` for every model call (estimated when the stream had none), `Retry-After` parsed, and an upstream 401 or 403 reported as the task's typed failure. Tested against both stub formats and a raw upstream; the gated live call matched the endpoint's own figure exactly. **Gap:** the protocol has no event or frame for a provider's rate limit, so the task host logs it (provider, status, retry time) but can't yet tell the server to hold dispatches. That's a contract addition for core and the panel to agree on. Whole-repo checks green.
