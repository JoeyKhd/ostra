# 26: Dispatch, leases and task credentials

Status: ready-for-agent
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
