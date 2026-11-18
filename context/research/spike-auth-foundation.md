# Research: Spike 9, `auth-foundation`: organizations, usernames and runner sign-in on better-auth

**Status:** Research, 2026-11-18. Feeds ADR 0003 (web panel with better-auth), ADR 0026 (organizations, projects and access), ADR 0029 and ADR 0034 (how a runner signs in), Q35, Q54 and Q102, and F-001, F-002, F-003, F-004, F-013, F-049 and F-087.
**Method:**
- I ran `pnpm spike` in `spikes/auth-foundation/` on 2026-11-18, on Windows 11 with Node 24.14.0. Every result marked "run" comes from the first run. The timings in this file are that run's, and they move from run to run.
- I re-ran `pnpm spike` four more times to check this file. Each of the four re-runs gave 11 PASS, 0 FAIL, 0 SKIPPED on the pass bar and 5 PASS, 0 FAIL, 1 SKIPPED beyond it, in 18.6 to 19.8 s. The one number that differed from the first run's is the first-account count (Surprise 2).
- I read the spike's code, tests and README as committed in `544383e`. The working tree of `spikes/auth-foundation/` matched that commit when I checked.
- I read the official docs of better-auth, Prisma and RFC 8628, asked the npm registry (`npm view`), and read the installed better-auth 1.7.25 and `@better-auth/prisma-adapter` 1.7.25 sources in `SPIKE/node_modules/`, all on 2026-11-18. A cite to `PKG/...` is a file under `SPIKE/node_modules/better-auth/dist/`.
- Anything I didn't rerun is marked "README, not rerun". Anything I couldn't confirm against a primary source is marked **unverified**. "Inferred" means I read the code or docs and didn't run it.

**Source links.**
- `SPIKE` means `spikes/auth-foundation`. A cite like `SPIKE/src/auth/create-auth.ts:129-160` is a file and its lines.
- `RUN` means the output of today's first `pnpm spike`, cited by row title. The four re-runs reproduced its results.
- `PASSBAR` means the spike's pass bar in `context/build-order.md`, lines 176-183.
- `DOCS` pages are better-auth's, under `https://www.better-auth.com/docs/`.

---

## Facts (checked 2026-11-18)

| Thing | Version | License | Note | Source |
|---|---|---|---|---|
| `better-auth` | 1.7.25, exact pin | MIT | npm `latest` is 1.7.25. `beta` is 1.8.0-beta.10 | `SPIKE/package.json:21`; `npm view better-auth dist-tags` |
| `prisma`, `@prisma/client`, `@prisma/adapter-pg` | 7.10.1, exact pins | Apache-2.0 | npm `latest` for `prisma` is **8.0.0-rc.34**. 7.10.1 sits under the `prev` tag | `SPIKE/package.json:19-20,29`; `npm view prisma dist-tags` |
| `pg` | 8.23.1 | MIT | the driver under the adapter | `SPIKE/package.json:22` |
| Postgres | 18.6, from `embedded-postgres` 18.6.0-beta.19 | PostgreSQL / MIT | started by the harness, no Docker | RUN, "With Prisma 7 on Postgres" row; `SPIKE/package.json:28`; `npm view embedded-postgres@18.6.0-beta.19 license` |
| TypeScript | 7.0.2 in the spike; 6.0.3 at the repo root | Apache-2.0 | the strict check passes under both | RUN, "Strict typecheck passes" |
| Node | 24.14.0 | MIT | runs the `.ts` files directly | RUN header; `SPIKE/package.json:7-9` |

---

## 1. The question, and the answer

**Question.** Does better-auth give ostra organizations, usernames and runner sign-in on its stack? It tests Q35 (two roles per level), Q54 (username or email, plus a password), Q102 (many organizations, the first account is the instance admin), ADR 0026 and ADR 0003 as amended (`SPIKE/README.md:7`; `PASSBAR`).

**Answer.** Yes, with several pieces that ostra has to write itself. All 11 pass-bar rows pass in today's first run (11 PASS, 0 FAIL, 0 SKIPPED, 19.1 s) and in four re-runs, so neither fallback in `PASSBAR` is needed: members can sign in by username and by email, and Q54 stands as decided. The organization plugin gives Q35's two organization roles and Q102's several organizations per account, and the device-code flow signs a personal runner in. better-auth doesn't give ostra four things, and the spike writes them: invite-only sign-up, an admin's reset link, a guard that keeps the `owner` role out, and "the first account is the instance admin". The spike also writes a hook that makes the username mandatory (the plugin leaves it optional, `SPIKE/README.md:122`), the scoped store that carries the isolation, and two schema edits (Gotcha 9). Two results need a decision. The device flow returns a full member session, not a narrow runner credential. And the isolation that passed is held by ostra's code, better-auth's own endpoint checks and one composite foreign key, not by anything in the database that stops a raw query. The run was on one machine (Windows 11), on an embedded Postgres, with no browser. Linux, macOS, a Postgres of our own and the panel's side of every flow are still open (section 5).

---

## 2. Results per pass-bar criterion

`PASSBAR` is three bullets. The harness splits them into 11 rows, named once in `SPIKE/src/criteria.ts:6-18`. A row that can't run is recorded as a FAIL, never left out of the table (`SPIKE/src/spike.ts:72-75,321-330`).

| # | Row | Result | Time (first run) | Evidence in one line |
|---|---|---|---|---|
| 1 | Strict typecheck passes | **PASS** | 1,913 ms | `tsc` 7.0.2 and 6.0.3 clean with all 8 flags of `AGENTS.md`, generated Prisma client included |
| 2 | The version is pinned exactly | **PASS** | 3 ms | `better-auth` 1.7.25, no range, installed and locked; all 11 dependencies exact |
| 3 | With Prisma 7 on Postgres | **PASS** | 922 ms | Postgres 18.6, 1 migration, 11 tables; better-auth reads and writes through Prisma 7.10.1 |
| 4 | Sign up | **PASS** | 142 ms | username, email and password; signed in; password hashed |
| 5 | Sign in by username and by email | **PASS** | 300 ms | both reach one account, in any case |
| 6 | An invite link with no mail server | **PASS** | 147 ms | admin creates it, invitee signs up with its ID and accepts, over HTTP |
| 7 | Two organizations with one member in both | **PASS** | 185 ms | one account, two memberships, a role in each |
| 8 | An admin's reset link | **PASS** | 223 ms | 24 h, single use, old sessions revoked |
| 9 | A device-code sign-in for a personal runner | **PASS** | 2,505 ms | code, claim, approve, poll, bearer session |
| 10 | A member of one organization can't read the other's rows | **PASS** | 151 ms | 33 probes, each refused, empty or limited to the caller's own organization |
| 11 | A contract test (sign up, session, role) is green | **PASS** | 4,830 ms | 14 of 14 Vitest tests |

Source for every row, result and time: RUN, "Pass bar" and "Contract test". `RUN` prints `pass bar: 11 PASS, 0 FAIL, 0 SKIPPED (of 11)`.

**1. Strict typecheck: PASS.**
- RUN: `tsc 7.0.2 --noEmit` clean with 8 strict flags, the generated Prisma client included. Also clean under the root's `tsc 6.0.3`.
- The 8 flags are the ones `AGENTS.md` lists. The check requires each one in the tsconfig (`SPIKE/tsconfig.json:9-16`; `SPIKE/src/checks/static-checks.ts:54-63,81`).
- The generated client is TypeScript for Node 24's type stripping (`importFileExtension = "ts"`, `SPIKE/prisma/schema.prisma:1-6`). It passes `exactOptionalPropertyTypes` with no edit.
- Beyond the bar, RUN also shows the repo root's ESLint 10.15.0 (strict-type-checked and stylistic-type-checked) with no message on `src`, `test` and the config files, and a scan of 37 source files that caught all 12 planted violations.

**2. Pinned exactly: PASS.**
- RUN: `better-auth` 1.7.25 is declared with no range, installed and locked. `@better-auth/core` and `@better-auth/prisma-adapter` are installed at 1.7.25 too.
- The contract test asserts the same: the declared version matches `^\d+\.\d+\.\d+$` and equals the installed one (`SPIKE/test/contract.test.ts:50-59`).
- 1.7.25 is the newest stable release today (`npm view better-auth dist-tags`).

**3. With Prisma 7 on Postgres: PASS.**
- RUN: Postgres 18.6 (embedded). One Prisma Migrate migration applied, 11 tables. better-auth read a username lookup and wrote a verification row (created, read back, consumed) through the Prisma 7.10.1 client and `@prisma/adapter-pg` 7.10.1 (`SPIKE/src/spike.ts:200-247`).
- The 11 tables are the 10 models of `SPIKE/prisma/schema.prisma` (the migration has 10 `CREATE TABLE` statements) plus Prisma's own migrations table. The harness counts every table in the `public` schema (`SPIKE/src/spike.ts:240-242`).
- Scope: this ran on an embedded Postgres only. The "own Postgres" row is SKIPPED (section 5).

**4. Sign up: PASS.**
- RUN: the account is created, signed in on sign-up, the session reads back and the password is a hash.
- An account with no username is refused (`USERNAME_REQUIRED`, `SPIKE/src/scenarios/accounts.ts:15-19`). An email-shaped username (`alice@home`) is refused with 400 (`accounts.ts:22-28`).
- The stored password is a salted hash longer than 40 characters, not the typed value (`accounts.ts:41-47`). The email stays unverified, and nothing blocks sign-in (`accounts.ts:38`).

**5. Sign in by username and by email: PASS.**
- RUN: both names reach one account in any case. A wrong password and an unknown name give the same answer. Sign-out ends one session only.
- One login field is enough, because a username can't contain `@` (`SPIKE/src/scenarios/accounts.ts:56-60`). The plugin's default allows only alphanumerics, underscores and dots ([DOCS/plugins/username](https://www.better-auth.com/docs/plugins/username)).
- An unknown email and an unknown username get exactly the wrong-password answer, so a login can't probe which accounts exist (`accounts.ts:74-90`).
- Sign-out ends the one session, and the other session stays valid (`accounts.ts:92-96`).

**6. An invite link with no mail server: PASS.**
- RUN: an admin creates an invitation for an address. The invitee signs up with the link's invitation ID and accepts. Both calls ran over real HTTP.
- The link is `<panel>/accept-invitation/<invitationId>` (`SPIKE/src/ostra/admin-actions.ts:20-21`). The sign-up page, which doesn't exist yet, is meant to send the ID in the `x-ostra-invitation` header (`SPIKE/src/auth/create-auth.ts:25`). The scenario sends that header itself (`organizations.ts:132-136`).
- All of these are refused at sign-up with `SIGN_UP_CLOSED`:
  - an address alone (`SPIKE/src/scenarios/organizations.ts:105-106`)
  - a made-up ID (`organizations.ts:107-108`)
  - another address's ID (`organizations.ts:109-111`)
  - an expired invitation (`organizations.ts:184-192`)
- The link works once (`organizations.ts:173-174`). Another signed-in member can't accept it (`organizations.ts:149-154`).
- No mail is sent, because `sendInvitationEmail` is not set (`create-auth.ts:176-177`).
- Scope: the panel page behind `/accept-invitation/<id>` doesn't exist. The scenario makes the HTTP calls such a page would make (`organizations.ts:195`).

**7. Two organizations with one member in both: PASS.**
- RUN: `dave` has one account and two memberships, member of acme and admin of globex. His role and his permissions follow the active organization.
- The database refuses a second membership of the same (organization, user) pair (`SPIKE/src/scenarios/organizations.ts:255-261`; `SPIKE/prisma/schema.prisma:118-120`).
- Switching the active organization changes the role and the permission (`organizations.ts:227-247`).

**8. An admin's reset link: PASS.**
- RUN: the instance admin creates a 24 h link. The member follows it and sets a password. Old sessions are revoked. The link is single use. Organization admins and members can't create one.
- The expiry is checked in the stored token's row, between 23 and 24 hours (`SPIKE/src/scenarios/reset-link.ts:35-41`).
- A second use of the link reports an error and gives no token (`reset-link.ts:62-67`).
- A visitor who asks for a reset gets one bare `{status, message}`, the same for a known and an unknown address, and no link (`reset-link.ts:72-86`).
- Scope: only the instance admin may create a link (`reset-link.ts:20-25`). `PASSBAR`, ADR 0003 and F-002 say "an admin" without saying which.

**9. A device-code sign-in for a personal runner: PASS.**
- RUN: over real HTTP, as a runner would: code, claim, approve, poll, then a bearer session of the approving member. Pending, `slow_down`, deny, expiry, reuse and a foreign client are all refused.
- The error names match RFC 8628 section 3.5 (`authorization_pending`, `slow_down`, `access_denied`, `expired_token`; [RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628)). They appear in `SPIKE/src/scenarios/device-code.ts:97-99,216,230`. An unknown or reused code gets `invalid_grant` (`device-code.ts:201,224`), and a client other than `ostra-runner` gets `invalid_client` (`device-code.ts:221`).
- The member's session list shows the runner by its `User-Agent`, and revoking that session cuts the runner off (`device-code.ts:189-199`).
- Scope: the harness plays the runner with `fetch` on a loopback port. The panel's `/device` page and the runner's CLI don't exist.

**10. A member of one organization can't read the other's rows: PASS.**
- RUN: 33 probes, each refused, empty or limited to the caller's own organization (a scoped read that returns only the caller's rows is counted). They cover the guard, scoped reads, guessed IDs, the composite foreign key, better-auth's endpoints, and removal.
- The direction is mostly acme to globex. The guessed-ID probes (`isolation.ts:84-93`), the composite-foreign-key probe (`isolation.ts:97-104`) and the ten endpoint probes run as acme members against globex. The other direction (`carol`, globex only, against acme) has the guard (`isolation.ts:63-64`), her scoped reads (`isolation.ts:70-71,80`) and three endpoint probes (`isolation.ts:141-143`).
- "ostra's rows" are two stand-in models the spike defines, `Project` and `Task` (`SPIKE/prisma/schema.prisma:166-193`). They are not ostra's real data model.
- The guard is `requireMember`. It reads the session and then the `member` row on every request, and answers "not a member" the same way for an organization that doesn't exist (`SPIKE/src/ostra/organization-scope.ts:60-66`).
- A removed member's next request is refused while the session is still valid (`SPIKE/src/scenarios/isolation.ts:162-175`).
- Ten better-auth endpoints were asked about the other organization as a non-member. Each was refused, and nothing changed behind the refusals (`isolation.ts:106-150`).
- The 33 is a counter the scenario increments by hand (`isolation.ts:28,65,81,93,104,132,138,144,160,175`). It isn't a count of assertions.
- Scope: see "Isolation is held by code" in section 3.

**11. A contract test (sign up, session, role) is green: PASS.**
- RUN: 14 of 14 tests. They sit in `SPIKE/test/contract.test.ts` at lines 51, 63, 82, 90, 102, 111, 120, 131, 138, 150, 165, 187, 208 and 218.
- They pin more than the bar names:
  - the session cookie's name, `HttpOnly` and `SameSite=Lax` (`contract.test.ts:71-76`)
  - the session's expiry, about 7 days (`contract.test.ts:120-129`)
  - the role on the user (the instance) and the role on the membership (an organization) (`contract.test.ts:150-185`)
  - a schema check that every table and column better-auth expects for ostra's plugins exists in the live database (`contract.test.ts:217-238`)

**Beyond the pass bar (RUN):**

| Row | Result | Note |
|---|---|---|
| ADR 0026, Q35, Q102: two organization roles, a separate instance admin, organization creation gated | **PASS** (43 ms) | `SPIKE/src/scenarios/organizations.ts:270-328` |
| Q102: the first account is the instance admin, even when several arrive at once | **PASS** (1,058 ms) | 6 simultaneous sign-ups, exactly 1 admin. The first run noted 5 accounts, and the four re-runs each gave 6 (Surprise 2) |
| The same run on a Postgres of your own | **SKIPPED** | needs `DATABASE_URL` (section 5) |
| `AGENTS.md` type rules, by ESLint | **PASS** (3,491 ms) | ESLint 10.15.0, the repo root's, no message |
| `AGENTS.md` type rules that `tsc` can't see (a scan) | **PASS** (10 ms) | 37 files, 12 planted violations caught |
| No postgres process or cluster data left behind | **PASS** (306 ms) | checked by the harness; I looked too (end of section 3) |

**Mutation check (README, not rerun).** `pnpm mutation-check` removes 17 protections one at a time, on copies, and the row that depends on each turned FAIL every time: 17 of 17 caught, and all 11 pass-bar rows have a mutation (`SPIKE/README.md:48`). I didn't run it. I did count its entries: `SPIKE/src/mutation-check.ts` lists 17 (lines 36-160), which matches the README's count. That each one turns a row to FAIL is the README's claim, and I didn't test it.

---

## 3. What surprised us, and the gotchas

**Surprises**

1. **The library has no invite-only mode.**
   - `emailAndPassword.disableSignUp` is all or nothing ([DOCS/reference/options](https://www.better-auth.com/docs/reference/options): "Disable email and password sign up"). It would turn invitees away too. The organization plugin only sends mail through `sendInvitationEmail`, and it needs a session whose email matches the invitation to accept ([DOCS/plugins/organization](https://www.better-auth.com/docs/plugins/organization)).
   - So ostra wrote a `before` hook on `/sign-up/email`. It lets through the first account, an invitee, or anyone when open sign-up is on (`SPIKE/src/auth/create-auth.ts:121-161`).
   - **The invitee is recognized by the invitation ID, not by the address.** The first version of the spike matched the address alone. With no mail server, nothing proves the mailbox, so a stranger who knew an invited address could have signed up as it (`SPIKE/README.md:123`). The test is `SPIKE/src/scenarios/organizations.ts:102-111`.

2. **The first-account window admits several accounts at once.**
   - RUN: 6 simultaneous sign-ups on an empty install created several accounts and exactly 1 admin. My notes from the first run say 5 accounts. I didn't keep that output, and none of the four re-runs reproduced it: each created all 6 accounts and 1 admin. The README records that all six got through (`SPIKE/README.md:123`).
   - The gate counts accounts and lets everyone through while the count is zero (`create-auth.ts:136-139`), with no lock. So every request that reaches the gate before the first account commits gets in, and how many that is depends on timing (inferred from the code). The scenario asserts that at least one sign-up succeeds, that exactly one account is admin, and that the user count equals the number of successes (`SPIKE/src/scenarios/first-account.ts:22-27`). It doesn't record why a sign-up was refused, so the first run's 5 can't be explained from its output.
   - The single admin is the part that holds. The promotion runs in `user.create.after` under a Postgres advisory lock (`SPIKE/src/db/bootstrap.ts:14-18`).
   - The sign-up response still says `role: "user"`, because the promotion runs after the user is created. The session says `admin`, so the panel has to read the session after sign-up (`first-account.ts:33-35`).

3. **`owner` still works at runtime, though ostra registers only two roles.**
   - better-auth keeps its built-in role names valid whatever you register. The installed library builds its set of valid roles from its defaults plus the registered ones (`PKG/plugins/organization/routes/crud-invites.mjs:105-108`), so an invitation for `owner` passes its check, and the member would end up with a role ostra never defined (`SPIKE/src/auth/roles.ts:41-49`). I read this in the source and didn't run an `owner` invitation against the library alone. The docs describe three default roles, and `creatorRole` defaults to `owner` ([DOCS/plugins/organization](https://www.better-auth.com/docs/plugins/organization)).
   - The `organizationHooks` refuse any role that isn't exactly `admin` or `member` (`create-auth.ts:53-60,190-203`). RUN confirms the refusal: an invitation for `owner` fails with status 400 and code `ROLE_NOT_FOUND` (`organizations.ts:77-87`). That code string is also the library's own name for an unknown role (`PKG/plugins/organization/error-codes.mjs:15`), so the assertion alone doesn't show who refused. The source reading above says it was the hook, and the mutation check, which removes the hook, is the run that would show it (README, not rerun: `SPIKE/README.md:48`; `SPIKE/src/mutation-check.ts:94`).
   - better-auth also takes a list of roles for one member (its invitation schema accepts a string or an array, `PKG/plugins/organization/routes/crud-invites.mjs:18`) and stores it as `admin,member` (`SPIKE/README.md:135`, not rerun). ostra's scope takes the highest (`SPIKE/src/ostra/organization-scope.ts:33-40`).
   - The types are right: registering `admin` and `member` makes an `owner` invitation a compile error, and the scenario carries a `@ts-expect-error` with its reason for that line (`organizations.ts:81`).

4. **The admin plugin has no "create a reset link".**
   - [DOCS/plugins/admin](https://www.better-auth.com/docs/plugins/admin) lists 15 endpoints, among them `POST /admin/set-user-password`, which sets a password directly, and none that creates a reset link.
   - The spike calls `requestPasswordReset` for the target and catches the URL that better-auth hands to `sendResetPassword`. The callback writes it into a per-request sink held in `AsyncLocalStorage`, so the admin who asked gets it back (`SPIKE/src/auth/link-sink.ts:19-29`; `create-auth.ts:88-94`; `SPIKE/src/ostra/admin-actions.ts:52-87`).
   - A request with no sink, a visitor's own, produces no link anywhere. That is Q54's rule for an install without mail.
   - better-auth does not revoke other sessions on a reset by default: "By default, other active sessions are not revoked when a user resets their password" ([DOCS/authentication/email-password](https://www.better-auth.com/docs/authentication/email-password); the installed code deletes them only when the option is set, `PKG/utils/password.mjs:34`). The spike turns it on (`create-auth.ts:87`), and RUN shows old sessions revoked (`reset-link.ts:57`).

5. **The device flow's token is a full session, and `scope` isn't enforced.**
   - In the standalone flow the `access_token` is "a Better Auth session token, not an RFC 8628 OAuth access token", and using it as a bearer token needs the `bearer` plugin ([DOCS/plugins/device-authorization](https://www.better-auth.com/docs/plugins/device-authorization); [DOCS/plugins/bearer](https://www.better-auth.com/docs/plugins/bearer)).
   - The docs describe scope validation only for the separate OAuth Provider integration. They don't say the standalone flow enforces it. The `deviceCode` table stores `scope` (`SPIKE/prisma/schema.prisma:153`).
   - The installed code agrees. It stores the requested scope, echoes it back in the token response, and mints the token with `createSession(user.id)`, which takes no scope (`PKG/plugins/device-authorization/routes.mjs:244,458,474-477`). So the scope narrows nothing (read from the source, not run).
   - RUN shows the consequence: the runner's token lists both of the member's organizations (`SPIKE/src/scenarios/device-code.ts:179-186`). It is the member's own session, so it can do what the member can (inferred; the scenario shows only that it lists both organizations). The session lasts about 7 days (README, not rerun: `SPIKE/README.md:133`; the contract test checks a browser session's 7 days, `contract.test.ts:120-129`).
   - better-auth 1.7 added a claim step (README, not rerun: `SPIKE/README.md:131`). The member opens `GET /device?user_code=` while signed in, which claims the code. Only that member can then approve or deny it (`device-code.ts:112-148`; [DOCS/plugins/device-authorization](https://www.better-auth.com/docs/plugins/device-authorization): the `GET /device` call "claims the pending code for the calling session"). Another signed-in member who holds the user code gets 403 (`device-code.ts:143-148`).

6. **Isolation is held by code, not by the database.**
   - Every ostra query takes a `MemberScope` and puts its organization in the `where`. Only `requireMember` makes one (`SPIKE/src/ostra/organization-scope.ts:20`; `SPIKE/src/ostra/work-store.ts:52,61,73`).
   - The database backs only writes of one kind: a task whose project belongs to another organization is refused by the composite key `(projectId, organizationId)` (`SPIKE/prisma/schema.prisma:175,186`; `isolation.ts:95-104`).
   - A raw `prisma.task.findMany()` is still allowed to read across organizations (inferred from the code). The only things that stop it are review, the scoped store and the test.
   - Row-level security as a second wall was not tried (`SPIKE/README.md:179`; nothing in `SPIKE/prisma/` or `SPIKE/src/db/` sets up a policy).

**Gotchas**

7. **Prisma's `latest` on npm is now the 8 release candidate.**
   - `npm view prisma dist-tags` today shows `latest` as 8.0.0-rc.34, with 7.10.1 under `prev`. better-auth's Prisma page says its adapter doesn't support Prisma 8 yet and tells you to install Prisma 7 explicitly ([DOCS/adapters/prisma](https://www.better-auth.com/docs/adapters/prisma)).
   - An unpinned `pnpm add prisma` would break the stack. The exact pins in `SPIKE/package.json:19-20,29` are the guard.

8. **Prisma 7 moved the connection URL out of the schema.**
   - It lives in `prisma.config.ts`, under `datasource.url` ([Prisma config reference](https://www.prisma.io/docs/orm/reference/prisma-config-reference)). A driver adapter is required for Postgres in Prisma 7, and optional in 6 and earlier ([DOCS/adapters/prisma](https://www.better-auth.com/docs/adapters/prisma)).
   - `prisma migrate diff` prints an empty script and exits 0 when the config has no datasource, so the spike's config always sets one, a placeholder that fails the moment a command really connects (`SPIKE/prisma.config.ts:3-16`; README, not rerun: `SPIKE/README.md:116`).
   - Prisma's page also mentions a `prisma7.config.ts`, in its note on loading `.env` ("`prisma.config.ts`, or `prisma7.config.ts` in projects created with Prisma ORM 7.10 or later"), and says nothing else about it. The spike's `prisma.config.ts` works on 7.10.1 (RUN, Prisma row).
   - `$queryRaw` on a function that returns `void` fails under the driver adapter ("Failed to deserialize column of type void"). `$executeRaw` works (`SPIKE/src/db/bootstrap.ts:16-18`).

9. **The generated schema needed two edits, and nothing checks a Prisma schema against better-auth at start-up.**
   - `npx auth@latest generate` writes the schema file (for Prisma, "saved in `prisma/schema.prisma`"), and the docs leave applying it to the ORM's own migration tool ([DOCS/concepts/cli](https://www.better-auth.com/docs/concepts/cli); the page doesn't say "applies nothing" in those words). The spike generated its schema with `auth@1.7.25` (README, not rerun: `SPIKE/README.md:104`).
   - The edits are marked `ostra:` in the file. One is a unique `(organizationId, userId)` on `Member`, because the generated schema lets a user be a member of one organization twice (`SPIKE/prisma/schema.prisma:118-120`). The other is `Project` and `Task` with the composite key (`schema.prisma:166-193`), plus the two relation fields on `Organization` that point at them (`schema.prisma:101-103`).
   - The contract test's schema check (`contract.test.ts:217-238`) is what catches a better-auth upgrade that adds a column. Its own comment says better-auth can't check a Prisma database at start-up (`contract.test.ts:219-220`). ADR 0003 asks only for the exact pin ("better-auth ships breaking changes in minor versions, so its version is pinned exactly") and names no test, so this check is the spike's addition to that guard.

10. **The plugin list in ADR 0003 is short by one.**
    - The spike needs `bearer` besides the four plugins ADR 0003 names (`SPIKE/src/auth/create-auth.ts:163-216`). The docs say the device token needs it for API calls (Surprise 5).
    - The earlier research had already listed `deviceAuthorization` and `bearer` together (`context/research/platform-auth-github.md:215`).

11. **"Open sign-up" is two switches, not one.**
    - The spike has `openOrganizationSignup`, which gates `allowUserToCreateOrganization`, and `openAccountSignup`, which opens the sign-up gate. Both default to off (`create-auth.ts:27-37,185-188`).
    - ADR 0026 names "open sign-up for new organizations" as one setting. A hosted install needs both on (inferred).
    - Only `openOrganizationSignup` is exercised in the scenarios (`organizations.ts:283-302`). `openAccountSignup` is used by the contract test's setup (`contract.test.ts:42`).

12. **The sign-up gate is path-based, so the extra sign-in methods of F-004 won't pass through it.**
    - The hook acts only when `ctx.path === "/sign-up/email"` (`create-auth.ts:130`). A GitHub or SSO sign-up, which F-004 adds later, creates accounts by other paths (inferred from the code and from ADR 0003). Each new method needs its own invite check.

13. **The spike makes the instance admin but not "the admin of the first organization".**
    - Q102 and ADR 0026 say the first account is both. In the spike, `alice` is promoted to instance admin and then creates acme herself, and the creator becomes its admin (`SPIKE/src/scenarios/organizations.ts:25,75`). Nothing creates the first organization at install.

14. **`requireEmailVerificationOnInvitation` is off, because it must be.**
    - The spike sets it to `false` (`create-auth.ts:184`). When it is unset, the library asks for a verified email only if invitation IDs aren't its built-in opaque ones (`PKG/plugins/organization/routes/crud-invites.mjs:29-36`). The docs recommend turning it on "when invitation IDs can be visible outside the invited user's mailbox" ([DOCS/plugins/organization](https://www.better-auth.com/docs/plugins/organization)).
    - An invite link pasted into a team chat is exactly that. With no mail server there is no mailbox to verify, so the link's ID stays the whole proof (README, not rerun: `SPIKE/README.md:152`).

15. **The device flow's rate limiting is untested, and better-auth's limiter is off outside production.**
    - RFC 8628 section 5.1 recommends rate-limiting user-code attempts ([RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628)). The user code here is 8 characters (`create-auth.ts:213`).
    - better-auth's limiter is on in production and off in development, and it stores counts in memory by default ([DOCS/concepts/rate-limit](https://www.better-auth.com/docs/concepts/rate-limit)). The spike runs outside production (README, not rerun: `SPIKE/README.md:180`).

16. **The harness shortens one timer, and `createAuth` shortens another.**
    - The harness sets the device poll interval to 1 s, where `createAuth` defaults to 5 s, which is also the plugin's default and RFC 8628's ("If no value is provided, clients MUST use 5 as the default", section 3.2) (`SPIKE/src/spike.ts:212`; `create-auth.ts:212`; `PKG/plugins/device-authorization/index.mjs:21`).
    - `createAuth` itself sets the code lifetime to 10 minutes, where the plugin's default is 30 minutes (`create-auth.ts:211`; `PKG/plugins/device-authorization/index.mjs:20`; [DOCS/plugins/device-authorization](https://www.better-auth.com/docs/plugins/device-authorization)). That is a setting of the spike's auth config, not of the harness, so the contract test runs with it too.

17. **The Prisma adapter's `transaction: true` isn't on the docs page, only in the package's types.**
    - The spike sets it so an organization and its first member are one write (`create-auth.ts:72-76`). The Prisma adapter page doesn't mention the option ([DOCS/adapters/prisma](https://www.better-auth.com/docs/adapters/prisma)). The installed adapter's type declarations do: "Whether to execute multiple operations in a transaction", default `false` (`SPIKE/node_modules/.pnpm/@better-auth+prisma-adapter_*/node_modules/@better-auth/prisma-adapter/dist/index.d.mts:20-27`).
    - That says what the option is for. No scenario or test mentions a transaction or a rollback (checked with a search of `SPIKE/src/scenarios/` and `SPIKE/test/`), so the spike doesn't show that an organization and its first member are written as one unit. It type-checks and the run passes.

18. **better-auth's hook types hold `Record<string, any>`.**
    - The spike narrows them with `Reflect.get` into `unknown` (`create-auth.ts:104,140,186`), so the spike's own code has no `any`, no `as` other than `as const`, and no `!`. RUN's ESLint and scan rows confirm it.

19. **pnpm 11 blocks install scripts until allowed.**
    - `prisma`, `@prisma/engines` and `@embedded-postgres/windows-x64` are listed under `allowBuilds` (`SPIKE/pnpm-workspace.yaml:5-8`). That pnpm 11 blocks scripts until they're listed is the README's observation (README, not rerun: `SPIKE/README.md:119`). The installed pnpm is 11.28.2.

**Housekeeping, checked after the runs.** The harness's own leftovers row passed in the first run and in all four re-runs ("no postgres of this spike running, no cluster directory and no password file left in `.data`", RUN). After the re-runs I also listed the processes whose name or command line contains "postgres", and found none. I started nothing that was still running when I finished.

---

## 4. What this changes in the plan

These are recommendations for the maintainer. I changed no other file.

1. **Q54: close its fallback.**
   - Q54 already sits in the settled table of `context/open-questions.md` (line 125: "F-002, F-115 ... ADR 0003, amended. Spike 9 confirms the username plugin"), so it needs no move.
   - The username plugin fits, so the fallback in ADR 0003's consequences ("If it doesn't fit, members sign in with their email only") doesn't apply. Amend ADR 0003 to say the spike confirmed the plugin and drop the fallback.
   - F-002 stays `planned` until it's built. Its design is confirmed, not its code.

2. **Amend ADR 0003.**
   - Add `bearer` to the plugin list, with the reason (Surprise 5, Gotcha 10).
   - State that invite-only sign-up is ostra's own hook, because the library has none (Surprise 1).
   - Pin Prisma exactly beside better-auth, and say why: npm's `latest` for `prisma` is the 8 RC (Gotcha 7).
   - Say that the schema comes from better-auth's generator with ostra's edits, and that the contract test is the upgrade gate (Gotcha 9).

3. **Amend ADR 0026.**
   - Record that better-auth still accepts `owner` and that ostra's hooks refuse it (Surprise 3).
   - Say that open sign-up is two settings, accounts and organizations, both off by default. The configuration reference needs both lines (the self-hosting rule in `AGENTS.md`, Gotcha 11).
   - F-001 must also make the first account the admin of the first organization. The spike doesn't (Gotcha 13).
   - Make the composite foreign key `(id, organizationId)` the schema rule for every project-level record, and note that nothing in the database stops a raw read (Surprise 6). F-049 already demands a per-record test, and `SPIKE/src/scenarios/isolation.ts` is a template for it. Consider row-level security as a later second wall.

4. **Decide the personal runner's credential (ADR 0029, ADR 0034, F-013).**
   - The plan already says the CLI uses the device session "once, to register" (`context/research/runner-transport.md:624`). ADR 0034 line 51 says only that a personal runner signs in with a device code the member approves. The spike shows why "once" matters: the session is a full member session for about a week (Surprise 5).
   - Recommend F-013's "done when" say that the runner trades the device session for its own key at once, and that the session is revoked afterward. The spike shows the revoke call works (`device-code.ts:189-199`).
   - F-103 (`ostra login`) reuses the same flow (`context/features.md:140`). A CLI that acts as the member may want a full session. Decide that on its own.

5. **Tighten F-002.**
   - Say who may create a reset link. The spike allows only the instance admin, because an account belongs to every organization its owner joined, so an organization admin could take over accounts in organizations they don't administer (`SPIKE/src/ostra/admin-actions.ts:56-58`). F-002 says "an admin".
   - Say that an invitation is bound to an address and that the link's ID is the secret. The working values in the spike are 7 days for an invite and 24 hours for a reset link (`create-auth.ts:50-51,86,182`).

6. **ADR 0007's dependency table.**
   - It lists Prisma 7 (`context/decisions/0007-web-app-libraries.md:11`) and `better-auth`, "pinned to an exact version" (`0007-web-app-libraries.md:19`), but gives no version numbers and doesn't list `@prisma/adapter-pg`. ADR 0037 already names `@prisma/adapter-pg` (`context/decisions/0037-background-work-on-pg-boss.md:21`), so the spike README's claim that no ADR names it is wrong (`SPIKE/README.md:151`). Add `@prisma/adapter-pg` to ADR 0007's table, and record the exact pins the spike ran with: better-auth 1.7.25, Prisma 7.10.1.
   - `embedded-postgres` let a test run with no Docker (`SPIKE/README.md:166`). It's the maintainer's call whether it becomes a dev dependency in milestone 1 (`AGENTS.md`: ask before adding a dependency).

7. **Add four open questions**, from the spike's own list (`SPIKE/README.md:147-152`):
   - the personal runner's credential (item 4)
   - who may create a reset link (item 5)
   - a fresh install belongs to whoever reaches it first (Q102 makes the first account the admin, and the spike found the first-account window admits several accounts: Surprise 2)
   - an invite link is a bearer secret, and a mailbox is never verified (Gotcha 14)

8. **No change.**
   - ADR 0017 holds. better-auth's tables and ostra's share one database and one migration (RUN, Prisma row: 11 tables).
   - Neither fallback in `PASSBAR` is needed: sign-in by email only, or ostra's own invitations.

---

## 5. What's still open

**SKIPPED in today's run (1 row, beyond the pass bar).**
- **The same run on a Postgres of your own.** RUN: "needs DATABASE_URL set to a server the spike may create a database on". It needs a `DATABASE_URL` that points at a server where the role may `CREATE DATABASE`. The spike makes `ostra_spike_<random>` there and drops it (`SPIKE/README.md:69-70`; `SPIKE/src/spike.ts:272-273`). Every row above ran on the embedded Postgres 18.6 only.

**Not covered, though no pass-bar row names it** (README "What's left", not rerun: `SPIKE/README.md:174-184`):
- **Linux and macOS.** Only Windows 11 was available. The harness's process handling has Linux and macOS branches that have not run.
- **The Postgres versions ostra will support.** Only 18.6 ran.
- **The panel's side of an invite.** The `/accept-invitation/<id>` page and the sign-up form that sends the ID.
- **The panel's side of the device flow.** The `/device` page, and the runner CLI that polls.
- **Row-level security** as a second wall behind the scoped store. It needs a non-superuser role and a `set_config` per transaction.
- **Rate limits** on sign-in and on the device endpoints, and where their counts live across several replicas (Gotcha 15).
- **The browser side.** No Next.js, no cookies over HTTPS, no cross-origin panel and no tRPC context. Everything ran against `auth.api` or `auth.handler` on a loopback port.
- **Project roles and restricted projects (F-087).** Only the organization level is covered.
- **The upgrade path.** Moving from 1.7.25 to 1.8: the contract test is the gate, and it hasn't been tried on a newer version. `beta` is already 1.8.0-beta.10 (`npm view better-auth dist-tags`).
- **The mutation check and the fresh-copy install.** Both are README claims that I didn't rerun (`SPIKE/README.md:48,50`).

**Decisions the spike can't make** (items 4, 5 and 7 of section 4): the runner's credential, the reset-link authority, a setup token for a fresh install (the README suggests one printed in the server log, `SPIKE/README.md:149`), and what to do about an invite link as a bearer secret.
