# 26: Dispatch, leases and task credentials

Status: resolved
Builder: core
Blocked by: 13, 14, 25
Features: F-013, F-014 (choosing the personal runner), F-089 and F-090 (credentials), F-088 (allow on personal runners, the sessions cap)
Packages: `packages/domain` (`dispatchTask`, `acceptOffer`, `issueTaskCredentials`), `apps/core` (`src/dispatch/`, `src/credentials/`, the Postgres `SecretRowStore`)
Spec: `../spec.md`, sections 3 and 4

## What to build

- **`task.dispatch` job:** read the queued task `FOR UPDATE SKIP LOCKED`. Milestone 1's choice: the personal runner the member picked (it must be theirs, online, with a free slot), or else a pool runner of the project's pools with a free slot. The provider must allow personal runners when the runner is personal, and be under its sessions-at-once cap and not held by a rate-limit wait. Then: create the lease (raise the epoch), the box row, write the `dispatch` command to the outbox, move the task to preparing, all in one transaction. No runner fits: stay queued and say why on the task.
- **`task.offer-timeout`:** an offer not accepted in 2 minutes goes back to the queue. `accepted` and `rejected` acks come through ticket 24.
- **`GET /runner/v1/tasks/:taskId/spec`:** the task spec (ticket 02), for the lease holder only. It includes the bot identity from the GitHub adapter, the repo's PR template, the co-author (the prompting member's name and email: spec section 11, item 4), the LFS hosts from the adapter's capability, and the branch name rule (section 11, item 10).
- **`POST /runner/v1/tasks/:taskId/credentials`:** after checking the access token's runner holds the current epoch: the provider's token from the secret store, a git token per repo minted narrowed to that repo and `contents: write` (ticket 13), the environment's secrets per repo, and the MCP bearer. Logged as IDs only; a test proves the body never reaches a log.
- **The Postgres `SecretRowStore`** for the built-in secret store (ticket 14), on the `Secret` model, with the key from `OSTRA_SECRETS_KEY` or generated into `OSTRA_DATA_DIR` at first start (spec section 11, item 1). Its line in `docs/configuration.md`.
- **Rate-limit holds:** a `usage.recorded` or failure event that carries a provider's retry time holds new dispatches on that provider until then.

## Done when

- [ ] Tests: a task for a personal runner goes only to that member's runner; a provider not allowed on personal runners blocks it with a reason; a stale epoch gets no credentials; an offer timeout requeues; a rate-limit hold delays the next dispatch.
- [ ] Gated on `github.env`: the minted token works for `test1` and not for `test2`.
- [ ] Every test checks another organization's runner and secrets stay out of reach.
- [ ] The whole-repo checks pass (spec section 9: credentials).
- [ ] Committed as `✨ add dispatch, leases and task credentials`.

## Comments

- 2026-11-18, core: done in the commit that carries this line (`✨ add dispatch, leases and task credentials`), on top of 778ecc3 (`✨ add dispatch notes and provider holds to the db`: two nullable columns, `Task.dispatchNote` and `ModelProvider.dispatchHeldUntil`, additive). Domain: `dispatchTask` (the task row `FOR UPDATE SKIP LOCKED`, a busy one retried by the queue; the member's own personal runner when one was picked, else a pool runner of the project's pools or the default pool; online, present and with a free slot; the provider allowed on personal runners, under its sessions-at-once cap and not held; then box, lease, epoch, the `dispatch` command and the offer timer in one transaction; no runner → stays queued with `dispatchNote`), `acceptOffer`, `issueTaskCredentials` (the provider's token, a git token per repo narrowed to it with `contents: write` and `metadata: read`, the environment's secrets per repo, an MCP token core signs; audited, never logged). Core: `src/dispatch/` (the workers, the offer timeout, a 5 s requeue sweep, the spec and credentials endpoints), `src/secrets.ts` (the `Secret` rows and the key in `OSTRA_DATA_DIR/secrets-key`, the same file the panel uses), the server's adapters. **Two choices to confirm:** the task stays `queued` while the offer is out and moves to `preparing` on the runner's acceptance, as the domain's lifecycle and `acceptOffer`'s seam say (the ticket says preparing at dispatch); and the rate-limit hold is stored and enforced, but no protocol event carries the key proxy's report from the runner yet: its `onRateLimited` needs a `provider.rate_limited` event kind (a protocol change that touches the task-view's exhaustive switches), to schedule with the runner and web builders. 9 tests with fake adapters plus the gated live one, run here with `github.env`: the minted token reads `test1` and not `test2`. Whole-repo checks green.
- 2026-11-19, core: the rate-limit hold has its caller. `ingestEvents` handles the runner's `provider.rate_limited` event by holding the session's own provider (`holdProviderInTx`, now in `@ostra/domain`) until now plus the retry seconds; an event naming another provider, of this organization or another, is stored and holds nothing. Tested: a 429 holds the next dispatch, another organization's provider and another provider of the same organization are untouched, and a shorter hold never shortens a longer one.
