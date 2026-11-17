# Research: better-auth with a Rust core, and GitHub integration

**Status:** Research, 2026-11-17. Feeds Q-04 (better-auth next to Rust), Q-10 (who authors the PR), Q-14 (isolation), Q-15 (database).
**Method:** Official docs and source code wherever possible. Claims I could not confirm against a primary source are marked **unverified**.

**Versions checked (2026-11-17)**

| Thing | Version / date | Source |
|---|---|---|
| `better-auth` (npm `latest`) | **1.7.25**, published 2026-11-14. `1.8.0-beta.10` on `beta` (2026-11-15). 1.7.0 shipped 2026-08-18 | npm registry `https://registry.npmjs.org/better-auth` |
| `better-call` (better-auth's router/cookie lib) | 1.4.5 | npm registry |
| `better-auth-rs` (unofficial Rust port) | `1.0.0-alpha.5` (crates.io, 2026-10-21), ~300 stars | https://github.com/better-auth-rs/better-auth-rs |
| `octocrab` | 0.54.9 (2026-10-31), ~1.46k stars, ~20M downloads | https://crates.io/crates/octocrab |
| `git2` (libgit2 bindings) | 0.21.0 (2026-10-06) | https://crates.io/crates/git2 |
| `gix` (gitoxide) | 0.90.0 (2026-10-22) | https://crates.io/crates/gix |
| `jsonwebtoken` | 12.0.0 (2026-11-13) | https://crates.io/crates/jsonwebtoken |
| GitHub installation token format | Stateless `ghs_APPID_JWT` (~520 chars). Fully rolled out 2026-10-02 | https://github.blog/changelog/2026-10-02-stateless-github-app-installation-tokens-rolled-out/ |

---

## Summary

**better-auth**
- better-auth is a **TypeScript-only, ESM-only** library. It runs on any runtime with Web `Request`/`Response`: Node, Bun, Deno, Workers. It **does not need a full-stack framework**. A ~20-line Hono server is a documented setup. ([installation](https://www.better-auth.com/docs/installation), [Hono](https://www.better-auth.com/docs/integrations/hono))
- It owns its own tables (`user`, `session`, `account`, `verification`, plus plugin tables). Its CLI (`npx auth migrate`) or `getMigrations()` creates them. On Postgres it can live in its **own schema** (`database.schemaName: "auth"`), which suits a Rust core with its own migrations in another schema. ([database](https://www.better-auth.com/docs/concepts/database), [postgres adapter](https://www.better-auth.com/docs/adapters/postgresql))
- Every plugin ostra needs exists and is first-party: organization (orgs, teams, invitations, custom roles, dynamic access control), admin, JWT + JWKS, bearer, API keys (`@better-auth/api-key`), device authorization (RFC 8628), SSO with OIDC + SAML (`@better-auth/sso`), SCIM, a full OAuth 2.1/OIDC provider, and GitHub social login.
- **There is no official non-JS SDK.** The creator's guidance is to "use REST API with the JWT plugin" ([issue #301](https://github.com/better-auth/better-auth/issues/301)). A Rust backend has three ways to check a browser request: verify a better-auth JWT against JWKS, look up the session table using the cookie token, or call `/api/auth/get-session`. Each is analysed below.
- **Recommendation (Option A):** ship **one image** where the **Rust server is the only public listener**. It serves the SPA and the Rust API, and reverse-proxies `/api/auth/*` to a small **better-auth sidecar** (Hono on Node or Bun) running as a child process on localhost. Rust checks sessions by calling `get-session` on the sidecar, cached for 30–60 s, with `customSession` adding the org role. Runners use a **Rust-native** credential, bootstrapped through better-auth's device authorization flow. `docker compose` stays at two services: `ostra` and `postgres`.

**GitHub**
- Use a **GitHub App**, created **per deployment** through the **manifest flow** from ostra's setup wizard. This is the same pattern Atlantis, Probot and the Backstage CLI use. Use the same App for "Sign in with GitHub" (better-auth) and for user-to-server tokens.
- Minimum repo permissions: Metadata (read), Contents (write), Pull requests (write), Issues (read), Checks (read, or write if ostra posts its own check), Commit statuses (read). Optional: Workflows (write), Actions (read). Account permission: Email addresses (read), needed for login.
- **Runners never hold GitHub secrets.** For each git operation, the server mints a **1-hour installation token** scoped to **one repo** with **`contents: write` only**, and hands it over through a git credential helper. All other GitHub API calls (PRs, comments, checks) stay on the server.
- **PR authorship is a policy choice (Q-10).** Key fact: GitHub stops a PR **author** from approving their own PR, but nothing stops the human who *asked* a bot from approving the bot's PR. GitHub closes that gap for its own Copilot agent, and third-party apps can't use that mechanism. The options are a user-opened PR (user-to-server token, server-side only) with bot-pushed commits, or a bot PR plus an ostra-owned required check.
- Commits from a plain `git push` are **not signed**. GitHub signs commits that a GitHub App creates **through the API** without custom author or committer fields. This matters for repos that require signed commits.
- Rust: `octocrab` covers GitHub App auth, scoped installation tokens, webhook types and signature verification. For git, **shell out to the `git` CLI** for clone, worktree, fetch and push. `gix` still has no push (2026-11). `git2`/libgit2 works but lags git (no hooks, for example).

---

# Part 1: better-auth with a Rust core

## 1.1 What better-auth is

- "A framework-agnostic, universal authentication and authorization framework for TypeScript", with a plugin ecosystem ([introduction](https://www.better-auth.com/docs/introduction)). It is MIT-licensed (npm `license` field), and its maintainers also run a paid hosted "Better Auth Infrastructure" dashboard, which ostra doesn't need.
- **Current version:** 1.7.25 (2026-11-14). Release cadence is fast: 1.4 (2025-11), 1.5 (2026-03), 1.6 (2026-04), 1.7 (2026-08), 1.8 in beta. **Minor versions carry breaking changes.** The [1.7 upgrade guide](https://www.better-auth.com/docs/guides/1-7-upgrade-guide) lists dozens, mostly in OAuth, SSO and the OAuth provider. → Pin an exact version and treat upgrades as deliberate work.
- **Runtime requirements:**
  - The package has **no `engines` field**, and "CommonJS (cjs) isn't supported" ([installation](https://www.better-auth.com/docs/installation)).
  - It works with "any backend framework with standard Request and Response objects". Documented integrations include Next.js, Nuxt, SvelteKit, TanStack Start, React Router, Solid Start, Astro, Hono, Express, Fastify, Elysia, NestJS, Nitro, Expo, Electron and Cloudflare Workers.
  - SQLite adapter docs cover `better-sqlite3`, Node's `node:sqlite` (Node ≥ 22.5) and `bun:sqlite` ([sqlite](https://www.better-auth.com/docs/adapters/sqlite)). So Node and Bun are both first-class. Deno is presumably supported through Web standards (**unverified**: no Deno-specific page found).
- **Standalone server: yes.** The documented Hono setup is `app.on(["POST","GET"], "/api/auth/*", (c) => auth.handler(c.req.raw))` plus `@hono/node-server` ([installation](https://www.better-auth.com/docs/installation)). No full-stack framework is needed. The browser client (`better-auth/client`, with React, Vue, Svelte and Solid bindings) works from any SPA.
- **Config:** `BETTER_AUTH_SECRET` must be ≥ 32 chars and high-entropy. `BETTER_AUTH_SECRETS` holds versioned secrets for rotation. `BETTER_AUTH_URL` is the base URL ([installation](https://www.better-auth.com/docs/installation), [options → secrets](https://www.better-auth.com/docs/reference/options)).
- **Telemetry** is opt-in, off by default (since 1.3.5) ([telemetry](https://www.better-auth.com/docs/reference/telemetry)). That's good for a self-hosted product.

## 1.2 Database adapters, tables, and who owns migrations

**Adapters** ([database](https://www.better-auth.com/docs/concepts/database), [installation](https://www.better-auth.com/docs/installation))
- **Built-in Kysely adapter:** pass a `pg` Pool, `mysql2` pool, `better-sqlite3`/`node:sqlite`/`bun:sqlite`, or a Kysely dialect. Supports Postgres, MySQL, SQLite (including D1) and MSSQL.
- **ORM adapters:** Drizzle (`drizzle-orm ^0.45.2 || >=1.0.0-rc.1`), Prisma (5/6/7) and MongoDB. These are separate packages (`@better-auth/drizzle-adapter`, etc.).
- **Stateless mode** (no DB) exists, but "most plugins will require a database".

**Core tables** ([database → core schema](https://www.better-auth.com/docs/concepts/database))

| Table | Columns |
|---|---|
| `user` | `id, name, email, emailVerified, image, createdAt, updatedAt` |
| `session` | `id, userId, token, expiresAt, ipAddress, userAgent, createdAt, updatedAt` |
| `account` | `id, userId, accountId, providerId, accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt, scope, idToken, password, createdAt, updatedAt` |
| `verification` | `id, identifier, value, expiresAt, createdAt, updatedAt` |

**Plugin tables and columns ostra would get**
- **organization:** `organization(id, name, slug, logo, metadata, createdAt)` and `member(id, userId, organizationId, role, createdAt)`. Also `invitation(id, email, inviterId, organizationId, role, status, createdAt, expiresAt[, teamId])`. `session` gains `activeOrganizationId, activeTeamId`. Optional tables: `team`, `teamMember`, `organizationRole` (dynamic roles). ([organization](https://www.better-auth.com/docs/plugins/organization))
- **admin:** `user` gains `role, banned, banReason, banExpires`, and `session` gains `impersonatedBy` ([admin](https://www.better-auth.com/docs/plugins/admin)).
- **jwt:** `jwks(id, publicKey, privateKey, alg, crv, createdAt)`. The private key is AES-256-GCM-encrypted by default ([jwt](https://www.better-auth.com/docs/plugins/jwt)).
- **device-authorization:** `deviceCode(id, deviceCode, userCode, userId, clientId, scope, status, expiresAt, lastPolledAt, …)` ([device authorization](https://www.better-auth.com/docs/plugins/device-authorization)).
- **api-key:** an `apikey` table, with the key stored **hashed** (see 1.3).

**Migrations: who owns what**
- `npx auth@latest migrate` adds missing tables and columns. It works **only with the built-in Kysely adapter**. `npx auth@latest generate` emits a Prisma/Drizzle schema, or a SQL file for Kysely. `getMigrations(auth.options).runMigrations()` does the same programmatically, also Kysely-only ([database](https://www.better-auth.com/docs/concepts/database), [CLI](https://www.better-auth.com/docs/concepts/cli)).
- On first use, better-auth checks the DB has the tables and columns it needs, and fails with a clear error otherwise (`advanced.database.validateSchema`). `npx auth check schema` runs the same check ahead of time.
- **Postgres non-default schema:** `database: { dialect, type: "postgres", schemaName: "auth" }`. "The schema applies to runtime queries and CLI migrations. `npx auth@latest migrate` creates it when needed" ([postgres](https://www.better-auth.com/docs/adapters/postgresql)).
- Renaming: `modelName` and `fields` map tables and columns, so you could make them snake_case. `advanced.database.generateId` can be `"uuid"`, `"serial"`, a function, or `false` to let the DB generate IDs. `additionalFields` extends `user` and `session` ([database](https://www.better-auth.com/docs/concepts/database)).
- **Secondary storage (Redis):** if configured, **sessions move to Redis instead of the DB** unless `storeSessionInDatabase: true` ([session management](https://www.better-auth.com/docs/concepts/session-management)). Any Rust design that reads the session table must forbid this, or force `storeSessionInDatabase`.

**Implications for a shared DB with Rust**
- Let better-auth own the `auth` schema, using the built-in Kysely + `pg` adapter so programmatic migrations work at sidecar start. Let Rust (sqlx/refinery) own an `ostra` schema. Rust treats `auth.*` as **read-only**.
- better-auth's default columns are **camelCase** (`"userId"`, `"expiresAt"`), so Rust SQL must quote them. You can remap to snake_case, but every plugin's columns then need mapping too. That adds upgrade risk, so leaving the defaults is probably cheaper.
- Foreign keys from `ostra.*` to `auth.user(id)` are possible. Startup order then matters: the sidecar migrates first, then Rust migrates. (Design choice, not researched further.)
- **SQLite (Q-15):** two processes writing one SQLite file needs WAL and a busy timeout, and still risks `SQLITE_BUSY` under load (general SQLite behaviour, not better-auth specific). → Postgres is the clean v1 target, with SQLite as an "evaluation" mode at most.

## 1.3 Relevant plugins

| Plugin | Package / import | What it gives ostra | Notes |
|---|---|---|---|
| **organization** | `better-auth/plugins` | Orgs, members, **invitations** (`inviteMember` → `sendInvitationEmail` → `acceptInvitation`; 48 h expiry default), roles `owner/admin/member`, custom permissions via `createAccessControl`, optional **teams**, optional **dynamic roles** stored per org, `hasPermission` server check, before/after hooks | `membershipLimit` defaults to 100. Invitation acceptance requires a logged-in user, so the invitee signs up first. `requireEmailVerificationOnInvitation` exists. ([docs](https://www.better-auth.com/docs/plugins/organization)) |
| **admin** | `better-auth/plugins` | Instance-level user management: create, list, ban/unban (ban **revokes all sessions**), set role, impersonate (1 h default), revoke sessions. `npx auth create-admin` bootstraps the first admin | Its `user.role` is separate from org `member.role`. Pick one source of truth for authorization ([docs](https://www.better-auth.com/docs/plugins/admin)) |
| **jwt** | `better-auth/plugins` | `/api/auth/token` → JWT. The `set-auth-jwt` header is set on `get-session`. **JWKS at `/api/auth/jwks`** (path configurable via `jwks.jwksPath`). Default alg **EdDSA/Ed25519**, also ES256, ES512, RSA256, PS256 and ECDH-ES. Default `exp` is **15 min**, `iss`/`aud` default to the base URL, `sub` is the user id, and the payload is the whole user unless `definePayload` is set. Key rotation via `jwks.rotationInterval` with a 30-day grace period. Remote or KMS signing is supported | The docs say it is "not meant as a replacement for the session". With `sessionCookieCache: true` and `cookieCache.strategy: "jwt"`, the `session_data` cookie is signed with the JWKS keys too ([docs](https://www.better-auth.com/docs/plugins/jwt)) |
| **bearer** | `better-auth/plugins` | Accepts `Authorization: Bearer <session token>` and converts it into the session cookie internally. The token comes back in a `set-auth-token` header. `requireSignature` (default `false`) | "Use cautiously… only for APIs that don't support cookies" ([docs](https://www.better-auth.com/docs/plugins/bearer), [source](https://github.com/better-auth/better-auth/blob/main/packages/better-auth/src/plugins/bearer/index.ts)) |
| **API keys** | `@better-auth/api-key` | User- **or org-owned** keys, `x-api-key` header (configurable), per-key rate limits, expiry, remaining/refill counts, metadata, permissions. `/api-key/verify` is server-only. `enableSessionForAPIKeys` mocks a user session from a key (user-owned keys only; the docs say this is "generally not recommended") | Keys are stored as **SHA-256 → base64url** (`defaultKeyHasher`), so a Rust lookup is feasible ([docs](https://www.better-auth.com/docs/plugins/api-key), [advanced](https://www.better-auth.com/docs/plugins/api-key/advanced), [reference](https://www.better-auth.com/docs/plugins/api-key/reference), [source](https://github.com/better-auth/better-auth/blob/main/packages/api-key/src/index.ts)) |
| **device authorization** | `better-auth/plugins` | RFC 8628. `POST /device/code` → user opens `/device`, enters the code and approves → device polls `POST /device/token`. Standalone, this returns a **better-auth session token** (use it with bearer). Combined with `oauthProvider()` + `oauthDeviceAuthorization()`, it returns an **audience-bound OAuth JWT access token** plus a refresh token | `validateClient` allow-lists client IDs. Codes expire after 30 min by default. The approval UI has documented security requirements (show client, require explicit approve) ([docs](https://www.better-auth.com/docs/plugins/device-authorization)) |
| **SSO** | `@better-auth/sso` | Per-org **OIDC and SAML 2.0** connections stored in `ssoProvider`, or `defaultSSO` defined in code. OIDC discovery, `private_key_jwt`, SP- and IdP-initiated SAML, Single Logout, org provisioning, DNS domain verification | "Self-service SSO" onboarding is a paid Better Auth Infrastructure feature. The plugin itself is OSS ([docs](https://www.better-auth.com/docs/plugins/sso)) |
| **SCIM** | `@better-auth/scim` | Inbound SCIM 2.0 user and group provisioning | Enterprise, later ([docs](https://www.better-auth.com/docs/plugins/scim)) |
| **generic-oauth** | `better-auth/plugins` | A fixed OIDC/OAuth provider set in config, such as a team's Keycloak, Authentik or Okta | Probably the common self-hosted "company SSO" case, simpler than the SSO plugin ([docs](https://www.better-auth.com/docs/plugins/generic-oauth)) |
| **GitHub social login** | core `socialProviders.github` | Sign in with GitHub. Works with an **OAuth App or a GitHub App**. A GitHub App needs the *Email addresses: read* account permission | Default scopes are `read:user user:email`. The provider implements **refresh** against `https://github.com/login/oauth/access_token`, which GitHub App user tokens need since they expire after 8 h ([docs](https://www.better-auth.com/docs/authentication/github), [source](https://github.com/better-auth/better-auth/blob/main/packages/core/src/social-providers/github.ts)) |
| **customSession** | `better-auth/plugins` | Extends the `get-session` response, for example with the member's org role | Useful for Rust option (c) ([session management](https://www.better-auth.com/docs/concepts/session-management)) |
| **OAuth 2.1 provider** | `@better-auth/oauth-provider` | Makes better-auth an OAuth 2.1/OIDC authorization server: auth code + PKCE, client credentials, refresh, device grant, JWT (RFC 9068) or opaque tokens, introspection (RFC 7662), DPoP, RFC 9728 resource metadata | Heavy. Relevant if ostra later exposes an API to third parties. The old `oidcProvider` plugin was removed in 1.7 ([docs](https://www.better-auth.com/docs/plugins/oauth-provider), [resource server](https://www.better-auth.com/docs/plugins/oauth-provider/resource-server)) |
| openAPI | `better-auth/plugins` | Generated OpenAPI reference at `/api/auth/reference` | Handy for typing Rust → sidecar calls ([docs](https://www.better-auth.com/docs/plugins/open-api)) |
| agent-auth | separate package | "Agent Auth Protocol" provider for AI agents | Explicitly unstable. Not relevant to runners ([docs](https://www.better-auth.com/docs/plugins/agent-auth)) |

Other relevant facts:
- **Getting a user's GitHub token server-side:** `auth.api.getAccessToken` refreshes an expired token before returning it. Since 1.7, callers must select the account explicitly by `accountId`. "A trusted server call can also provide `userId`" ([OAuth concepts](https://www.better-auth.com/docs/concepts/oauth)).
- `account.encryptOAuthTokens` (default `false`) encrypts provider tokens at rest ([options](https://www.better-auth.com/docs/reference/options)). If enabled, Rust **cannot** read `account.accessToken` directly. It has to go through the sidecar.

## 1.4 How a non-JS backend authenticates better-auth requests

**Official guidance.** None in the docs. The library's creator on [issue #301](https://github.com/better-auth/better-auth/issues/301) (2024-10): "Better Auth is a TypeScript-only library… you can use REST API with the JWT plugin. Currently, we don't provide—and don't plan to provide—clients for Python or other languages."

**How the session cookie works** (verified in source)
- Cookie name: `${cookiePrefix}.session_token`, default `better-auth.session_token`. It gets a `__Secure-` prefix when `useSecureCookies` is set, when `baseURL` is `https://`, or when `NODE_ENV=production`. Attributes are `HttpOnly`, `SameSite=Lax`, `Path=/` ([cookies source](https://github.com/better-auth/better-auth/blob/main/packages/better-auth/src/cookies/index.ts), [cookies docs](https://www.better-auth.com/docs/concepts/cookies)).
- Value: `encodeURIComponent(token + "." + base64(HMAC-SHA256(key = BETTER_AUTH_SECRET, msg = token)))`. The signature is standard base64, 44 chars with `=` padding. The verifier splits on the last `.` and rejects signatures that aren't 44 chars ending in `=` ([better-call crypto.ts](https://github.com/better-auth/better-call/blob/main/packages/better-call/src/crypto.ts), [context.ts `getSignedCookie`](https://github.com/better-auth/better-call/blob/main/packages/better-call/src/context.ts)).
- The DB holds the **raw** token (`generateId(32)`) in `session.token`. Lookups are by equality, with no hashing ([internal-adapter.ts](https://github.com/better-auth/better-auth/blob/main/packages/better-auth/src/db/internal-adapter.ts)).
- Expiry: 7 days by default, **sliding**. When `updateAge` (1 day) has passed, `get-session` pushes `expiresAt` forward ([session management](https://www.better-auth.com/docs/concepts/session-management)).
- Optional `session_data` cookie cache: strategies `compact` (base64url + HMAC), `jwt` (HS256, or JWKS keys with `jwt({ sessionCookieCache: true })`), or `jwe`. Default `maxAge` is 5 min. Revoked sessions can stay valid elsewhere until the cache expires ([session management](https://www.better-auth.com/docs/concepts/session-management)).

**The three options**

| | (a) Verify better-auth JWTs via JWKS | (b) Read `session` table with the cookie token | (c) Call `/api/auth/get-session` from Rust |
|---|---|---|---|
| How | The browser fetches `/api/auth/token`, or reads `set-auth-jwt`, and sends `Authorization: Bearer <jwt>` to Rust. Rust verifies against the cached JWKS (`kid` lookup, refetch on unknown `kid`) and checks `iss`, `aud`, `exp` | Rust parses the cookie, verifies the HMAC with the shared secret (optional but cheap), then runs `SELECT … FROM auth.session JOIN auth."user" … WHERE token = $1 AND "expiresAt" > now()`, plus `member` for the role | Rust forwards the request's `Cookie` (or bearer) header to the sidecar's `get-session` over localhost and caches the result by `sha256(token)` for 30–60 s |
| Revocation | Delayed until JWT `exp` (15 min default) | Immediate | Immediate, or within the cache TTL |
| Coupling to better-auth internals | Low: a documented, standard JWT/JWKS contract | **High**: table and column names, cookie format, secret handling, plugin semantics (ban, impersonation, secondary storage) | Low: a documented HTTP endpoint. `customSession` shapes the payload |
| Extra hops | None per request. The browser must refresh the JWT every ≤ 15 min | One indexed DB query | One localhost HTTP call, mostly absorbed by the cache |
| Browser streaming (SSE/WebSocket to Rust) | Awkward: the JWT has to go in a query param or WS subprotocol | Works: same-origin cookies are sent automatically | Works: same-origin cookies are sent automatically |
| Org/role data | Must be baked into claims (`definePayload`), so it's stale until refresh | Read `member` directly | `customSession` returns the role. Fresh |
| Sliding expiry | n/a | Rust doesn't refresh `expiresAt`. The SPA's own `useSession` calls do | better-auth handles it. Use `deferSessionRefresh` or `disableRefresh` to keep GETs read-only |
| Failure mode | Sidecar down → no new JWTs | Rust keeps working while the sidecar is down, but login is down anyway | Sidecar down → Rust auth fails, fail closed |
| Best for | Separate-origin APIs, third-party services, CLI tokens via the OAuth provider | Max performance once the schema is pinned | **Same-origin web app with a co-located sidecar (ostra)** |

**Real-world examples found**
- **Go, JWT + JWKS behind a TanStack Start proxy:** the auth app calls `auth.api.getToken`, forwards to Go with a Bearer token, and Go verifies against JWKS. The author's stated costs: an extra hop, two runtimes, and SSE/WebSocket needing a better proxy ([dev.to, 2025-12-25](https://dev.to/rogasper/bridging-the-gap-implementing-better-auth-with-non-node-backends-5dh4)).
- **Go port** that re-implements better-call's HMAC cookie signing, "value.hmac_sha256_base64": `patrickkabwe/betterauth-go` ([libraries.io](https://libraries.io/go/github.com%2Fpatrickkabwe%2Fbetterauth-go)). **Unverified** maturity.
- **Python port** `better-auth-server`, which claims wire and storage compatibility with the TS implementation and has a FastAPI integration ([PyPI](https://pypi.org/project/better-auth-server/)). **Unverified** maturity.
- **Rust:** `better-auth-rs`, a re-implementation for Axum + SeaORM targeting "`better-auth@1.7.6`: routes, payloads, cookies, and errors follow the upstream TypeScript runtime". It is alpha, "Public Rust APIs and database schemas can change between alpha releases", and not affiliated with better-auth. Its README lists organization, JWT, API keys, admin, device authorization, passkeys and GitHub OAuth. **No SSO/SAML plugin is listed** ([repo](https://github.com/better-auth-rs/better-auth-rs)).

## 1.5 Deployment implications

- Any official better-auth setup means **a JS runtime in the deployment**. The real choice is where it sits:
  1. **Sidecar in the same container.** Rust supervises a `node`/`bun` child process. Compose has `ostra` + `postgres`. Costs: a bigger image (adds a Node or Bun runtime, tens of MB; exact size **unverified**, see S2) and two runtimes to patch.
  2. **A separate `auth` or `web` container.** Clean process separation and three services in compose. Costs: an inter-container URL plus another health check and restart policy.
  3. **A Bun single-file executable** (`bun build --compile`) to avoid shipping `node_modules` ([Bun docs](https://bun.com/docs/bundler/executables)). **Unverified with better-auth.** Native drivers (`better-sqlite3`) and dynamic imports may not bundle cleanly, while the `pg` driver is pure JS. Worth a spike.
- **Config is code.** better-auth's `socialProviders` and plugins are set when the auth instance is built. A GitHub App created at runtime through the manifest flow (Part 2) therefore needs the sidecar to **restart** with the new client ID and secret, or a lazily built instance. The Rust supervisor can do this. **Spike:** whether any better-auth option accepts provider credentials resolved per request.
- **First-run bootstrap:** before GitHub login exists, the first admin needs email/password or a one-time setup token. Atlantis guards its own GitHub App setup page with basic auth for the same reason ([Atlantis](https://www.runatlantis.io/docs/access-credentials.html)).
- **Email:** invitations and verification call your `sendInvitationEmail`/`sendVerificationEmail`. Self-hosters often have no SMTP, so ostra should **show a copyable invite link** in the UI as a fallback.
- **Reverse-proxy settings:** set `baseURL`/`BETTER_AUTH_URL` to the public URL, `trustedOrigins`, and `advanced.ipAddress.ipAddressHeaders` for `X-Forwarded-For` ([options](https://www.better-auth.com/docs/reference/options)). Keeping everything same-origin avoids Safari ITP cross-site cookie problems ([cookies](https://www.better-auth.com/docs/concepts/cookies)).
- **Where the web UI lives:** either a static SPA (Vite) served by Rust using `better-auth/client`, or a TS full-stack framework app. A SPA keeps the JS footprint to "auth only".

## 1.6 Architecture options

### Option A: Rust front door + embedded better-auth sidecar (recommended)

```
 browser ──HTTPS──▶ ostra (Rust/axum, the only public port)
                     ├─ /            static SPA (Vite; better-auth/client)
                     ├─ /api/*       Rust API ── auth middleware ──▶ get-session (cached)
                     ├─ /api/auth/*  reverse-proxy ─▶ 127.0.0.1:3001  better-auth sidecar
                     │                                (Hono + better-auth, child process)
                     ├─ /api/github/webhooks
                     └─ /runner/ws   runners connect out
                    Postgres: schema "auth" (better-auth migrations) + schema "ostra" (Rust migrations)
```
- **Pros:**
  - One image and `docker compose` = `ostra` + `postgres`.
  - Everything is same-origin: cookies, SSE and WebSockets just work, with no CORS.
  - The JS surface is small (~100 lines of auth config) and replaceable.
  - Rust owns routing, rate limiting and TLS termination if needed.
  - Uses only documented better-auth HTTP contracts.
- **Cons:**
  - Two runtimes in one container: process supervision, a bigger image, two CVE streams.
  - A localhost hop for session checks, mitigated by caching.
  - Auth-related UI (sign-in, invite accept, device approval page, org settings) is written in the SPA against the client.
- **Session check:** (c) `get-session` + cache. `customSession` adds `{ orgRole }`. Optionally move to (b), a direct read-only SQL lookup, later, behind a contract test pinned to the better-auth version.

### Option B: TS full-stack web app in front, Rust API behind

```
 browser ──▶ web (TanStack Start / Next.js + better-auth) ──JWT──▶ ostra-api (Rust)
                                                     ▲ JWKS /api/auth/jwks
```
- **Pros:**
  - The most "normal" better-auth setup, with SSR and server actions available.
  - UI developers stay in one TS app.
  - Rust is stateless with respect to auth (JWKS verify).
  - Matches the creator's guidance.
- **Cons:**
  - Three compose services.
  - Either the web tier proxies all Rust calls, including log streaming over SSE/WebSockets (the dev.to author notes this needs "more robust proxy logic"), or the browser calls Rust cross-origin with bearer JWTs (CORS, token refresh, WS auth in a query string).
  - JWT revocation lag.
  - Two server codebases share domain types.

### Option C: all-Rust using `better-auth-rs`, better-auth client in the SPA

- **Pros:** a single static binary, no JS runtime on the server, one database layer.
- **Cons:**
  - Unofficial and **alpha** (schemas may change between alphas).
  - Compatibility target is 1.7.6, so it lags upstream.
  - No SSO/SAML listed.
  - ostra's auth security would rest on a young third-party re-implementation.
  - Arguably doesn't meet "must use better-auth" (D-005), since only the client would be better-auth.
- **Keep as a later swap:** if Option A only uses better-auth's HTTP contract, swapping the sidecar for `better-auth-rs` later is mostly a server change.

### Recommendation

**Option A.** It best fits "one `docker compose up`" (D-003, vision principle 6). It keeps the Rust core in charge of everything except identity, and it uses better-auth only through documented contracts (`/api/auth/*`, `get-session`, device flow). That makes upgrades and a possible future swap tractable. Settings:
- Postgres, with better-auth in schema `auth` (Kysely + `pg`, programmatic migrations at sidecar start) and Rust in schema `ostra`.
- No Redis secondary storage for sessions in v1.
- Plugins: `organization` (invitations and roles), `admin` (instance admin, create-admin), `deviceAuthorization` + `bearer` (runner/CLI bootstrap), `customSession`, GitHub social login using the deployment's GitHub App, and optionally `generic-oauth`/`sso` for company IdPs. Add `jwt` only if a separate-origin consumer appears.
- Pin better-auth exactly. CI runs a contract test: sign up, call get-session, check that the role claim is present.

## 1.7 Machine auth: how runners authenticate

**Recommendation: a Rust-native runner identity, bootstrapped by a human through better-auth.**

1. **Bootstrap, laptop runner:** `ostra-runner login https://ostra.example.com` runs better-auth's **device authorization** flow ([docs](https://www.better-auth.com/docs/plugins/device-authorization)). The CLI shows a code, the user approves at `/device` in the SPA, and the CLI receives a better-auth session token. The CLI uses that token **once**, as `Authorization: Bearer` (bearer plugin), to call Rust `POST /api/runners/register`.
2. **Bootstrap, shared or remote runner:** an admin creates a **one-time registration token** in the UI. Rust mints it with a short TTL, the same model as GitHub Actions runner registration tokens, which "expire after one hour" ([GitHub REST](https://docs.github.com/en/rest/actions/self-hosted-runners)). It gets passed to the VM as an env var.
3. **Registration:** the runner generates an **Ed25519 keypair locally** and sends the public key. Rust stores a `runner` row: owner (a user, or the org for shared runners), labels, capabilities, and which agents are allowed.
4. **Ongoing:** the runner opens an outbound WebSocket and proves possession of the key with a signed challenge. Alternatively it sends a signed JWT assertion, `private_key_jwt`-style, and gets back a short-lived Rust-minted access token. The private key is the only secret at rest. Put it in the OS keychain on laptops.
5. **Revocation:** deleting the runner row closes the socket immediately.

**Why not use a better-auth credential as the runner's identity?**
- *Device-flow session token:* it's a **human session**. It has a 7-day sliding expiry, shows up in the user's session list, and dies on "sign out everywhere" or a ban. A shared VM shouldn't be tied to one person's session.
- *API key plugin:* workable, since org-owned keys exist. But runner state (labels, liveness, assignment) lives in Rust anyway, and verifying means a sidecar call or reproducing the SHA-256 lookup. It's a better fit for **human personal access tokens** for scripting the ostra API.
- *OAuth provider + `oauthDeviceAuthorization()`:* standards-based (JWT access tokens with `aud` = ostra API, refresh tokens, DPoP available), and Rust would verify via JWKS ([resource server](https://www.better-auth.com/docs/plugins/oauth-provider/resource-server)). It's a reasonable **future** path for third-party API clients, but heavy for v1: client registration, a consent page, and resource config.

---

# Part 2: GitHub integration for a self-hosted tool

## 2.1 GitHub App vs OAuth App vs PAT

| | GitHub App | OAuth App | PAT (classic / fine-grained) |
|---|---|---|---|
| Permissions | Fine-grained per resource | Broad scopes (`repo`) | Classic is broad. Fine-grained is per repo |
| Repo selection | The installer picks repos | Everything the user can access | Per token |
| Tokens | Installation tokens expire in **1 h**. User tokens expire in **8 h** with a 6-month refresh | Long-lived by default | Long-lived, set by the user |
| Identity | Its own **bot** (`slug[bot]`). Keeps working when the installer leaves | Always the user | Always the user |
| Rate limits | 5,000/h per installation, **scaling to 12,500** (15,000 on GHEC) | 5,000/h per user | 5,000/h per user |
| Webhooks | One built-in webhook for all installed repos | Per-repo or per-org hooks you manage | None |
| Workflows triggered by its pushes and PRs | Yes. Installation tokens trigger workflows, unlike `GITHUB_TOKEN` | Yes | Yes |

Sources: [differences](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps) ("In general, GitHub Apps are preferred over OAuth apps"), [rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api), [triggering workflows](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow) ("events triggered by the `GITHUB_TOKEN` will not create a new workflow run… you can use a GitHub App installation access token or a personal access token").

**For ostra: a GitHub App.** It gives short-lived tokens that can be minted per task (essential for remote runners), a bot identity, repo selection by the team, one webhook, and the option of user-to-server tokens when acting for a human. Allow a PAT only as a "quick try" fallback, if at all. Renovate supports both and itself recommends "creating a GitHub App to use instead of using your own GitHub user account" ([Renovate](https://docs.renovatebot.com/modules/platform/github/)).

## 2.2 The manifest flow (one-click app per deployment)

**How it works** ([manifest docs](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest), [conversion API](https://docs.github.com/en/rest/apps/apps#create-a-github-app-from-a-manifest))
1. ostra's setup page renders a form that **POSTs** a `manifest` (a JSON string) plus a random `state` to `https://github.com/settings/apps/new` (personal) or `https://github.com/organizations/ORG/settings/apps/new` (org).
2. The admin reviews the app on GitHub, can rename it, and clicks *Create*. GitHub redirects to `redirect_url?code=…&state=…`.
3. ostra calls `POST /app-manifests/{code}/conversions`. No auth is needed: the one-time code is the credential. It gets back `id, slug, client_id, client_secret, webhook_secret, pem, owner, html_url, permissions, events`.
4. All three steps must finish **within one hour**. The conversion endpoint is rate-limited. The **registrant owns** the app.

**Manifest fields:** `name`, `url` (required), `hook_attributes{url, active}`, `redirect_url`, `callback_urls` (max 10), `setup_url`, `description`, `public`, `default_events`, `default_permissions`, `request_oauth_on_install`, `setup_on_update`.

**Sketch for ostra**
- `name`: `ostra-<team>` (editable). App names are global on GitHub, **unverified** but widely observed, so suggest a unique default.
- `url`: `OSTRA_URL`. `hook_attributes.url`: `OSTRA_URL/api/github/webhooks`.
- `redirect_url`: `OSTRA_URL/setup/github/callback`. `callback_urls`: `[OSTRA_URL/api/auth/callback/github]`, the better-auth GitHub login callback.
- `setup_url`: `OSTRA_URL/setup/github/installed`.
- `public: false` makes the app installable only on the owner account. Use `public: true` if the team has several orgs. "Public" just means installable by others; it isn't a Marketplace listing.
- After conversion: store `pem`, `client_secret` and `webhook_secret` encrypted at rest. Then send the admin to `https://github.com/apps/<slug>/installations/new` to pick repos, and **restart the auth sidecar** so GitHub login turns on (1.5).
- Settings the manifest **cannot** set, so the admin toggles them in GitHub settings if wanted: *Enable Device Flow* (not needed), and opting out of user-token expiration (expiring tokens are the default for new apps, per [refresh docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)). That this list is complete is **unverified**.
- **Protect the setup page** until it has run once. Atlantis returns 400 after the first exchange and recommends basic auth during setup ([Atlantis](https://www.runatlantis.io/docs/access-credentials.html)).

**What other tools do**
- **Atlantis:** `/github-app/setup` implements the manifest flow ([source](https://github.com/runatlantis/atlantis/blob/main/server/controllers/github_app_controller.go)). It shows the private key and webhook secret once, then asks you to restart with `--gh-app-id`, `--gh-app-key-file` and `--gh-webhook-secret`. It supports only one installation per app.
- **Probot:** a first-run wizard on `localhost:3000` registers the app from a manifest and writes the credentials into `.env` ([Probot](https://probot.github.io/docs/development/), [GitHub's manifest page](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)).
- **Backstage:** `yarn backstage-cli create-github-app <org>` uses a manifest and writes a YAML credentials file. It's github.com only, and the docs say GHES needs manual creation ([Backstage](https://backstage.io/docs/integrations/github/github-apps/)).
- **Renovate (self-hosted):** documents **manual** app creation plus an installation token passed in `token`. It points to external helpers for 1 h token refresh ([Renovate](https://docs.renovatebot.com/modules/platform/github/)).

**Webhook reachability (self-hosting gotcha).** GitHub has to reach `hook_attributes.url`. Teams behind NAT need a public HTTPS endpoint (reverse proxy, Cloudflare Tunnel, Tailscale Funnel), or ostra falls back to **polling** active tasks' PRs and checks. Polling is cheap at a few tasks against a 5,000/h budget. For catch-up after downtime, apps can list and **redeliver** webhook deliveries via `GET /app/hook/deliveries` and `POST /app/hook/deliveries/{id}/attempts`, using an App JWT ([webhooks REST](https://docs.github.com/en/rest/apps/webhooks)). Backstage's generated app points its webhook at smee.io, which is for local development only.

## 2.3 Minimum permissions and events

| Need | Permission | Source |
|---|---|---|
| Clone private repos, push branches (HTTPS git with `x-access-token`) | **Contents: write** (read for clone only) | [choosing permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app) |
| Edit `.github/workflows/*` | **Workflows: write**. *Optional, by policy.* Without it, pushes touching workflow files are rejected (the REST equivalents need it per [permissions table](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps). The git-push rejection is widely reported but **not confirmed in docs**) | same |
| Open and update PRs, request reviewers, review comments and replies, create reviews | **Pull requests: write** | [permissions table](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps) |
| Comment on the PR conversation (`POST /issues/{n}/comments`) | Issues: write **or** Pull requests: write | same |
| Read check runs and suites for a ref | **Checks: read** (write to publish ostra's own check) | same |
| Read combined status / statuses | **Commit statuses: read** | same |
| Repo metadata | **Metadata: read** (default) | [Atlantis](https://www.runatlantis.io/docs/access-credentials.html) lists it as default |
| Sign in with GitHub (better-auth) | Account permission **Email addresses: read** | [better-auth GitHub](https://www.better-auth.com/docs/authentication/github) |
| CI logs, `workflow_run` (later: CI fix loops) | Actions: read (optional) | [webhook events](https://docs.github.com/en/webhooks/webhook-events-and-payloads) |

**Webhook events to subscribe to** ([webhook events](https://docs.github.com/en/webhooks/webhook-events-and-payloads)). An app can only subscribe to events whose permission it holds ([choosing permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)).

| Event | Needs |
|---|---|
| `pull_request`, `pull_request_review`, `pull_request_review_comment`, `pull_request_review_thread` | Pull requests: read |
| `issue_comment` (PR conversation comments arrive as issue comments) | **Issues: read** ← easy to miss |
| `check_run`, `check_suite` | Checks: read |
| `status` | Commit statuses: read |
| `push` | Contents: read |
| `workflow_run`, `workflow_job` (optional) | Actions: read |
| `installation`, `installation_repositories`, `github_app_authorization` | Automatic, can't unsubscribe |

**Proposed manifest `default_permissions`:** `contents: write`, `pull_requests: write`, `issues: read`, `checks: read` (or `write`), `statuses: read`, `metadata: read`, `email_addresses: read`. Optional: `workflows: write`, `actions: read`. Exact manifest key spellings, such as `email_addresses` and `statuses`, are **unverified** and need checking against the REST app-permissions schema. For comparison, Atlantis requests Administration, Checks, Commit statuses, Contents, Issues, Pull requests, Webhooks, Members and Actions. Renovate adds Dependabot alerts, Merge queues and Workflows.

## 2.4 Installation tokens and remote runners

**Facts**
- `POST /app/installations/{installation_id}/access_tokens` is authenticated with an **App JWT**: RS256, `iat` 60 s in the past, `exp` ≤ 10 min, `iss` = client ID (preferred) or app ID ([JWT docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app)).
- The body can narrow the token. `repositories` or `repository_ids` (≤ 500) and `permissions` (a subset of the app's). Omit them and the token gets everything the installation has. Tokens **expire after 1 hour** ([REST](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)).
- **The new format** `ghs_<APPID>_<JWT>` is about **520 chars**. Treat it as opaque and don't assume 40 chars, since it affects DB columns and log redaction regexes. GitHub's suggested regex is `ghs_[A-Za-z0-9\.\-_]{36,}` ([changelog 2026-10-02](https://github.blog/changelog/2026-10-02-stateless-github-app-installation-tokens-rolled-out/), [notice 2026-04-24](https://github.blog/changelog/2026-04-24-notice-about-upcoming-new-format-for-github-app-installation-tokens/)).
- GitHub's best practice is to cache tokens until near expiry and keep the private key in a vault, not hard-coded ([best practices](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app)).
- **Installation tokens cannot be scoped to a branch.** A `contents: write` token can push to any unprotected branch in the scoped repos.

**Recommended flow**
```
runner (no GitHub secrets)                      ostra server (holds App private key)
  git fetch/push in task worktree
    └─ git credential helper: `ostra-runner git-credential`
         └─ WS request: creds(task_id, repo) ───────▶ check: task assigned to this runner, active,
                                                     repo == task.repo, requester may push
                                                   ◀── mint: POST …/access_tokens
                                                       {repository_ids:[repo], permissions:{contents:write}}
         ◀── {username: x-access-token, password: ghs_…, expires_at}
```
- The worktree's git config gets `credential.https://github.com.helper` pointing at the runner, plus `credential.useHttpPath=true`. The token lives in memory only and is never written to `.git/config` or the remote URL.
- **All other GitHub calls happen on the server** with its own tokens: open/update PR, comment, request reviewers, read checks. The runner never gets `pull_requests: write`.
- **The agent has a shell (Q-14).** Anything the runner can obtain, the agent can too: it could call the credential helper itself, or read the process environment. Mitigations:
  - Keep tokens push-only, repo-scoped and 1 h.
  - Have the runner, not the agent, perform pushes, and only expose the helper during the push (for example a one-shot `GIT_ASKPASS` nonce that the agent's environment lacks).
  - Ask teams to protect default and release branches with rulesets, with ostra **not** on the bypass list.
  - Optionally, a server-side git push proxy that only accepts `refs/heads/ostra/*`. Strongest, but more work.
- Revoking early: `DELETE /installation/token` exists for revoking an installation token. Whether it works with stateless tokens is **unverified**.
- **User-mode equivalent:** `POST /applications/{client_id}/token/scoped` turns a user token into a repository- and permission-scoped one (Basic auth with the app's client ID and secret) ([REST](https://docs.github.com/en/rest/apps/apps#create-a-scoped-access-token)). It's the user-token analogue for pushes made as a human. Whether this affects the original token, and its expiry, is **unverified**.

## 2.5 PR authorship

**Facts that drive the decision**
- "Pull request authors cannot approve their own pull requests" ([approving PRs](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/approving-a-pull-request-with-required-reviews)).
- "Require approval of the most recent reviewable push" means it "must be approved by someone other than the person who pushed it". Required reviews count people with write access, or code owners ([protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)).
- Code owners "must have write permissions" and are users or teams. They're auto-requested on non-draft PRs, and on ready-for-review ([CODEOWNERS](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)). Bots aren't described as code owners, so an ostra-authored change still needs a human code owner.
- **Precedent, GitHub Copilot cloud agent:** "commits are authored by Copilot, with the developer who assigned the issue or requested the change" as co-author. GitHub "prevents the user who asked Copilot… to create a pull request from approving it". It pushes only to `copilot/` branches, and its commits are signed ([Copilot risks & mitigations](https://docs.github.com/en/copilot/concepts/agents/coding-agent/risks-and-mitigations)). **This "requester can't approve" rule is GitHub-internal.** A third-party bot gets no such protection: the requester can approve the bot's PR.
- **User-to-server tokens** (`ghu_`, 8 h, refresh `ghr_` for 6 months, **single-use refresh**: "Once you use a refresh token, that refresh token and the old user access token will no longer work"). They carry the **intersection** of app and user permissions. They "attribute activity to both the user and the app", and GitHub says an app acting for a user "should always use a user access token instead of an installation access token" so users can't exceed their own access ([user tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app), [refresh](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens), [best practices](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app)).
- **Co-authored-by:** `Co-authored-by: Name <email>` trailers after a blank line. Credit requires an email linked to the GitHub account, or the user's noreply address ([multiple authors](https://docs.github.com/en/pull-requests/committing-changes-to-your-project/creating-and-editing-commits/creating-a-commit-with-multiple-authors)). Bot author email format is `<bot-user-id>+<slug>[bot]@users.noreply.github.com` ([Renovate](https://docs.renovatebot.com/modules/platform/github/)).
- **Signing:**
  - GitHub signs web-UI commits. "Signature verification for bots will only work if the request is verified and authenticated as the GitHub App or bot and contains no custom author information, custom committer information, and no custom signature information" ([commit signature verification](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification)).
  - GraphQL `createCommitOnBranch` commits "are automatically GPG signed and are marked as verified", and apps can use it "to author commits directly or on behalf of users" ([changelog 2021-09-13](https://github.blog/changelog/2021-09-13-a-simpler-api-for-authoring-commits/)).
  - Commits made locally and **pushed with `git push` are not signed by GitHub**.
  - With *Require signed commits*, "contributors and bots can only push commits that have been signed and verified" ([protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)). A bot can't register its own GPG/SSH signing key, **unverified** but no mechanism found.

**Options**

| | **1. Bot-authored** (installation token) | **2. User-authored** (user-to-server token) | **3. Hybrid: user opens PR, bot pushes** |
|---|---|---|---|
| Commit author / pusher | `ostra[bot]` (+ `Co-authored-by: requester`) | Requester / requester | `ostra[bot]` + co-author / bot |
| PR author | `ostra[bot]` | Requester ("via ostra") | Requester |
| Requester can approve? | **Yes, a governance gap.** Needs an ostra-published required check ("approved by someone other than the requester") that admins add to branch protection | No, GitHub enforces it natively | No, enforced natively |
| Respects the human's own repo permissions | No. ostra must check them itself | Yes (intersection) | PR creation is gated by the user token. Pushes aren't, so ostra checks push permission |
| Tokens on runners | Repo-scoped installation token | Scoped user token, or the user's own git creds on a laptop | Repo-scoped installation token |
| User must connect GitHub | No | Yes, and stay connected (6-month refresh) | Yes, but the token is used **server-side only**, once per PR |
| Signed-commit repos | Use the API commit path (signed as bot) | Laptop: the user's own signing key. Remote: API commit path with the user token (signing on behalf of users is claimed by the 2021 changelog; **verify**) | API commit path as bot |
| Workflows run on its pushes | Yes | Yes | Yes |
| Survives requester leaving | Yes | PR updates fail. Fall back to the bot | Yes (bot pushes) |

**Suggestion for Q-10** (your call): make it a policy with **Option 3 as the default**. It gets GitHub's native "author can't approve" rule like Copilot, keeps runners on bot tokens, and keeps user tokens server-side. Fall back to **Option 1 + an ostra review-gate check** when the requester hasn't linked GitHub. Offer **Option 2** for teams whose rules require human-authored and human-signed commits.

**Operational notes**
- **One owner for user-token refresh.** GitHub refresh tokens are single-use, so if both better-auth and Rust refresh, one breaks. Let better-auth own refresh (`auth.api.getAccessToken`), and have Rust single-flight its requests per user through the sidecar. Whether better-auth itself serialises concurrent refreshes is **unverified**.
- **Rate limits:** user tokens share the user's 5,000/h with all their other apps. Installation tokens get 5,000–12,500/h. Content-creating requests have secondary limits of about **80/min and 500/h** ([rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)).
- Squash-merge author attribution for bot-authored commits is debated ([community discussion](https://github.com/orgs/community/discussions/179983)). **Unverified.**

## 2.6 Linking to Linear

**How Linear's GitHub integration detects links** ([Linear docs](https://linear.app/docs/github))
- **Branch name containing the issue ID.** "Copy git branch name" uses a configurable format. Any branch with `ENG-123` in it links.
- **PR title or description** containing the ID. With a magic word, the relationship type changes:
  - *Closing* (`fixes`, `closes`, `resolves`, `implements`) → the issue moves to the "On PR merge" status.
  - *Non-closing* (`ref`, `part of`, `contributes to`).
  - `skip ENG-123` suppresses linking, even when the branch name matches.
- **Commit messages:** only with an extra setting plus a push webhook.
- **Status automation is per team:** draft, open, review requested, ready to merge, merged. One PR can close several issues. An issue moves only when its *last* linked PR does.
- If the issue is unassigned, "the PR author is added as assignee". With a bot author, the mapping is **unverified**.
- It needs Linear's own GitHub app installed by an org owner or repo admin. PR linking doesn't require code access.

**Linear API hooks ostra can use** ([schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql))
- `Issue.branchName`: "A suggested Git branch name based on the issue's identifier and title and your branch naming preferences."
- `attachmentLinkGitHubPR(issueId, url, linkKind, title, …)`: "Link a GitHub pull request to an issue. Uses the matching GitHub integration when available; may fall back to a URL attachment."

**Should ostra rely on it?** Use it, but don't depend on it:
1. Name branches from `issue.branchName`, or `ostra/<identifier>-<slug>`. Either works with or without the integration.
2. Put `Fixes ENG-123` in the PR body. Whether it's closing or non-closing is configurable.
3. **Explicitly call `attachmentLinkGitHubPR`** so the link exists even when Linear's GitHub app isn't installed.
4. Make ostra's own status writes **configurable**: "Linear's GitHub automation drives status" vs "ostra drives status". Otherwise both will transition the issue.

## 2.7 Rust crates

**`octocrab` 0.54.9** ([docs.rs](https://docs.rs/octocrab/latest/octocrab/struct.Octocrab.html), [repo](https://github.com/XAMPPRocky/octocrab))
- **GitHub App support** (feature `jwt`):
  - `installation(id)` returns an installation-scoped client.
  - `installation_builder(id)` scopes the minted token to specific repos: "The scope is retained, so automatic token refresh re-mints a token with the same scope".
  - `installation_and_token`, `installation_token`, `installation_token_with_buffer` return cached tokens.
  - `user_access_token(..)` for user mode, plus device-flow helpers.
- Typed handlers for `pulls`, `issues`, `checks` and `repos`, a raw `graphql()`, and raw HTTP for untyped endpoints.
- **Webhooks:** `models::webhook_events` (`WebhookEvent::try_from_header_and_body`) plus a `verification` module for signature checks, marked "beta" ([docs.rs](https://docs.rs/octocrab/latest/octocrab/models/webhook_events/index.html)).
- **Maturity:** widely used (~20M downloads, active in Nov 2026) but **pre-1.0**, so expect breaking minors. Whether permission-scoped (not just repo-scoped) minting is exposed is **unverified**. If it isn't, the raw `POST /app/installations/{id}/access_tokens` is a single call, with `jsonwebtoken` (RS256) for the App JWT.

**Git from Rust**

| | Shell out to `git` CLI | `git2` 0.21 (libgit2) | `gix` 0.90 (gitoxide) |
|---|---|---|---|
| Clone/fetch HTTPS with credentials | Yes, credential helpers, `GIT_ASKPASS` | Yes, `RemoteCallbacks::credentials` | Yes (curl or reqwest transport; `gix-credentials`) |
| **Push** | Yes | Yes (`Remote::push`) | **No:** "`push`… needs plumbing", send-pack client unchecked ([crate-status](https://github.com/GitoxideLabs/gitoxide/blob/main/crate-status.md)) |
| **Worktrees** | Full `git worktree add/remove/prune/lock` | `Repository::worktree(..)` add, `worktrees`, `find_worktree`, plus `Worktree::{validate, lock, prune}` ([docs.rs](https://docs.rs/git2/latest/git2/struct.Worktree.html)) | Open and handle linked worktrees, **create** linked worktrees. Move/remove/repair not yet |
| Checkout / reset / rebase | Yes | Yes (no hooks) | Checkout/reset orchestration, merge workflow, rebase all unchecked |
| Hooks, LFS, partial clone, sparse checkout | Yes (whatever git supports) | No hooks. Limited partial or sparse support (general libgit2 knowledge, **unverified** for 2026) | Hooks unchecked |
| Commit signing | Yes (user's gpg/ssh config) | Manual (`commit_signed`) | "create signed commits and tags" unchecked |
| Deployment | Needs `git` on the runner | C dependency (vendored OK) | Pure Rust |

**Recommendation:** the runner **shells out to `git`** for all mutations: bare/mirror clone per repo, `git worktree add -b ostra/… <path> origin/<base>`, fetch, push. Reasons:
- Agents run `git` inside the same worktree, so behaviour, hooks and config match exactly.
- Credential helpers fit the token flow in 2.4.
- Developer laptops already have git.

Use `gix` optionally for fast **read-only** inspection on server or runner (status, diff stats, rev-parse) where avoiding process spawns matters. `git2` isn't worth the libgit2 divergence when the CLI is available anyway.

---

# Implications for ostra

1. **Q-04 → Option A.** Rust is the front door, with an embedded better-auth sidecar, same-origin, in one image. Compose is `ostra` + `postgres`. Rust checks sessions through `get-session` (cached) plus `customSession`. No JWT needed for the browser in v1.
2. **Q-15 → Postgres for v1.** Two schemas: `auth` is owned by better-auth (programmatic Kysely migrations at sidecar start) and `ostra` by Rust. No Redis session storage. SQLite only as an evaluation mode, if ever.
3. **Pin better-auth exactly.** Upgrades are deliberate, with a contract test (sign-up → get-session → role). Avoid reading better-auth tables from Rust except through documented contracts, or behind that test.
4. **Q-03 (tenancy) shapes plugin use.** Single-org deployments can still use the organization plugin with exactly one org, created at bootstrap, to get invitations and roles. Pick one role source for Rust authorization: org `member.role`, not admin `user.role`, plus an instance-admin flag.
5. **Runner identity is Rust-native.** An Ed25519 keypair is registered via a one-time token (remote) or better-auth device-flow login (laptop). Runner auth never depends on a human's browser session.
6. **The GitHub setup wizard is part of first-run UX:** manifest POST → conversion → install → sidecar restart to enable "Sign in with GitHub". The bootstrap admin needs a non-GitHub login first (email/password or a setup token).
7. **Webhooks need a public URL.** Document tunnels, and build a polling fallback for active tasks. Use the redelivery API to catch up after downtime.
8. **Runners hold no GitHub secrets.** Per-task, per-repo, `contents:write`, 1 h installation tokens via a credential helper. The server makes all PR, comment and check calls. Plan DB columns and redaction for ~520-char tokens.
9. **Q-10 should be a per-deployment policy.** Suggested default: user-opened PR + bot-pushed commits + `Co-authored-by`. Fallback: bot PR + an ostra "independent approval" required check (needs `checks: write`). The doc should explain why bot-only PRs let requesters self-approve.
10. **Q-14:** the agent can reach anything the runner can. Keep push tokens minimal. Have the runner push, not the agent. Recommend rulesets protecting default branches. Consider a push proxy that restricts refs to `ostra/*`.
11. **Signed-commit repos need a "commit via API" path:** `createCommitOnBranch` or the Git Data API with no custom author fields, so GitHub signs as the bot. It's a separate code path from `git push`. Spike before promising support.
12. **Linear:** branch names from `issue.branchName`, `Fixes ID` in the PR body, plus an explicit `attachmentLinkGitHubPR`. Status ownership is configurable to avoid double transitions with Linear's own GitHub automation.
13. **Check the requester's permission before dispatch.** Installation tokens can do more than the human. Confirm the requester has push access to the repo, via the user token or the collaborator-permission API.

# Unknowns / things to spike

| # | Question | Why it matters | How to test |
|---|---|---|---|
| S1 | Can better-auth load GitHub social-provider credentials at runtime, or must the sidecar restart after the manifest exchange? | First-run UX, supervision design | Read `socialProviders` init code; try a lazy `betterAuth()` factory |
| S2 | Does `bun build --compile` (or Node SEA) bundle better-auth + `pg` + Hono cleanly? Image size vs `node:22-slim` | Single-image simplicity | Build both, measure, run the contract test |
| S3 | `get-session` from Rust: latency, `Set-Cookie` side effects with `updateAge`, behaviour with `deferSessionRefresh` | Option (c) correctness | Prototype the axum middleware + moka cache |
| S4 | Postgres `schemaName: "auth"` with programmatic `getMigrations()` (not just the CLI), and FKs from `ostra.*` into `auth.user` across upgrades | Shared-DB plan | Migrate 1.7.x → 1.8 beta on a scratch DB |
| S5 | Concurrent `getAccessToken` refreshes for the same GitHub account: does better-auth serialise them? | Single-use refresh tokens could break user mode | Fire parallel calls against a GitHub App with expiring tokens |
| S6 | Exact manifest permission keys (`email_addresses`, `statuses`, `workflows`) and which settings can't be set by manifest | Wizard correctness | Create a test app from a manifest |
| S7 | Does `git push` touching `.github/workflows/` without `workflows: write` fail with an installation token? | Policy for agent-edited CI | Push test |
| S8 | API commit path: does `createCommitOnBranch` (or Git Data API) with an installation token produce "Verified" commits today, including `Co-authored-by` trailers? Size and binary limits? Same with a user token? | Signed-commit repos | Test repo with required signatures |
| S9 | `DELETE /installation/token` with stateless `ghs_` tokens. Can ostra revoke a runner's token when a task ends? | Limits exposure if an agent exfiltrates a token | API test |
| S10 | Does octocrab expose permission-scoped installation tokens (`permissions` body), or is a raw call needed? | Crate choice | Read source / try |
| S11 | Linear: are PRs opened by a GitHub App bot linked and auto-assigned the same way as human PRs? How does `attachmentLinkGitHubPR` behave without Linear's GitHub app? | Ticket UX | Test workspace |
| S12 | The "independent approval" check: can an ostra-published check run, made required in branch protection, reliably enforce "approver ≠ requester"? Re-evaluate on new pushes (dismiss stale reviews) | Governance in bot-PR mode | Prototype on a test org |
| S13 | Can a remote runner sign commits *as the user*? Probably only via the API path, since a bot can't hold signing keys | Option 2 on remote runners | Docs + test |
| S14 | Is `better-auth-rs` maturing (stable release, SSO, an upstream-tracking cadence)? | Possible later removal of the Node runtime (Option C) | Re-check around v1 |
