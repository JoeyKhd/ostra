# Spike 9: `auth-foundation`

Throwaway code that answers one question (`AGENTS.md`, milestone 0). Nothing here is product code, and its finding goes into `context/research/` only after real runs.

**Question.** Does better-auth give ostra organizations, usernames and runner sign-in on its stack?

**Tests the decisions.** Q35 (two roles per level), Q54 (username or email, plus a password), Q102 (many organizations, the first account is the instance admin), ADR 0026 (organizations, projects and access), and ADR 0003 as amended (the plugin list, the exact pin).

**Passes when** (copied from `context/build-order.md`):

- With Prisma 7 on Postgres: sign up, sign in by username and by email, two organizations with one member in both, an invite link with no mail server, an admin's reset link, and a device-code sign-in for a personal runner.
- A member of one organization can't read the other's rows.
- Strict typecheck passes, the version is pinned exactly, and a contract test (sign up, session, role) is green.

**If it fails:** sign in by email only, or ostra keeps its own invitations.

## Status: run on this machine, 2026-11-18

Windows 11, Node 24.14.0, pnpm 11.28, no Docker. Postgres 18.6 from `embedded-postgres`, started by the harness. better-auth 1.7.25, Prisma 7.10.1, TypeScript 7.0.2. No account, key or mail server was needed or used.

`pnpm spike`: **11 of 11 pass-bar criteria PASS, 0 FAIL, 0 SKIPPED.** The fallback is not needed on this stack. The run takes about 20 s.

| Pass-bar criterion | Result | What ran |
|---|---|---|
| Strict typecheck passes | PASS | `tsc --noEmit` with all 8 flags of `AGENTS.md`, generated Prisma client included, under TypeScript 7.0.2 (the spike's) and under the repo root's 6.0.3, about 2 s for both |
| the version is pinned exactly | PASS | `better-auth` is `1.7.25` with no range and is installed at that version; all 11 dependencies are exact, and the lockfile's root importer (parsed, not searched) records each at the version `package.json` names; `@better-auth/core` and `@better-auth/prisma-adapter` are installed at `1.7.25` too |
| With Prisma 7 on Postgres | PASS | the three Prisma packages are asserted to be 7.x; `prisma migrate deploy` applies the migration to Postgres 18.6; better-auth reads (a username lookup) and writes (a verification row created, read back and consumed) through the Prisma 7 client and `@prisma/adapter-pg` |
| sign up | PASS | username + email + password; signed in on sign-up; password stored as a hash; an account with no username, or an email-shaped one, is refused |
| sign in by username and by email | PASS | both reach one account in any case; a wrong password and an unknown name give the same answer; sign-out ends one session only |
| an invite link with no mail server | PASS | an admin creates an invitation for an address; the invitee signs up with the link's invitation ID and accepts, both over real HTTP; an address alone, a made-up ID and another address's ID are all refused at sign-up; single use; expired and foreign invitations refused. The link's URL format (`/accept-invitation/<id>`) is built and parsed back; the panel page that consumes it does not exist yet and is not tested |
| two organizations with one member in both | PASS | `dave`: one account, two memberships (member of acme, admin of globex); role and permissions follow the active organization |
| an admin's reset link | PASS | the instance admin creates a 24 h link; the member follows it and sets a password; old sessions revoked; single use; an organization admin cannot create one; a visitor's own request gets the same bare answer for a known and an unknown address |
| a device-code sign-in for a personal runner | PASS | over real HTTP, as the runner would: code, claim, approve, poll, bearer session; pending, `slow_down`, deny, expiry, reuse and a foreign client all refused; revocable from the panel |
| A member of one organization can't read the other's rows | PASS | 33 probes against ostra's rows and better-auth's, in both directions; see "Isolation" below |
| a contract test (sign up, session, role) is green | PASS | 14 of 14 Vitest tests, in `test/contract.test.ts`, on a database of their own |

Beyond the pass bar (the decisions above, and the harness's own honesty):

| Check | Result | Note |
|---|---|---|
| ADR 0026, Q35, Q102: two organization roles, a separate instance admin, organization creation gated | PASS | |
| Q102: the first account is the instance admin, even when several arrive at once | PASS | 6 simultaneous sign-ups on an empty install: exactly 1 admin |
| `AGENTS.md` type rules, by ESLint | PASS | the repo root's ESLint 10.15.0 with `eslint.config.mjs` (the root config's rules without its `spikes/**` ignore): typescript-eslint strict-type-checked and stylistic-type-checked, no `any`, no assertions, exhaustive switches, async APIs, no classes, no enums. No message at all. SKIPPED, naming `pnpm install` at the repo root, when the root is not installed |
| `AGENTS.md` type rules that tsc cannot see (a scan) | PASS | a regex scan behind ESLint, for where the root is not installed. It first has to catch 12 planted violations (`Record<string, any>`, `<string>value`, `x! ;`, a split `as`, `@ts-ignore`, ...), or the row FAILS |
| the same run on a Postgres of your own | **SKIPPED** | needs `DATABASE_URL`: a server on which the spike may create and drop a database. Everything above ran on the embedded Postgres only |
| no postgres process or cluster data left behind by this run | PASS | no postgres of this spike running, no cluster directory, no password file in `.data`. The check fails if it cannot list processes, and counts only this spike's own `.data` |

`pnpm mutation-check` (1 min 40 s) removes 17 protections one at a time, each on a copy of the spike (`.data/mutation-<pid>-<n>/`, with `node_modules` linked in), never on the real files: a type error in `ids.ts`, a ranged `better-auth` pin, the `user` table, the username normalisation, the sign-up gate (opened to strangers; an address with no invitation ID; an ID with no address), the `owner` role hook, the membership index, the reset-link permission, the device-code client check, the organization filter of a read, the membership guard, the composite foreign key, a column of the migration, the first-account promotion. The row that depends on each turned FAIL every time (**17 of 17 caught**), and **11 of 11 pass-bar rows have a mutation** (the first version covered 7 of the 11: no mutation targeted the typecheck, the pin, Prisma on Postgres or sign-in). So the PASS rows above can fail.

A fresh copy of this directory (sources and lockfile only, in `.data/fresh/`), `pnpm install --frozen-lockfile` (3.7 s) and `pnpm spike` gave the same result: 11 of 11 pass-bar rows PASS, ESLint included, and `pnpm typecheck` generated the missing Prisma client before compiling.

## Run it

```
cd spikes/auth-foundation
pnpm install            # pnpm 11 build scripts are allowed in pnpm-workspace.yaml
pnpm check:inputs       # which inputs are set; never prints a value
pnpm db:generate        # the Prisma client is generated code (src/generated/, gitignored): needed once
pnpm spike              # every criterion, PASS / FAIL / SKIPPED; exit 1 on any FAIL. Runs db:generate itself
pnpm test               # the contract test alone (generates the client if it is missing)
pnpm typecheck          # db:generate, then tsc alone
pnpm mutation-check     # optional, about 2 minutes, on copies of the spike
```

Node 24's type stripping runs the TypeScript directly: there is no `tsx`, no build step.

| Criterion | Inputs it needs |
|---|---|
| every pass-bar criterion | none. With no `DATABASE_URL`, an embedded Postgres starts on a free port on 127.0.0.1 and is removed afterwards |
| the same run on a Postgres of your own | `DATABASE_URL` pointing at a server where the role may `CREATE DATABASE`. The spike makes `ostra_spike_<random>` there and drops it |
| ESLint | the repo root installed (`pnpm install` at the repo root): its ESLint and typescript-eslint are used, the spike installs neither |
| (optional) | `BETTER_AUTH_SECRET` (32+ characters), read by `pnpm spike` and by the contract test; unset, a random secret per run. There is no base-URL setting: the harness serves better-auth on a loopback port it picks |

This spike needs no model endpoint, no `LINEAR_*`, no `GITHUB_*` and no mail server. On Windows, keep the checkout path short: Postgres' tools cannot open paths over 260 characters, and the embedded cluster's binaries sit deep in `node_modules\.pnpm\`. The path to this directory in the repo is well inside the limit; a copy under a long temp path was not. The harness says so when it happens.

**Where it writes.** Only inside this directory: `node_modules/`, `src/generated/` (the Prisma client), and `.data/` (clusters, the throwaway password file in `.data/tmp/`, the Vitest report, mutation copies), all gitignored. The embedded Postgres' password file is written to `.data/tmp/` (the temp variables point there for the length of `initdb`), not to the system's temp directory, so a hard kill cannot leave it outside. A run that is killed leaves its Postgres and clusters to the next start, which reaps only clusters whose owning run is gone and whose postmaster's command line names the cluster directory. A second run at the same time is left alone.

`pnpm spike --mutation-run` is an internal flag of `pnpm mutation-check` (it leaves the two source-rule rows out). Do not use it for a real run.

## Architecture

```
src/auth/create-auth.ts       better-auth on the Prisma adapter: the plugins and ostra's hooks (the invite-only sign-up gate among them)
src/auth/roles.ts             the two organization roles, and the check that keeps "owner" out
src/auth/link-sink.ts         hands a reset link back to the admin who asked (no mail to send it by)
src/db/                       Prisma client (pg adapter), embedded Postgres, migrate, first-account lock
src/ostra/organization-scope  requireMember: session + member row -> a MemberScope; nothing else queries
src/ostra/work-store.ts       Project and Task, read and written only through a MemberScope
src/ostra/admin-actions.ts    the invite link and the admin's reset link
src/http/auth-server.ts       better-auth on a loopback port, for the runner and invite scenarios
src/scenarios/                one file per pass-bar bullet; each throws if its claim does not hold
src/criteria.ts               the report's rows, named once (the harness and the mutation check share them)
src/checks/                   typecheck, pin, ESLint, the scan, the contract test, the leftovers check
src/spike.ts                  the harness; src/mutation-check.ts proves it can fail
test/contract.test.ts         the contract: sign up, the session, a role, the schema, the pin
prisma/schema.prisma          better-auth's models, from its generator, plus ostra's Project and Task
eslint.config.mjs             the repo's ESLint rules, applied to this spike (the root config ignores spikes/**)
```

Plugins: `username`, `admin`, `organization`, `deviceAuthorization` (the four of ADR 0003) and `bearer` (see below). The harness builds one installed instance (a migrated database, better-auth over it, the same better-auth served on a loopback port), and the scenarios run on it in order, each using the people the one before made. IDs are branded (`UserId`, `OrganizationId`, `ProjectId`, `TaskId`, `InvitationId`) and parsed where they enter ostra's code: a Prisma row, a request, better-auth's response.

### The schema

`prisma/schema.prisma` holds the models from better-auth's generator, `pnpm dlx auth@1.7.25 generate --config auth-cli.ts --output <file> -y`, for exactly the plugins in `create-auth.ts`. Edits on top, each marked `ostra:` in the file:

- a unique `(organizationId, userId)` on `Member`. The generated schema allows a user to be a member of one organization twice.
- `Project` and `Task`, both with `organizationId`. `Task` references `Project` by `(projectId, organizationId)`, so a task in another organization's project is impossible in the database.

The first migration is `prisma migrate diff --from-empty --to-schema` written out. The contract test compares the live database with `getAuthTables()`, so a better-auth upgrade that adds a column fails there, not at the first query that touches it. Re-running the generator against this schema finds no field missing.

## What the run showed

These are observations from one machine. Each is something ostra's design depends on.

**Prisma 7**
- `prisma.config.ts` carries the datasource URL now. `prisma migrate diff` prints an empty script and exits 0 when the config has no datasource, so the config here always sets one (a placeholder that fails the moment a command really connects).
- The `prisma-client` generator's TypeScript runs unchanged under Node 24 type stripping (`importFileExtension = "ts"`) and passes all the strict flags, `exactOptionalPropertyTypes` included.
- `$queryRaw` on a function that returns `void` (`pg_advisory_xact_lock`) fails with the driver adapter ("Failed to deserialize column of type void"). `$executeRaw` works.
- pnpm 11 will not run install scripts until they are allowed: `prisma`, `@prisma/engines` and `@embedded-postgres/windows-x64` are listed under `allowBuilds`.

**Usernames (Q54).** The username plugin fits. It stores the name lower-cased and keeps the typed form as `displayUsername`. Its default validator allows letters, digits, `_` and `.`, so a username never contains `@`, and a single login field can route on `@`. Two things ostra must add:
- The plugin makes the username optional. The `user.create.before` hook here refuses an account without one on every path (sign-up, an admin creating a user).
- The library has no invite-only mode, and `disableSignUp` would block invitees too. A `before` hook on `/sign-up/email` lets through the first account, an invitee, or anyone when open sign-up is on. **An invitee is recognised by the invitation ID, not by the address**: the panel's sign-up page reads the ID from the invite link and sends it in the `x-ostra-invitation` header, and the hook looks up a pending, unexpired invitation with that ID *and* that email. Matching the address alone (the first version of this spike) let a stranger who knew an invited address sign up as it first, with no proof of the mailbox, because there is no mail server to prove it. Six simultaneous sign-ups on an empty install all got through, because each saw zero accounts. Exactly one became admin.

**Invites (no mail server).** better-auth sends mail only through `sendInvitationEmail`, which is not set. The link is ostra's: `/accept-invitation/<invitationId>`. An invitation is bound to an email address, and accepting needs a session with that address, so the admin types the invitee's address even when nothing is mailed. An open "anyone with this link" invite does not exist in the library. The ID in the link is a bearer secret: whoever holds the link can sign up as the invited address (open point 6).

**Reset links.** The admin plugin has `set-user-password` but no "create a reset link". The link here is `requestPasswordReset` with `sendResetPassword` writing into a per-request sink (`AsyncLocalStorage`), so the caller who asked gets the URL. It is valid for 24 h (set to outlive a chat message), single use, and revokes the member's sessions. A visitor asking for a reset themselves gets a bare `{status, message}` that is identical for an address with an account and one without, and no link anywhere, on an install with no mail, which is Q54's rule.

**Device flow.**
- The standalone plugin returns an ordinary session token. Using it as `Authorization: Bearer` needs the `bearer` plugin, which is not on ADR 0003's list. `auth.api.getSession({ headers })` then identifies a runner exactly as it identifies a browser.
- better-auth 1.7 adds a step: the member opens `GET /device?user_code=` while signed in, which claims the code for them. Only that member can then approve or deny it, so another signed-in member who holds the user code cannot.
- The runner's session shows in the member's session list with the `User-Agent` the runner sent, so the panel can label and revoke it.
- **The token is a full session**: seven days, sliding, and it can do whatever the member can (it lists the member's organizations). `scope` is stored on the device code but not enforced. See the open points.

**Roles (ADR 0026).** Registering only `admin` and `member`, with `creatorRole: "admin"`, gives two roles, and the types carry them (an invitation for `owner` does not compile). At runtime better-auth still accepts the name `owner`, because it keeps its built-in names valid whatever you register, and it also accepts a list such as `admin,member`. A member with a role ostra never defined would have no permissions. The `organizationHooks` here refuse any role that is not exactly `admin` or `member`. The instance admin is the admin plugin's `user.role`, separate from `member.role`.

**First account (Q102).** The promotion runs in `user.create.after` under a Postgres advisory lock, which is what makes "exactly one admin" hold under concurrent sign-ups. The sign-up response still reports `role: "user"`: the session says `admin`, so the panel reads the session after sign-up.

**Isolation.** ostra's reads take a `MemberScope`, which only `requireMember` makes, from the session and the `member` table, on every request (removing a member cuts them off at their next request, with the session still valid). Probed from inside one organization against the other, in both directions: the guard, scoped reads, guessed row IDs for read, rename, delete and file-a-task-under, a raw insert of a task under another organization's project (refused by the composite foreign key), and ten better-auth endpoints (the organization, its members and invitations, `setActive`, invite, update, role change, remove, delete). All refused or empty, and nothing changed behind the refusals. "Not a member" and "no such organization" answer identically.

**Typing.** The whole better-auth API is typed from the plugin config, including the role names. The org plugin's hook parameters carry `Record<string, any>`, so the hooks narrow with `Reflect.get(...)` into `unknown`; there is no `any`, no `as` and no `!` anywhere in this spike's own code, which ESLint's strict-type-checked set confirms. Rows from `$queryRaw` and the `pg` driver are parsed with Zod, not typed by a generic argument.

## Open points for the maintainer

These are decisions the spike cannot make. They belong in `context/open-questions.md`.

1. **The personal runner's credential.** The device flow's result is a full member session. ADR 0029 only says a personal runner signs in from a terminal. Is a full session acceptable, or should the runner hold a narrower credential (better-auth's API-key plugin, or a token ostra mints after the device flow)?
2. **Who may create a reset link.** An account belongs to every organization its owner joined, so an organization admin who could reset a password could take over an account in organizations they do not administer. This spike allows only the instance admin. Q54 says "an admin" without saying which.
3. **A fresh install belongs to whoever reaches it first.** The first account becomes the instance admin (Q102). On a public address, anyone can race the owner to the sign-up page. A setup token printed in the server log would close it.
4. **The plugin list.** ADR 0003 names four plugins; this spike also uses `bearer`. It adds no dependency.
5. **Dependencies the spike added** (below): `@prisma/adapter-pg` is not named by any ADR, though Prisma 7 requires a driver adapter.
6. **An invite link is a bearer secret, and a mailbox is never verified.** The invitation ID in the link is what admits a sign-up (with the invited address), so whoever gets the link first can create the invited account, and the real invitee then meets "email already exists". With no mail server there is nothing better: the admin hands the link over, and the link is the proof. The risks are a link pasted into a channel others can read, and a link that is never used. Options: a short life for the link (it is seven days now), a revoke button in the panel (the invitation can be cancelled), or sending the secret on a second channel. Also: `requireEmailVerification` is off, so an invitee's address is whatever the admin typed.

## Dependencies

All exact. Licenses are from the npm registry.

| Package | Version | License | Why |
|---|---|---|---|
| `better-auth` | 1.7.25 | MIT | the subject; brings `@better-auth/prisma-adapter` 1.7.25 (MIT) |
| `@prisma/client` | 7.10.1 | Apache-2.0 | Prisma 7 client |
| `@prisma/adapter-pg` | 7.10.1 | Apache-2.0 | the driver adapter Prisma 7 needs for Postgres |
| `pg` | 8.23.1 | MIT | the driver, and the harness's admin connection |
| `zod` | 4.6.7 | MIT | boundaries: env, the runner's HTTP responses, ids, database rows, reports |
| `prisma` (dev) | 7.10.1 | Apache-2.0 | `generate`, `migrate deploy`, `migrate diff` |
| `embedded-postgres` (dev) | 18.6.0-beta.19 | MIT | a real Postgres on a machine with no Docker. Its platform package (`@embedded-postgres/windows-x64`, MIT) carries the PostgreSQL binaries |
| `typescript` (dev) | 7.0.2 | Apache-2.0 | the strict typecheck |
| `vitest` (dev) | 5.1.0 | MIT | the contract test |
| `@types/node` (dev) | 24.19.2 | MIT | types |
| `@types/pg` (dev) | 8.23.1 | MIT | types |

Not dependencies of the spike, used when present: the repo root's `eslint` 10.15.0 (MIT), `typescript-eslint` 8.73.0 (MIT) and `eslint-plugin-unicorn` 80.0.0 (MIT), which `eslint.config.mjs` imports and `pnpm spike` runs, and the root's `typescript` 6.0.3 (Apache-2.0), used for a second typecheck. Used once: `auth@1.7.25` (MIT), better-auth's CLI, through `pnpm dlx`, to generate the schema.

## What's left

- **Run it on Linux and macOS.** Only Windows 11 was available. The harness has Linux and macOS branches for process handling that have not run.
- **Run it on a real Postgres** (`DATABASE_URL`), and on the Postgres versions ostra will support.
- **The panel's side of an invite.** The page behind `/accept-invitation/<id>`, and the sign-up form that sends the ID, are not built. The scenarios make the same HTTP calls such a page would.
- **Isolation in the database.** Row-level security as a second wall behind the scoped store was not tried. It would need a non-superuser role and a `set_config` per transaction.
- **Rate limits.** better-auth rate-limits sign-in in production only, and this spike runs outside production. The limits, and their storage across several replicas, are untested.
- **The browser side.** No Next.js, no cookies over HTTPS, no cross-origin panel, no tRPC context. Everything ran against `auth.api` or `auth.handler` on a loopback port.
- **Project roles and restricted projects** (F-087). Only the organization level is covered.
- **Upgrade path.** Moving from 1.7.25 to 1.8: the contract test is the gate, and has not been tried on a newer version.
- Then the finding goes into `context/research/`, with this README's observations cited against real runs.
