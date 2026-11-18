# Spike 5: `linear-agent-mode`

Milestone 0, spike 5 of `context/build-order.md`. Throwaway code that answers one question. Its finding goes into `context/research/` after real runs, not before.

## The question

> Can the server alone meet Linear's agent deadlines from a self-hosted install?

**Tests the decisions:** ADR 0013 (Linear works in two modes; agent mode needs a public HTTPS address) and Q25 (the official SDK, wrapped in an adapter). F-012 ("Start from Linear") rests on it.

### Pass bar (copied)

- The app installs from a manifest link, as its own workspace user.
- Across 50 delegations, the webhook is answered in under 5 s and the first activity lands in under 10 s, with no runner involved.
- Stop and follow-up arrive. A silent turn of 35 minutes stays alive.
- `@linear/sdk` typechecks under ostra's strict flags and adds under 20 s to `tsc` *(working value)*.

**If it fails:** agent mode (F-012) moves after v1. The plain API stays.

## Status, from the run on this machine on 2026-11-18

Windows 11, Node 24.14.0, pnpm 11.28.2. No Docker, no Postgres, no model. A Linear test workspace exists (`context/build-order.md`, "Outside the code", done 2026-11-18) and `~/.config/ostra-dev/linear.env` is there and should hold `LINEAR_API_KEY` (`pnpm check:inputs` finds the file by name only; it was **not loaded or read** for any run here, so no real credential was used). What is missing for a real run: a public https address (no `tunnel.env`), an admin clicking **Create** on the manifest link and then **Authorize**, and 35 wall-clock minutes. This spike needs no GitHub account, no Docker, no Postgres and no model.

`pnpm spike` prints one verdict per pass-bar bullet. A bullet is **PASS only when a real Linear run backs it**, or when it never needed one. A pass against the local fake Linear is printed on its own lines and never counts as the bullet. **So of the five bullets, one is passed (5) and four are SKIPPED (1 to 4). None of the four is passed.** The harness says so on its last lines.

| # | Pass-bar bullet | Against the fake Linear | Against real Linear |
|---|---|---|---|
| 1 | Installs from a manifest link, as its own workspace user | 34 checks pass | **SKIPPED**: needs `OSTRA_DEV_PUBLIC_URL`, `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET`, and an admin clicking Create, then Authorize |
| 2 | 50 delegations: ack under 5 s, first activity under 10 s, no runner | 65 checks pass | **SKIPPED**: same inputs, plus 50 delegations (automated if `LINEAR_API_KEY` is set) |
| 3 | Stop and follow-up arrive | 21 checks pass | **SKIPPED**: same inputs, plus a person pressing Send stop request and posting a follow-up |
| 4 | A silent turn of 35 minutes stays alive | 17 checks pass, on a clock 300x faster than the wall clock | **SKIPPED**: same inputs, plus 35 minutes of wall-clock time |
| 5 | `@linear/sdk` typechecks strictly and adds under 20 s to `tsc` | no fake involved | **PASS** (runs fully here): see below |
| H | Webhook handler edges: signed replays, tampering, duplicates (extra, not a bullet) | 25 checks pass | n/a |

What a fake pass is worth, per bullet:

- **Bullet 1.** The manifest is checked against the spike's **Zod copy** of Linear's published schema, and the fake's "Create" accepts or refuses a manifest with that same copy, so those two checks cannot disagree with the code that built the manifest. What is not circular: the copy is compared with a **snapshot of Linear's published JSON schema** (`snapshots/`, read from `https://linear.app/.well-known/oauth-app-manifest.schema.json` on 2026-11-18) on required fields, enums, constants, closed objects and length limits (25 facts, with a control that a changed snapshot is noticed). That shows the copy matches the document, not that Linear's server enforces it. The manifest hand-out route (`/integrations/linear/manifest`) is exercised on an https and on a loopback address.
- **Bullet 2.** The ack and first-activity times are **loopback HTTP, with an in-memory `Map` for the inbox and no tunnel**. Without injected latency, the ack as the sender saw it is 0.7 to 48 ms (a burst of 50 at once is the slow end), the server's own part of it (request in to 200 flushed) is 0.2 to 2.7 ms, and the first activity is 0.7 to 80 ms; the fake's injected Linear API latency pushes the first activity to 1.3 s (600 ms per call) and 5.0 s (5 s per call). In ostra the 200 follows a durable Postgres insert and travels through a proxy with TLS, and none of that is in those numbers. To show how much room that leaves, the latency scenario adds **inbox variants** that put a fixed delay before the 200: with 250 ms and with 4 s the ack and first activity still hold; a probe at 4.5 s holds and one at 5.2 s breaks (the fake's 5 s runs out and the webhook is undelivered). The server's own part of the ack was about 4 ms, so the insert, the proxy and TLS share just under 5 s between them. **Ack time excludes the durable inbox insert and the tunnel until the real run**, and even the real run adds only the one-way transit from Linear's timestamp and never measures the 200's return leg.
- **Bullet 3.** The fake emits the stop and follow-up shapes the spike assumed (`prompted` with `signal: "stop"`). A stop that reaches a different replica than the one running the turn is **not covered**: session state is a per-process `Map`, so a stop for a session this process never saw gets its final response but cannot stop a turn running elsewhere.
- **Bullet 4.** The fake defines Linear's staleness rule, and its `touch()` resets the clock on any thought, ephemeral or not. So "the session was never stale" shows that ostra's timer posts a heartbeat, **not that Linear counts an ephemeral thought as activity**. The control variant (no heartbeat, the same turn does go stale) shows the fake can see staleness at all. The 35-minute run at 300x was the only keep-alive run in this round: `pnpm spike -- --only keep-alive --real-time` would run it for 35 real minutes against the fake, and **no such run of this version is recorded here** (an earlier version of this README claimed one passed, with no log kept; that claim is withdrawn).

### Bullet 5, the one that ran for real

`@linear/sdk` 102.0.0, under every flag in `tsconfig.base.json` (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax`), `lib: ["es2024"]` and `@types/node` 26.6.6 and TypeScript 6.0.3, the same as ostra's root workspace. Measured twice: with **`skipLibCheck` off**, so tsc checks the SDK's own 5 MB of declarations too (stricter than ostra's root config), and with it **on** (ostra's root config). `pnpm measure:tsc`: 5 timed runs after a warm-up, wall time of the whole process.

| Setting | Without the SDK | With the SDK | The SDK adds | Budget |
|---|---|---|---|---|
| TypeScript 6.0.3, `skipLibCheck` off | 1.08 s | 1.85 s | **0.78 s** | 20 s |
| TypeScript 6.0.3, `skipLibCheck` on (ostra's root config) | 0.39 s | 0.65 s | **0.26 s** | 20 s |

- The SDK pulls in 133 files and about 116,000 lines of declarations (180,831 against 64,494), and about 200 MB more tsc memory with lib checking on (258 to 455 MB; 88 to 214 MB with it off).
- The two projects (`measure/baseline`, `measure/with-sdk`) differ only by the SDK. The whole spike (this package, 460 files) typechecks in 2.0 s.
- A cold `import` costs a server 33 ms for `@linear/sdk` and 7 ms for `@linear/sdk/webhooks`.
- **ostra's own config needs no shim.** Its root `tsconfig.base.json` has `lib: ["ES2024"]` and `skipLibCheck: true`, and `measure/root-style` (strict flags, `skipLibCheck` on, no DOM, no shim file) typechecks the SDK's usage with 0 errors. The harness checks that on every run.
- **The shim is needed only with `skipLibCheck` off.** The SDK's declarations name two DOM types, `JsonWebKey` and `CryptoKeyPair`, for its DPoP signer. With no DOM lib and `skipLibCheck: false`, tsc reports two errors in the SDK's own `.d.mts`. `src/sdk-shims.d.ts` aliases them to Node's equivalents (four lines). If ostra turns `skipLibCheck` off, it needs this, or the `dom` lib in server packages.
- The measure is of the compiler on a small project. It says what the SDK adds, not what ostra's whole repo will cost, and it doesn't cover the editor's language server.
- Not measured here: TypeScript 7.x (the native compiler). An earlier version of this spike measured it (the reviewer reproduced about 0.11 s added) through a `typescript-native` alias that the maintainer had not approved, so it was removed. Ask first if the number is wanted.

## Architecture

```
 fake Linear (src/fake-linear)                       ostra server (src/server.ts)
 ┌──────────────────────────────┐                    ┌─────────────────────────────────────────────┐
 │ /oauth/authorize, /oauth/token│ <──────────────── │ GET /integrations/linear/install, /callback │
 │ /graphql: viewer, agentSession│                   │   PKCE + state, actor=app, viewer.app check │
 │  agentActivityCreate,         │ <──────────────── │ LinearClient (@linear/sdk) → agent-sessions │
 │  agentSessionUpdate           │                   │                                             │
 │ signed webhooks, retries,     │ ────────────────> │ POST …/webhook: verify → inbox → 200 → work │
 │ session status from last      │                   │   agent-sessions.ts: fast lane, heartbeat,  │
 │ activity, 5 s / 10 s / 30 min │                   │   stop, follow-up; one chain per session    │
 └──────────────────────────────┘                    └──────────────┬──────────────────────────────┘
                                                                     │ TurnDriver (the runner's seam)
                                                      silent / unavailable / instant stand-ins
```

- **`manifest.ts`**: builds Linear's OAuth-app manifest link (the JSON `?manifest=` form and the dot-notation form), validates it against a Zod copy of Linear's published schema, and checks the public address (https, not loopback or private network) before the admin pastes anything. **`manifest-schema-check.ts`** compares that copy with the snapshot in `snapshots/`.
- **`server.ts`**: `node:http`, no framework. The webhook route verifies the signature and freshness with the SDK's `LinearWebhookClient`, claims the delivery ID *and* the signature in the inbox (an async `DeliveryLedger`, a `Map` here with an optional insert delay; in ostra a Postgres insert), validates the body with Zod (vendor-owned, so unknown fields are tolerated), answers 200, and only then hands the event to the service. One timing record per accepted webhook is kept per session, so a reader joins on the session ID. The install routes are open on the public address, so the OAuth `state` table is capped (100, oldest out) and swept by a timer; an installation summary is an allow-list of five fields.
- **`agent-sessions.ts`** is the fast lane. On `created` it posts a thought and sets the session's external link **at once, in parallel**, with hedged retries inside a 7 s budget, and only then asks the driver for a run. It records `firstThoughtAt` (the pass bar's first activity: a posted thought) separately from `firstActivityAt` (the first of thought or link, Linear's "unresponsive" rule). A silent turn gets an ephemeral-thought **heartbeat** every 20 minutes. A stop cancels the heartbeat, stops the turn and posts one final response. A follow-up goes to the running turn, or reopens a finished session with its text. Events for one session run in order; sessions run side by side.
- **`session-model.ts`**: ostra's own lifecycle for a session as a discriminated union (`received`, `acknowledged`, `working`, `stopping`, `ended`).
- **`turn-driver.ts`**: the seam where a runner would plug in. The spike has none, on purpose: the stand-ins are a turn that is silent for N minutes, a runner pool with nothing free, and a turn that ends at once.
- **`fake-linear/`**: Linear's rules written as code, with payloads typed by the SDK's own `AgentSessionEventWebhookPayload`. It derives a session's status from its last activity, goes `stale` after 30 minutes of silence, and records anything Linear's docs forbid an agent to do after a stop.
- **`scenarios/`** and **`harness.ts`**: one scenario per bullet, the evaluators in `scenarios/evaluate.ts` shared with `real-run.ts`, so a real run is judged by the code that judged the fake one (the real run samples the first *thought*, as the fake scenarios do).
- **Node 24 type stripping**, no `tsx`. One TypeScript, `typescript` 6.0.3, the version ostra's root workspace pins; the cost is measured through the package's own `bin/tsc`, never through whichever `tsc` a package manager linked.

## How to run

```sh
pnpm install                  # from this directory only
pnpm check:inputs             # which inputs are present (names and yes/no, never values)
pnpm typecheck                # TypeScript 6.0.3
pnpm spike                    # every criterion that can run here, about 50 s
pnpm spike -- --only latency  # install | latency | stop-follow-up | keep-alive | sdk-strict | hardening
pnpm spike -- --only keep-alive --real-time   # the 35-minute silent turn in real time, against the fake (takes 36 minutes)
pnpm measure:tsc [runs]       # what the SDK adds to tsc, lib checking off and on
pnpm spike:real               # the real-Linear run (interactive, see below)
SPIKE_REHEARSAL=1 pnpm spike:real   # the same script against the fake, a script playing the person
```

The root ESLint config ignores `spikes/**`, so lint is run by pointing it at the spike: from the repo root, `node_modules/.bin/eslint --no-ignore spikes/linear-agent-mode/src spikes/linear-agent-mode/measure` (needs the root `pnpm install`). Today: 0 errors, 0 warnings under typescript-eslint `strict-type-checked` and the repo's rules.

`pnpm spike` leaves nothing running: every server, timer and child process is closed, and a watchdog reports and exits if a handle is left open.

### Inputs

Read from the environment only (load `~/.config/ostra-dev/*.env` into the shell first, `docs/development.md`). No model is called, so `OSTRA_DEV_MODEL_*` is not used.

| Input | From | Needed for |
|---|---|---|
| `OSTRA_DEV_PUBLIC_URL` | `tunnel.env`: a public https address forwarding to `SPIKE_PORT` (default 8787) | bullets 1 to 4, real |
| `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET` | `linear.env`: shown by Linear after Create on the manifest link | bullets 1 to 4, real |
| `LINEAR_API_KEY` (optional) | `linear.env`: a test-workspace admin's personal key. `linear.env` exists on this machine; whether it holds the key is unchecked | creating, delegating and afterwards archiving the 50 tickets, and checking the app user differs from the admin |
| `LINEAR_TEST_TEAM_KEY` (optional) | `linear.env`: the test team's key, such as `OST` | choosing the team the 50 issues go in (the first team's key is printed if unset) |

Overrides for the fake, never needed against Linear: `LINEAR_API_URL`, `LINEAR_OAUTH_AUTHORIZE_URL`, `LINEAR_OAUTH_TOKEN_URL`. Knobs: `SPIKE_PORT`, `SPIKE_DELEGATIONS` (50), `SPIKE_TIME_SCALE` (rehearsal and the fake keep-alive only), `SPIKE_REHEARSAL_SKEW_MS` (rehearsal only: makes the fake's clock run ahead, to see the run call itself inconclusive).

**For `docs/development.md`** (outside this spike's directory, so not edited here): the file lists only `LINEAR_API_KEY` under `linear.env` and nothing for the Create step. The lines it needs:

```
├── linear.env       LINEAR_API_KEY for the test Linear workspace; after the Create click on spike 5's manifest link,
│                    also LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET and LINEAR_WEBHOOK_SECRET; optionally LINEAR_TEST_TEAM_KEY
...
└── tunnel.env       OSTRA_DEV_PUBLIC_URL, the public https address that forwards to the dev server (any tunnel or reverse proxy)
```

### The real run, step by step

1. `OSTRA_DEV_PUBLIC_URL=… pnpm spike:real` prints the manifest link. An admin of the test workspace opens it and clicks **Create**, then copies the client ID, client secret and webhook secret into `linear.env`.
2. Load the file, run `pnpm spike:real` again. It starts the server, checks the public address reaches it, and prints the install link. The admin clicks **Authorize** (the server refuses a token that is not the app's own user).
3. It creates and delegates 50 tickets (with `LINEAR_API_KEY`) or asks a person to. Before creating anything it **checks that the key's workspace is the one the app is installed in** and aborts if not. It judges the webhook and first-thought times with the same evaluators as `pnpm spike`, joining each webhook's ack and transit to its session by ID, plus Linear's own view of each session's status. If this machine's clock is behind Linear's by more than the transit (a negative transit), the run says **INCONCLUSIVE** and exits 2 instead of clamping the skew away.
4. It asks a person to post a follow-up on one session and press **Send stop request** on another, and checks both arrived, that the follow-up reached the session's turn, and that the stop stopped it.
5. It watches the last session for 35 minutes, polling its status once a minute (every 10 s from minute 28, so a short stale episode is seen), and judges whether it ever went `stale`.
6. Afterwards it **archives the issues it created**. Up to 49 agent sessions stay in the test workspace (the spike posts no final activity to them on shutdown).

The script has run only as a rehearsal against the fake. Its Linear-facing glue (`issueCreate` with `delegateId`, the workspace check, the archive, the tunnel self-check) has never run.

## What the fake assumes

Everything the fake passes, it passes under these assumptions. They come from Linear's docs and the SDK's types, and **only a real run can confirm them**:

- A webhook is answered when a 2xx comes back inside 5 s, and a retry is stamped afresh (or the SDK's 60 s freshness check would refuse it).
- After `created`, an activity **or an external-link update** counts as the first response for Linear's "unresponsive" rule; the 10 s is measured from Linear sending the webhook. The pass bar's "first activity" is judged on the **posted thought** only (in the fake scenarios and in the real run alike), so a rejected thought with an accepted link does not pass.
- A session goes `stale` after 30 minutes with no activity, only while `active` or `pending`. **An ephemeral thought counts as activity.** This is the fake's own rule, so the keep-alive fake checks cannot fail on it. If it does not hold, the heartbeat's kind switches to a plain thought (`heartbeat.kind` in the config).
- A stop arrives as a `prompted` webhook whose activity carries `signal: "stop"`; a final `response` or `error` is expected, and nothing else.
- A repeated client-made activity `id` is answered as the original, not an error.
- `agentSession(id) { status }` can be read with the app's own token.
- API delegation by a personal key (`issueCreate` with `delegateId`) starts a session and sends `created`.
- The webhook-host rule in `checkPublicUrl` is a subset of Linear's (https, not loopback or private network, per the manifest docs).
- Linear's server enforces the manifest schema as published (the snapshot is a copy read on 2026-11-18).

## What building it turned up

For `context/research/` once a real run backs it:

- **The SDK's typed webhook union does not discriminate.** One member (`EntityWebhookPayloadWithUnknownEntityData`) has `type: string`, so `payload.type === "AgentSessionEvent"` does not narrow. Zod at the boundary is needed anyway (AGENTS.md), and this is one more reason. The top-level `createdAt` is typed `Date` though the wire has a string.
- **`LinearWebhookClient.verify`** checks the HMAC, then the body's `webhookTimestamp` within 60 s of `Date.now()`. It keeps no memory of what it has seen, throws plain `Error`s (told apart here by message text, which is brittle), and says to skip signatures already seen. ostra's inbox dedupes on both the delivery ID and the signature.
- **A retry that abandons the first request double-posts.** A first attempt with a client-side timeout may still land. The service therefore hedges (a second attempt beside the first, first answer wins) and gives every attempt of one activity the same `id` (an `AgentActivityCreateInput` field). The "very slow Linear" case (5 s per call) is the test. Linear's behaviour on a repeated id is the one unverified part.
- **`createAgentActivity` returns a payload whose `agentActivity` is a lazy fetch** (a second request). `agentActivityId` is what to read. The wrapper parses it as a UUID (`ActivityId`); if real Linear returns anything else, the real run will show it as a failed post.
- **Heartbeat budget.** One request per 20 minutes per silent session is 3 an hour, so about 1,600 silent sessions per workspace against the 5,000 an hour a Linear app user gets (`research/trackers.md` 1.4). Derived from the research figure, not measured.
- **The inbox is part of the 5 s.** With the durable insert modelled as a fixed delay, the ack holds up to about 4.5 s of insert and breaks by 5.2 s, because the server's own work is a few milliseconds. In ostra the insert, the proxy and TLS all sit inside that.
- **`@types/node` 26 moved a DOM-shaped type.** `node:crypto` no longer exports `JsonWebKey`; it is `webcrypto.JsonWebKey` now. The shim follows that.
- **The spike's own runs caught bugs in the spike** before any of this was written up: a follow-up that reopened a finished session lost its text, `receivedAt` mixed two clocks, a timed-out request was abandoned instead of hedged, and (found in review) the real run could have counted an accepted link as the first activity when the thought failed, and paired ack and transit samples by array position.

## Dependencies (exact versions)

| Package | Version | License | For |
|---|---|---|---|
| `@linear/sdk` | 102.0.0 | MIT | The API client and the webhook verifier. In the list in `context/history/answers-2026-11-18.md` 4.6. 103.0.0 came out the morning of the run (2026-11-18); 102.0.0 is the version `research/integrations-platform.md` read |
| `zod` | 4.6.7 | MIT | Validation at every boundary (ADR 0007) |
| `typescript` | 6.0.3 | Apache-2.0 | Typecheck, and the cost measurement. The same version as ostra's root workspace |
| `@types/node` | 26.6.6 | MIT | Node's types. The same version as ostra's root workspace (so "strict under ostra's flags" is checked against ostra's typings). **Not on the list in 4.6**: essential for strict typing of every Node API, MIT, and already a root dev dependency |
| `@graphql-typed-document-node/core` 3.2.0, `graphql` 17.1.0 (peer), `undici-types` 8.9.0 | | MIT | Transitive: the SDK's, and `@types/node`'s |

Removed in review: `typescript-native` (an alias of `typescript@7.0.2`, with its native binary `@typescript/typescript-win32-x64`), which was neither on the list nor essential.

## What's left

1. **The real runs**, in order: the install (needs a public address and the Create click), the 50 delegations, stop and follow-up, the 35 silent minutes. Each is `pnpm spike:real`. Bullets 1 to 4 are not passed until each has a real-Linear PASS.
2. **Settle the assumptions above** in the real run, above all whether an ephemeral thought keeps a session alive, whether an API delegation starts a session, and whether a repeated activity id is answered as the original.
3. **Write the finding into `context/research/`** (`integrations-platform.md` S-1 and S-10, `trackers.md` S-1 and S-3), and update F-012 and ADR 0013 if it changes anything. Not before a real-Linear PASS for each of bullets 1 to 4.
4. Not in the spike, needed by the product:
   - refresh-token rotation (Linear's access tokens last 24 h, single-flight through Postgres), the shared rate limiter, and the reconciler for missed webhooks;
   - the durable webhook inbox in Postgres (the spike's inbox is a `Map`), measured with the real insert and the real proxy in the ack path;
   - the turn's state in Postgres, so a stop that reaches another replica than the one running the turn still stops it;
   - an ostra admin session required on `/integrations/linear/install`, with the OAuth `state` bound to it by a cookie (the spike's routes are open, bounded only by the cap and the TTL).
5. If the real run fails the bar: agent mode (F-012) moves after v1, and the plain API stays.

## Files

```
package.json, pnpm-workspace.yaml (own workspace), pnpm-lock.yaml, tsconfig.base.json, tsconfig.json, .gitignore
snapshots/                             Linear's published manifest JSON schema, as read on 2026-11-18
measure/baseline, with-sdk, root-style the projects the SDK's cost and the root-style typecheck are measured on
src/manifest.ts, manifest-schema-check.ts, oauth.ts   the manifest link, the address check, the schema comparison, PKCE, the token exchange
src/server.ts, webhook-*.ts            the HTTP server, verification, schemas, the delivery inbox
src/agent-sessions.ts, session-model.ts, turn-driver.ts, retry.ts, linear-api.ts
src/fake-linear/                       the fake Linear, its rules and its payload builders
src/scenarios/                         one scenario per bullet, the hardening replays, the shared evaluators
src/harness.ts (pnpm spike), real-run.ts (pnpm spike:real), measure-sdk-tsc.ts, check-inputs.ts
src/sdk-shims.d.ts                     the four-line alias for the SDK's two DOM types (needed only with skipLibCheck off)
```
