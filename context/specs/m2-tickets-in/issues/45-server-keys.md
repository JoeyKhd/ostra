# 45: Check the secrets key at start, and a setting for the runner-token key

Status: ready-for-agent
Builder: core
Blocked by: none
Features: F-001, F-118 (what its chart will set)
Packages: `apps/core` (`src/secrets.ts`, `src/gateway/keys.ts`), `apps/web` (`src/server/deps.ts`), `packages/domain` (`settings.ts`), `packages/db` (one additive column or row), `docs/configuration.md`
Spec: `../spec.md`, section 7 (follow-ups); `../../m1-first-pr/spec.md`, section 11 (item 1)

## Why

Settled as Q136, item 1, on 2026-11-19 (`context/open-questions.md`, Settled). The server generates its keys on first start and keeps them in `OSTRA_DATA_DIR`, so a fresh install needs no setting. That stays. Two failures it invites have no guard:
- **A database without its key:** a restore onto a new machine, or a second server process with a data folder of its own. Every stored token is then unreadable, and the first sign is a task that fails when it asks for credentials.
- **Two core replicas without a shared folder:** the key that signs runners' access tokens has no setting, so each replica makes its own and refuses the other's tokens. ADR 0034 says any replica serves any request.

## What to build

- **A check value.** The first time an install uses a secrets key, the server stores a small value encrypted with it, per key version. At every start, core and the panel decrypt it. A key that can't: the process refuses to start, says that this key isn't the one the database's secrets were written with, and names the two fixes (set `OSTRA_SECRETS_KEY`, or restore `secrets-key` in the data folder). Several processes starting at once on an empty install end with one value that all of them can read, under the advisory lock the first admin's seed takes.
- **`OSTRA_RUNNER_TOKEN_KEY`:** the key core signs runners' access tokens with, as a setting with today's behaviour as its default (generated into the data folder). Its line in `docs/configuration.md`.
- **The docs** name the three settings every server process must share when the processes don't share a data folder: `OSTRA_SECRETS_KEY`, `BETTER_AUTH_SECRET` and `OSTRA_RUNNER_TOKEN_KEY`.
- **No check for the other two keys.** Changing `BETTER_AUTH_SECRET` signs everyone out and a new runner-token key makes every runner ask for a new token: both are allowed, so neither refuses a start.

## Done when

- [ ] Tests: an empty database starts and stores the check; the same key starts again; another key refuses to start, with the message, and changes nothing; two processes racing on an empty database end with one check value that both read.
- [ ] Two cores with separate data folders and the same `OSTRA_RUNNER_TOKEN_KEY` accept each other's tokens. A control without the setting shows the refusal.
- [ ] The settings test still matches `docs/configuration.md`.
- [ ] Proof (`AGENTS.md`, `context/proof/README.md`): each test that proves a condition of a row's "done when" names the row's ID in its title and has a break-it check, its rows are in `context/proof/`, and `pnpm check:proof` passes.
- [ ] The whole-repo checks pass (spec section 9: credentials).
- [ ] Committed as `✨ check the secrets key at start`.

## Comments
