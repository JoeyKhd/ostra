# 30: Auth, the first admin and organization scope

Status: done
Builder: api
Blocked by: 08
Features: F-002 (the first admin), F-001 (the setup token), F-076 (the checklist's state), F-014 (device approval)
Packages: `packages/api` (`src/auth/`, `src/trpc/`, `src/routers/setup.ts`), `packages/domain` (`createFirstAdmin`)
Spec: `../spec.md`, sections 2, 3 (step 2) and 4

## What to build

- **better-auth** 1.7.25 (exact pin) on Prisma, configured in `packages/api/src/auth/` so `apps/web` serves it and `apps/core` can validate a session with the same code. Plugins: username, organization (roles `admin` and `member` only), device authorization (client ID `ostra-runner`), admin, bearer (ADR 0003 as amended).
- **ostra's own pieces** (ADR 0003, "What better-auth lacks"):
  - **Invite-only sign-up:** a `before` hook on the sign-up path lets through the first account (with the setup token) or anyone when `OSTRA_OPEN_SIGNUP_ACCOUNTS` is on. Invitees come in milestone 4 (F-002); the hook refuses them for now with a clear message.
  - **The setup token** (F-001, Q117): `OSTRA_SETUP_TOKEN`, or one generated at first start and printed in the web server's log with the panel's address. Compared in constant time. It stops working once the first account exists.
  - **The first account** becomes the instance admin and the admin of the first organization, which ostra creates with it, under a Postgres advisory lock so only one account ever gets it (`createFirstAdmin`).
  - **The `owner` role block:** organization hooks refuse any role that isn't exactly `admin` or `member`.
  - The username is mandatory.
- **The device approval** server side: the plugin's verify and approve endpoints, with the approving member's active organization recorded so core's `register` puts the runner there (ticket 24).
- **tRPC 11** setup: the context resolves the better-auth session, the member and the active organization; `memberProcedure`, `adminProcedure` and `projectProcedure` use ticket 08's access checks. Every procedure's output is organization-scoped.
- **`setup.status`:** the checklist's steps and which are done (an admin exists, a provider, a GitHub connection, a project, a runner online, a first task), derived from the tables.
- A contract test: sign up the first admin with the token, sign in by username and by email, a session has the role, a second sign-up is refused, the token is dead after use. It's the upgrade gate for better-auth (ADR 0003).

## Port from

`spikes/auth-foundation/src/auth/create-auth.ts`, `roles.ts`, `src/ostra/organization-scope.ts`, `src/scenarios/first-account.ts` (and its surprise 2, the first-account race), `test/contract.test.ts`.

## Done when

- [ ] The contract test passes, and a race of two first sign-ups gives one admin.
- [ ] Every procedure helper has a test that another organization's member gets `FORBIDDEN`.
- [ ] The setup token and `BETTER_AUTH_SECRET` never appear in a log except the one setup line, which prints the token once at first start.
- [ ] Their lines are in `docs/configuration.md`.
- [ ] The whole-repo checks pass (spec section 9: auth).
- [ ] Committed as `✨ add auth and the first admin`.

## Comments

- 2026-11-18 (api): done in `72731e0` (`✨ add auth and the first admin`), with the setup-time hooks finished in `be27ef8` and `552563b`. better-auth 1.7.25 on Prisma 7.10.1, configured in `packages/api/src/auth/` and exported as `@ostra/api/auth`; `createApiRuntime` is what `apps/web` builds once per process. The contract test (`auth.contract.test.ts`) is the upgrade gate: the pin is exact and the installed version equals it, sign-in by username and by email, the device flow to a bearer session in the approving member's organization, the `owner` role refused. A race of six first sign-ups gives one admin and one organization.
- Two choices differ from the ticket's wording. (1) The better-auth sign-up route stays closed even for the first account: the first admin is made by `setup.createFirstAdmin`, which checks the token in constant time and then creates the account, its organization, its admin membership, the built-in OpenCode profile and the default pool in one transaction under the advisory lock. Letting the route make the account would leave an admin with no organization if the process died between the two writes. (2) `CreateFirstAdminDeps` gained `hashPassword` (better-auth's, passed in) so `packages/domain` doesn't import the auth library; the stub had no caller, so the change breaks nothing.
- `BETTER_AUTH_SECRET` and the setup token are generated on first start and kept in `OSTRA_DATA_DIR` (mode 0600), so a restart and a second web process agree. The setup line goes through its own writer, not the structured logger, whose guard redacts the `ostra-setup-` prefix on purpose; a test checks that the token and a password reach no log line.
- Whole-repo checks: typecheck, lint and tests of `packages/api` and `packages/domain` pass, and `pnpm check:licenses` holds. At the time of the commit `apps/web` and `apps/runner` were other builders' work in progress.
