# Research: Spike 5, `linear-agent-mode`: can the server alone meet Linear's agent deadlines from a self-hosted install?

**Status:** Research, 2026-11-18. Feeds ADR 0013 (Linear works in two modes), Q25 and ADR 0025 (the official SDK, wrapped in an adapter), ADR 0008 (strict typing), F-012 (Start from Linear), and the open rows `integrations-platform.md` S-1 and S-10.
**Method:**
- `pnpm spike` was run twice in `spikes/linear-agent-mode/` on 2026-11-18, on Windows 11 with Node 24.14.0: first by the author of this note (47.2 s, exit 0), then again when the note was checked (46.9 s, exit 0, nothing from the watchdog). Both runs gave the same verdicts and the same check counts. Every result marked "run" held in both. Timings move from run to run, so where a figure differs between the two runs this note gives the range.
- Also run when the note was checked: `node src/measure-sdk-tsc.ts 5` (what `pnpm measure:tsc` runs), `tsc --extendedDiagnostics` on the two measure projects, `tsc` on the SDK project without the shim, ESLint from the repo root (bullet 5 below), and `tsc` on the SDK project under the repo's own `tsconfig.base.json`.
- No Linear credential was loaded. All six inputs printed "missing" (RUN, `inputs:` line). The run made no request to Linear: every scenario points the server at the fake's own loopback endpoints (`SPIKE/src/scenarios/common.ts:147-149`). Everything it measured ran against the spike's own fake Linear on loopback, except bullet 5, which needs no Linear.
- I read the spike's code and README in the working tree. `git status` and `git diff HEAD` show no change under `spikes/linear-agent-mode/`, and `826122a` is the only commit that touches it, so the line numbers below are the commit's.
- Linear's developer docs were read on 2026-11-18, first through a page fetcher that summarises. Every quote below was then checked against the text of the page itself, and "not stated" means a search of that text found nothing. I read the installed `@linear/sdk` 102.0.0 declarations and source, and asked the npm registry (`npm view`).
- I fetched Linear's live manifest schema and compared it byte for byte with the spike's snapshot, on the first read and again when the note was checked: they are identical (9,303 bytes, same SHA-256).
- Anything I didn't rerun is marked "README, not rerun". Anything I couldn't confirm against a primary source is marked **unverified**. "Inferred" means I read the code or docs and didn't run it.

**Source links.**
- `SPIKE` means `spikes/linear-agent-mode`. A cite like `SPIKE/src/server.ts:195-261` is a file and its lines.
- `RUN` means the output of today's `pnpm spike`, cited by bullet and row text.
- `README` means `SPIKE/README.md`.
- `PASSBAR` means the spike's pass bar in `context/build-order.md`, lines 129-137.
- `SDK` means `SPIKE/node_modules/@linear/sdk/dist/`.
- `DOCS` pages are Linear's, under `https://linear.app/developers/`: [agents](https://linear.app/developers/agents), [agent-interaction](https://linear.app/developers/agent-interaction), [agent-best-practices](https://linear.app/developers/agent-best-practices), [agent-signals](https://linear.app/developers/agent-signals), [webhooks](https://linear.app/developers/webhooks), [sdk-webhooks](https://linear.app/developers/sdk-webhooks), [oauth-app-manifests](https://linear.app/developers/oauth-app-manifests), [oauth-actor-authorization](https://linear.app/developers/oauth-actor-authorization) and [rate-limiting](https://linear.app/developers/rate-limiting).

---

## Facts (checked 2026-11-18)

| Thing | Version | Note | Source |
|---|---|---|---|
| `@linear/sdk` | 102.0.0, exact pin | MIT. Published 2026-11-11. npm `latest` is **103.0.0**, published today at 04:05 UTC. The spike never ran on 103.0.0 | `SPIKE/package.json:18`; `npm view @linear/sdk dist-tags`, `npm view @linear/sdk@102.0.0 license` |
| `zod` | 4.6.7 | validation at every boundary | `SPIKE/package.json:19` |
| TypeScript | 6.0.3 | the same as the repo root's | `SPIKE/package.json:23`; root `package.json:25` |
| `@types/node` | 26.6.6 | the same as the repo root's | `SPIKE/package.json:22`; root `package.json:20` |
| Node | 24.14.0 | runs the `.ts` files directly | RUN header; `SPIKE/package.json:7-9` |
| Platform | Windows 11 only | no Linux or macOS run | RUN header |
| Linear's manifest schema | unchanged since the spike's snapshot | byte-identical today | `SPIKE/snapshots/linear-oauth-app-manifest.schema.json`; `https://linear.app/.well-known/oauth-app-manifest.schema.json` |

---

## 1. The question, and the answer

**Question.** Can the server alone meet Linear's agent deadlines from a self-hosted install? It tests ADR 0013 and Q25, and F-012 rests on it (`SPIKE/README.md:5-9`; `PASSBAR`). The deadlines are an answer to each webhook within 5 s, a first response within 10 s, and more activity within about 30 minutes.

**Answer.** Not yet known. Nothing failed, and only one bullet passed. In today's run the pass bar reads 1 PASS (the SDK bullet), 0 FAIL and 4 SKIPPED, plus 25 of 25 checks of the webhook edges, which are not a bullet (RUN, "Pass bar"). Bullets 1 to 4 need real Linear. Against a fake Linear that encodes our reading of the docs, the server's side held. With no runner and no injected delay, every webhook was answered in at most 55 ms and every first thought landed in at most 91 ms (the worst of the two runs). With the fake answering 5 s a call, the first thought still landed in 5.02 s. Stop and follow-up arrived. A 35-minute silent turn never went stale with a heartbeat every 20 minutes, and the same turn went stale without one. A fake can't confirm Linear's rules, so the harness refuses to count those as the bullets (`SPIKE/src/harness.ts:102`). The bar is not failed, so the fallback (F-012 moves after v1) isn't triggered. It is not passed either, so F-012 isn't de-risked. The SDK bullet is a real PASS: it typechecks under all eight strict flags and adds about 0.8 s to `tsc` with lib checking on (the harshest setting), against a budget of 20 s. With `skipLibCheck` off and no DOM lib it needs a four-line shim to do so (bullet 5). The risk is less the server's speed than three things the fake can't settle: whether Linear counts an ephemeral thought as activity, how the app's three secrets get back to ostra after the admin clicks Create, and how much of the 5 s the durable insert and the proxy will use.

---

## 2. Results per pass-bar criterion

| # | Pass-bar bullet | Result | Against the fake | Against real Linear |
|---|---|---|---|---|
| 1 | Installs from a manifest link, as its own workspace user | **SKIPPED** | 34 of 34 checks pass | not run: needs a public address, an admin's Create and Authorize |
| 2 | 50 delegations: ack under 5 s, first activity under 10 s, no runner | **SKIPPED** | 65 of 65 checks pass | not run: same inputs, plus 50 delegations |
| 3 | Stop and follow-up arrive | **SKIPPED** | 21 of 21 checks pass | not run: same inputs, plus a person |
| 4 | A silent turn of 35 minutes stays alive | **SKIPPED** | 17 of 17 checks pass, on a clock 300x faster than the wall clock | not run: same inputs, plus 35 minutes |
| 5 | `@linear/sdk` typechecks strictly, adds under 20 s to `tsc` | **PASS** | no fake involved | not needed |
| H | Webhook edges (not a bullet) | PASS | 25 of 25 checks pass | n/a |

Source for every row: RUN, "Pass bar". The harness's rule is that a bullet that needs real Linear is SKIPPED when its fake checks pass, and FAIL when one fails (`SPIKE/src/harness.ts:102`). Bullet 5 is the only one with no real-Linear tier (`SPIKE/src/criteria.ts:112-119`).

**1. The app installs from a manifest link, as its own workspace user: SKIPPED.**
- RUN: 34 fake checks pass. The generated manifest validates in both link forms, the JSON `?manifest=` form and the dot-notation form, and the two describe the same app. The webhook and callback URLs are this deployment's, over https. The app is private and uses the authorization-code grant only (`SPIKE/src/manifest.ts:243-279`).
- RUN: the Zod copy of Linear's schema agrees with the published schema on 25 facts (required fields, enums, constants, closed objects, limits). A control shows the comparison notices an enum value missing from the snapshot (`SPIKE/src/manifest-schema-check.ts:49-61`). The snapshot it compares with is byte-identical to the live schema today.
- That shows the copy matches the document. It doesn't show Linear's server enforces it. The fake's "Create" refuses or accepts with the same Zod copy, so those two checks are circular, and the harness says so in the check names (RUN, bullet 1).
- RUN: the authorize request asks for `actor=app`, PKCE S256 and exactly `read,write,app:assignable,app:mentionable` (`SPIKE/src/oauth.ts:26-37`; `SPIKE/src/manifest.ts:50`). A token that isn't an app user is refused with 409 and replaces nothing (`SPIKE/src/server.ts:320-326`). The install holds no token in its summary: an allow-list of five fields (`SPIKE/src/server.ts:421-431`).
- The "own workspace user" check reads `viewer { app }` (`SPIKE/src/linear-api.ts:51`). The field exists: "Whether this account represents an installed application rather than a person" (`SDK/index-BPbyHLYG.d.mts:21178-21179`). The docs say an `actor=app` token's actions "will come from the app itself" ([DOCS/oauth-actor-authorization](https://linear.app/developers/oauth-actor-authorization)). They don't say how to check it. That `viewer.app` is true for such a token is **inferred**.
- The agent scopes match the docs: `app:assignable` lets the app be a delegate, `app:mentionable` lets it be mentioned, and admin permission is needed for the workspace install ([DOCS/agents](https://linear.app/developers/agents)).
- Still to show on real Linear: that it accepts the link, what the Create click returns, and that Authorize by an admin yields the app's own user. See Surprise 5.

**2. 50 delegations, ack under 5 s, first activity under 10 s, no runner: SKIPPED.**
- RUN: 65 fake checks pass. In every variant, each webhook was delivered once on the first try, no session showed Linear's "unresponsive" state, and the first thought was posted before the driver was asked for anything (`SPIKE/src/agent-sessions.ts:292-339`).
- Times from RUN, over 50 delegations unless the row says otherwise, as the range between the two runs. "Ack" is the round trip as the sender saw it, and "first thought" is the posted thought, measured from the webhook being sent.

| Variant | Ack, max | First thought, max |
|---|---|---|
| paced, 40 ms apart | 3.6 to 4.0 ms | 4.5 to 5.0 ms |
| burst, all at once | 51.5 to 54.5 ms | 73.2 to 78.3 ms |
| no runner (the driver says "unavailable") | 46.2 to 50.9 ms | 82.9 to 90.6 ms |
| slow Linear (600 ms a call, first attempt fails) | 40.1 to 43.2 ms | 1.36 to 1.37 s |
| very slow Linear (5 s a call, 10 delegations) | 13.0 to 13.9 ms | 5.02 s |
| durable insert modelled as 250 ms | 312.8 to 326.5 ms | 335.1 to 339.7 ms |
| durable insert modelled as 4 s (10 delegations) | 4.01 s | 4.01 s |

- RUN: the server's own part of the ack (request in to 200 flushed) was 0.3 to 2.9 ms across the two runs. The harness's note gives about 6 to 7 ms for the probe runs.
- RUN: the inbox probe. With a 4.50 s insert, every webhook was still answered inside 5 s (slowest 4.51 s). With a 5.20 s insert, Linear's 5 s ran out and the webhook counted as undelivered (`SPIKE/src/scenarios/latency.ts:167-195`).
- The first-activity check counts a posted *thought* only. A session whose thought is refused but whose external link lands passes Linear's "unresponsive" rule and still fails the bar here (RUN, "thought refused" rows; `SPIKE/src/scenarios/evaluate.ts:39-48`). That is stricter than Linear: [DOCS/agent-interaction](https://linear.app/developers/agent-interaction) says an agent is "expected to send an activity or update your external URL within 10 seconds".
- "No runner" means a stand-in driver, not the absence of a design: a silent turn, a pool with nothing free, and a turn that ends at once (`SPIKE/src/turn-driver.ts:48-119`). With no runner, each session got a first thought and then an error, and none was left hanging (RUN, "no runner" rows).
- RUN: in each variant of the table (not the "thought refused" and inbox probe runs), every ticket (50, or 10 in two variants) had shell syntax and marker strings in its title and description. None of the markers appeared in any log line or in the body of any activity posted to Linear (`SPIKE/src/scenarios/latency.ts:11-14,102-108`). That checks the `AGENTS.md` rule that logs never carry content. The spike runs no shell with ticket text, so the check says nothing more about shell interpolation.
- Why this is still SKIPPED: the 200 in these runs follows an in-memory `Map` on loopback, with no TLS proxy, no tunnel and no Postgres (`SPIKE/src/webhook-verify.ts:66-89`; `SPIKE/src/server.ts:221-224`). The two "inbox" variants stand in a fixed delay for those. Even the real run adds only the one-way transit from Linear's timestamp and never measures the 200's return leg (`SPIKE/src/server.ts:75-80`).

**3. Stop and follow-up arrive: SKIPPED.**
- RUN: 21 fake checks pass. A follow-up reached the running turn word for word and was answered with a thought 6.7 to 7.9 ms later, and the turn kept running. A stop ended in a final `response` 6.5 to 7.8 ms after it was sent, the turn was stopped once, the heartbeat stopped with it, and the fake saw nothing posted after the final response.
- RUN: a follow-up on a stopped session reopened it and started a second turn from the follow-up's text. A stop sent right after the delegation still ended the session with a final response, even though one activity was in flight (a race a script wins, as the harness says).
- Linear's rule for a stop is that the agent halts, takes no further action, and emits a final `response` or `error` ([DOCS/agent-signals](https://linear.app/developers/agent-signals)). The spike follows it (`SPIKE/src/agent-sessions.ts:341-348`). The fake records any other activity after a stop as a violation (`SPIKE/src/fake-linear/fake-linear.ts:269-279`).
- The stop's shape is the spike's assumption. The docs say the stop signal is set on a `prompt`-type activity "generated when a user requests the agent to stop from within Linear" ([DOCS/agent-signals](https://linear.app/developers/agent-signals)), and say a `prompted` event is "a user sent a new message into an existing Agent Session" ([DOCS/agent-interaction](https://linear.app/developers/agent-interaction)). The SDK types a `signal` field on the webhook's `agentActivity` (`SDK/index-BPbyHLYG.d.mts:357,484`). That the stop arrives as `prompted` with `signal: "stop"` is the fake's guess (`SPIKE/src/webhook-schema.ts:48-61,122`), and the RUN note says so.
- Not covered: a stop that reaches a different replica than the one running the turn. Session state is a per-process `Map` (`SPIKE/src/agent-sessions.ts:116`). A `prompted` event for a session the process never saw is treated as an ended session, so it gets its final response and can't stop anything (`SPIKE/src/agent-sessions.ts:412-418`; RUN note).

**4. A silent turn of 35 minutes stays alive: SKIPPED.**
- RUN: 17 fake checks pass, on a clock 300x faster than the wall clock (7.0 s real for a 35.2-minute turn). Timers, backoff and the fake's staleness rule follow that clock, and HTTP stays real (`SPIKE/src/scenarios/keep-alive.ts:113-126`).
- RUN, three sessions: 0 stale episodes, longest silence 20.0 minutes, one heartbeat each, and the session ended `complete`, also read back through the API.
- RUN, control with no heartbeat: the same turn does go stale (1 episode, 35.0 minutes of silence). So the other passes aren't vacuous (`SPIKE/src/scenarios/keep-alive.ts:86-93`).
- RUN, faulty heartbeat: the heartbeat got through a server error and a rate limit (5 activity calls for one first thought, one heartbeat and one response).
- Why this is still SKIPPED: the fake defines Linear's staleness rule and its `touch()` resets the clock on any thought, ephemeral or not (`SPIKE/src/fake-linear/rules.ts:14-18,51-59`; `SPIKE/src/fake-linear/fake-linear.ts:281-283`). So "never stale" shows that ostra's timer posts, not that Linear counts what it posts. The RUN note says the same. See Surprise 2.
- No 35-minute run in real time is recorded for this version. `pnpm spike -- --only keep-alive --real-time` would run it against the fake, and I didn't run it. It would still test only the fake.

**5. `@linear/sdk` typechecks under ostra's strict flags and adds under 20 s to `tsc`: PASS.**
- RUN, strict: the spike typechecks with TypeScript 6.0.3 in 2.06 to 2.08 s over 460 files, with `skipLibCheck` **off**, so `tsc` reads the SDK's own declarations. The config has all eight flags of `AGENTS.md` (`SPIKE/tsconfig.base.json:8-15`), plus `noUnusedLocals`, `noUnusedParameters` and `erasableSyntaxOnly`.
- RUN, root-style: the SDK's usage typechecks with `skipLibCheck` on, no DOM lib and no shim file in 656.3 to 697.9 ms over 427 files, with no errors (`SPIKE/measure/root-style/tsconfig.json:1-5`). That project extends the spike's own `tsconfig.base.json`, not the repo's, and the two differ: the spike's uses `module`/`moduleResolution` `nodenext` and `types: ["node"]`, plus `erasableSyntaxOnly`, `isolatedModules` and `noUnused*`, where the root's has `ESNext`, `Bundler` and none of those (`SPIKE/tsconfig.base.json:3-22`; root `tsconfig.base.json:4-20`). So I also ran `tsc` on the same usage file (`measure/with-sdk/index.ts`) under the repo's real `tsconfig.base.json`, from a scratch config outside the repo that extends it and adds only `types: ["node"]` and a `typeRoots` pointing at the spike's `node_modules`. It reports no errors over 427 files in 0.66 s, with `moduleResolution` `bundler`, `module` `esnext` and `skipLibCheck` on. So ostra's own config needs no shim.
- RUN, cost: the SDK adds **about 0.8 s** with `skipLibCheck` off, against 20 s. The two `pnpm spike` runs gave 805.8 ms (1.11 s without the SDK, 1.91 s with it) and 778.3 ms (1.09 s and 1.87 s), and `pnpm measure:tsc` with 5 runs gave 772.0 ms (1.11 s and 1.88 s). It is the difference of two projects that differ only by the SDK (`SPIKE/measure/baseline/index.ts`, `SPIKE/measure/with-sdk/index.ts`), as the median wall time of the whole process after a warm-up (3 runs in `pnpm spike`, `SPIKE/src/harness.ts:32`; `SPIKE/src/tsc-measure.ts:101-165`). The 20 s is a working value (`PASSBAR`, line 136).
- RUN, start-up: a cold `import` costs 33.9 to 35.9 ms for `@linear/sdk`, 7.3 to 8.1 ms for `@linear/sdk/webhooks` and 59.7 to 62.4 ms for `zod`.
- RUN (`measure:tsc`, which also times `skipLibCheck` on; `pnpm spike` times "off" only, `SPIKE/src/harness.ts:89`): with `skipLibCheck` on, the SDK adds 247.6 ms (401.5 ms to 649.2 ms). The README says 0.26 s (`SPIKE/README.md:46-51`). The SDK brings 133 files (295 to 428) and 116,337 lines of declarations (64,494 to 180,831, from `tsc --extendedDiagnostics`). With lib checking on, `tsc` memory goes from 259 to 456 MB, about 200 MB more, and with `skipLibCheck` on from 88 to 218 MB.
- The DOM shim: the SDK's declarations name `JsonWebKey` and `CryptoKeyPair` (`SDK/dpop-D3rojqN8.d.mts:13,80`). I ran `tsc` on the SDK project with the spike's flags, `skipLibCheck` off, no DOM lib and no shim file: it reports exactly two errors, TS2304 `Cannot find name 'JsonWebKey'` and TS2552 `Cannot find name 'CryptoKeyPair'`, both in the SDK's own `.d.mts`. A four-line alias fixes it (`SPIKE/src/sdk-shims.d.ts:1-11`). It's needed only if ostra turns `skipLibCheck` off. This is why bullet 5's "typechecks" with lib checking on holds only with the shim.
- Scope: this is `tsc` on a small project. It isn't ostra's whole repo, and it isn't the editor's language server. TypeScript 7 wasn't measured (`SPIKE/README.md:56-57`). Lint is not part of the bullet. I ran it anyway, as the README says to: from the repo root, `node_modules/.bin/eslint --no-ignore spikes/linear-agent-mode/src spikes/linear-agent-mode/measure`. It linted 36 files and reported 0 errors and 0 warnings, under the root `eslint.config.js`, which loads typescript-eslint's `strictTypeChecked` and `stylisticTypeChecked` (`eslint.config.js:69`; `SPIKE/README.md:99`).

**Beyond the bar: webhook edges [H]: PASS (25 of 25).** RUN: a correctly signed `created` is accepted. An identical replay is acknowledged but not processed. The same body under a new delivery ID is caught by its signature. A body changed after signing, a wrong secret, no signature, a signature older than a minute and one stamped in the future are all refused with 400. A 2 MiB body is refused with 413 before it is parsed. A later-added field is tolerated, and no secret reached a log line.

---

## 3. What surprised us, and the gotchas

**Surprises**

1. **The 30-minute rule is stated in one place, and as a note.**
   - The 5 s is on the webhooks page: a reply that "takes longer than 5 seconds (5000ms)" counts as failed ([DOCS/webhooks](https://linear.app/developers/webhooks)). The agent-interaction page repeats it.
   - The 10 s is on the agents, agent-interaction and best-practices pages.
   - The 30 minutes appears once, in a note on the best-practices page: "Follow-up activities after the first response can still be sent for up to 30 minutes before the session is considered stale", and "this stale state is recoverable by sending another agent activity" ([DOCS/agent-best-practices](https://linear.app/developers/agent-best-practices)). The agent-interaction page lists `stale` as a state and gives no threshold. It says Linear tracks the lifecycle "based on the last emitted activity".
   - ADR 0013 words it as "post again at least every 30 minutes" (`context/decisions/0013-tracker-adapters-and-linear-modes.md:14`). The reading "30 minutes since the last activity" is the spike's and `trackers.md`'s, and the fake encodes it (`SPIKE/src/fake-linear/rules.ts:14-18,51-59`). The docs don't state that the clock restarts on each activity. **Unverified.**
   - Because stale is recoverable, a wrong reading is not fatal. The next activity brings the session back.

2. **The docs don't say whether an ephemeral thought is activity.**
   - The SDK says an ephemeral activity is hidden "after the next activity" (`SDK/index-BPbyHLYG.d.mts:237`). The docs page says it is replaced when the next activity arrives ([DOCS/agent-interaction](https://linear.app/developers/agent-interaction)). Neither says whether it moves the stale clock.
   - The spike's heartbeat is ephemeral by default (`SPIKE/src/agent-sessions.ts:17-22`; `SPIKE/src/scenarios/common.ts:154`). The fallback is a one-word config change to `kind: "thought"`, which is permanent and visible. `research/integrations-platform.md` S-10 asks the same question (line 429).

3. **A link counts as a first response, and the spike doesn't rely on it.**
   - The agents page says "Emit a `thought` activity within 10 seconds" ([DOCS/agents](https://linear.app/developers/agents)). The agent-interaction page says an activity or an external-URL update. The spike posts both at once, with hedged retries (the thought on one client-made activity ID), inside a 7 s budget (`SPIKE/src/agent-sessions.ts:301-328`; `SPIKE/src/scenarios/common.ts:151`), and judges only the thought.

4. **The 5 s is a Postgres and proxy question, not a CPU one.**
   - The server's own part of the ack is a few milliseconds. The insert and the proxy share just under 5 s: 4.5 s held and 5.2 s broke (RUN, inbox probe).
   - A miss isn't free. Linear retries after 1 minute, 1 hour and 6 hours, and the webhook "might be disabled" if the URL stays unresponsive ([DOCS/webhooks](https://linear.app/developers/webhooks)). So a slow insert could end with the app's webhook switched off.
   - ADR 0013 names Cloudflare Tunnel and Tailscale Funnel as ways to get a public address (`0013:10`). Each adds a hop the spike doesn't have.

5. **The manifest saves the form, not the copy-back.**
   - The real-run script has the admin copy the client ID, client secret and webhook secret from Linear into `linear.env` after Create (`SPIKE/README.md:127`). That Linear shows them after Create is the README's assumption: no Create click has been made. The manifest page says nothing about those values being shown or returned: the word "secret" does not occur on it ([DOCS/oauth-app-manifests](https://linear.app/developers/oauth-app-manifests)).
   - So F-012's setup is three steps, if Linear shows the values: Create on the link, paste three values into ostra, then Authorize. Whether it shows them, or returns them any other way, is **unverified** until the real run.

6. **The SDK's webhook types don't narrow, and one is probably wrong on the wire.**
   - `LinearWebhookPayload` includes `EntityWebhookPayloadWithUnknownEntityData`, whose `type` is a plain `string` (`SDK/index-BPbyHLYG.d.mts:70423,70514,4513`). So `payload.type === "AgentSessionEvent"` doesn't narrow.
   - The top-level `createdAt` is typed `Date` (`SDK/index-BPbyHLYG.d.mts:23,4507`). The spike's fake sends an ISO string (`SPIKE/src/fake-linear/payloads.ts:9-12`), and Linear's docs type `createdAt` as `string` in the other agent payload examples, `AppUserNotification` and `PermissionChange` ([DOCS/agent-best-practices](https://linear.app/developers/agent-best-practices)). No real `AgentSessionEvent` has been received, so for that payload it is **unverified**. The spike's schema doesn't read `createdAt` (`SPIKE/src/webhook-schema.ts:30-38`).
   - Zod at the boundary was required anyway (`AGENTS.md`). The spike's schemas tolerate unknown fields, as the rule for vendor formats says (`SPIKE/src/webhook-schema.ts:4-5`; Zod's `z.object` drops unknown keys, as at `:18-28`, and the hardening run's "fields Linear adds later are tolerated" passes).

7. **`LinearWebhookClient.verify` is thin.**
   - It checks a constant-time HMAC-SHA256, then the signed body's `webhookTimestamp` against a 60 s window, and throws plain `Error`s (`SDK/webhooks-DyX3tY_A.mjs:200-208`). It keeps no memory of what it has seen.
   - The sdk-webhooks page states neither the 60 s nor any replay protection ([DOCS/sdk-webhooks](https://linear.app/developers/sdk-webhooks)). The webhooks page only recommends a check "within a minute".
   - The spike tells failures apart by message text (`SPIKE/src/webhook-verify.ts:27-33`). A reworded message would change only the logged reason, because both answers are 400 (`SPIKE/src/server.ts:211-216`). The inbox dedupes on the delivery ID and on the signature (`SPIKE/src/server.ts:218-230`).

8. **`createAgentActivity` hands back an ID, not the activity.**
   - The wrapper reads `agentActivityId` and parses it as a UUID (`SPIKE/src/linear-api.ts:65-76`). In the SDK's source the payload's `agentActivity` getter is a second request (`new AgentActivityQuery(...).fetch(id)`) and `agentActivityId` is read from the first response (`SDK/index.mjs:71358-71364`). If real Linear returns another shape, a real post would be counted as failed.

**Gotchas**

9. **A retry may arrive with the old timestamp.** The fake stamps every retry afresh and marks that "(Assumed: unverified)" (`SPIKE/src/fake-linear/fake-linear.ts:387`). If Linear resends the original body, the SDK's 60 s check refuses the first retry, which comes a minute later. The server answers 400, and the next retry comes an hour on. The docs don't say whether retries reuse the body or the `Linear-Delivery` ID ([DOCS/webhooks](https://linear.app/developers/webhooks)). A reconciler for missed webhooks is already on the spike's not-built list (`SPIKE/README.md:181`).

10. **A repeated activity ID is the spike's idempotency, and Linear's answer to it is unknown.** Every attempt of one activity carries one client-made UUID (`SPIKE/src/agent-sessions.ts:157`; `SPIKE/src/retry.ts:16-20`). The SDK says the `id` is "The identifier in UUID v4 format. If none is provided, the backend will generate one" (`SDK/index-BPbyHLYG.d.mts:239-240`). It says nothing about a repeat. The "very slow Linear" run passed because the fake answers a repeat as the original (RUN, "10 repeats answered as the original"). **Unverified** on real Linear.

11. **The heartbeat ignores other posts, and its retry window reaches the stale edge (inferred).** The loop sleeps 20 minutes and posts, whatever else was posted (`SPIKE/src/agent-sessions.ts:183-221`). Its retries may run up to half an interval, so a heartbeat that fails for 10 minutes lands at 30 minutes of silence (`SPIKE/src/agent-sessions.ts:205-206`). In the spike nothing else posts, so this doesn't show. In ostra the runner's stream will post, and the timer should reset on any post.

12. **A shorter heartbeat costs little.** One request per 20 minutes is 3 an hour per silent session. Against 5,000 an hour for an app user ([DOCS/rate-limiting](https://linear.app/developers/rate-limiting)), that is about 1,600 silent sessions per workspace (RUN, keep-alive note). That is derived from the doc figure, not measured. 5,000 is the standard limit: the page also lists plan multipliers (Business 2x, Enterprise 5x) and says workspace-level OAuth apps using actor authorization get dynamic increases based on paid users, without saying how much, so the figure is a floor.

13. **Everything in the session service is in memory.** Sessions, the 24-hour dedupe window and the pending-install table are per-process `Map`s (`SPIKE/src/agent-sessions.ts:116`; `SPIKE/src/server.ts:106,156-158`). A restart, or a second replica, loses them. The README lists the Postgres versions as not built (`SPIKE/README.md:180-184`).

14. **The install routes are open.** The spike bounds what they hold (100 pending, 10-minute TTL, a sweep timer) but requires no ostra admin session (`SPIKE/src/server.ts:107,271-293`; RUN, "12 install starts"). The README says the product needs an admin session with the OAuth `state` bound to it (`SPIKE/README.md:184`).

15. **The address pre-check is stricter than Linear's published rule.** Linear says the webhook host "must not be a loopback host, private-network host, or `linear.app`" and must use `https://` ([DOCS/oauth-app-manifests](https://linear.app/developers/oauth-app-manifests)). The spike also refuses a host with no dot and the suffixes `.local`, `.internal`, `.lan` and `.home.arpa` (`SPIKE/src/manifest.ts:109-135`). The app's name falls back to plain `ostra` when the host contains "linear", because the schema forbids that word in a name (`SPIKE/src/manifest.ts:144-149,219-223`).

16. **API delegation starting a session is, at best, "can".** The SDK says delegation "can start an agent session on the issue and requires permission to invoke that agent" (`SDK/index-BPbyHLYG.d.mts:7592`). The real run's automated path creates issues with `delegateId` (`SPIKE/src/real-run.ts:195-197`). If the key's user lacks permission, a person must delegate by hand.

17. **The real-run script has never run its Linear-facing parts.** The issue creation with `delegateId`, the workspace check, the archive and the tunnel self-check ran only as a rehearsal against the fake (README, not rerun: `SPIKE/README.md:134`). The script reports INCONCLUSIVE, and exits 2, if this machine's clock is behind Linear's by more than the transit (`SPIKE/src/real-run.ts:294,364-367`).

18. **The spike's own runs found bugs in the spike.** A reopened session lost its follow-up text. `receivedAt` mixed two clocks. A timed-out request was abandoned, not hedged. Review found that the real run could count a link as the first activity (README, not rerun: `SPIKE/README.md:161`). That's a reason to keep trusting the harness's refusal to count fake passes.

**Housekeeping, checked after the runs.** The harness's watchdog reports and exits if a handle is left open (`SPIKE/src/harness.ts:141-148`). It printed nothing in either run, and both exited 0. After the second run and the other checks, I listed every process whose command line named `linear-agent-mode`: none was running. The author's note on the first run also records that nothing was left running and that other sessions' processes were left alone; I can't check that part.

---

## 4. What this changes in the plan

These are recommendations for the maintainer. I changed no other file.

1. **ADR 0013: keep the decision, and wait before amending it.**
   - Nothing failed, so the fallback in `PASSBAR` ("agent mode (F-012) moves after v1; the plain API stays") isn't triggered. Nothing is confirmed either. Amend after the real run.
   - Then change the Consequences line (`0013:14`). Say the 5 s covers the TLS proxy and the durable insert, so the handler's path is verify, insert, 200 and nothing else. Say Linear retries after 1 minute, 1 hour and 6 hours and may disable a webhook that stays unresponsive. Word the 30 minutes as the docs do, and say whether the real run showed that it counts since the last activity and that an ephemeral thought counts.

2. **F-012: leave it `planned`, and don't call it de-risked.**
   - Its spec (`context/specs/`, not yet written) should carry what the spike found:
     - the fast lane runs on the server and never waits for a runner (`SPIKE/src/agent-sessions.ts:292-339`)
     - the turn's state lives in Postgres, so a stop reaches a turn on another replica (Gotcha 13)
     - the heartbeat resets on any post (Gotcha 11)
     - the setup is Create, paste three values, Authorize (Surprise 5)
     - the install route needs an admin session (Gotcha 14)
   - Add to F-012's "done when" that spike 5's four real-Linear bullets passed. The ledger row today names none (`context/features.md:73`).

3. **Q25, ADR 0025, ADR 0008: the SDK stays, wrapped in the adapter.**
   - Bullet 5 passes with a margin of about 25 times (0.8 s against 20 s), and the root config needs no shim (bullet 5 above).
   - Keep the hot path on ostra's own GraphQL documents, as the spike does for the viewer and session status (`SPIKE/src/linear-api.ts:51-60,86-96`), and the SDK for mutations and for webhook verification.
   - Pin the SDK exactly. 103.0.0 is a week newer than the 102.0.0 the spike ran on. Rerun `pnpm spike -- --only sdk-strict` before bumping.
   - Add one line to ADR 0008, or a comment in the root `tsconfig.base.json`, that turning `skipLibCheck` off needs the four-line shim or the `dom` lib in server packages.

4. **Research rows: close one, keep one, correct one.**
   - `integrations-platform.md` S-1 (line 420: does the SDK typecheck cleanly under ostra's flags with `skipLibCheck: false`, and what does it cost `tsc` and the editor): answered for `tsc`, not for the editor. With `skipLibCheck: false` and no DOM lib the answer is "not cleanly": two errors in the SDK's own declarations, fixed by a four-line shim, and then it adds about 0.8 s. Under the repo's real `skipLibCheck: true` it is clean with no shim and adds about 0.25 s (bullet 5). The editor's cost was not measured. Mark it so.
   - `integrations-platform.md` S-10 (does Linear mark a silent session stale, and is there a 30-minute heartbeat): still open. Only the real 35-minute run answers it.
   - `SPIKE/README.md:179` says the finding belongs to `trackers.md` S-1 and S-3. It doesn't answer either. S-1 asks about the client-credentials grant, and the spike uses the authorization-code grant only (`SPIKE/src/manifest.ts:263`; `SPIKE/src/oauth.ts:67-75`). S-3 asks what Linear does with a dead webhook URL, and the spike never saw a real Linear. Leave both open. S-6 (activity throughput) gains only a derived number (Gotcha 12).

5. **`docs/development.md`: add the lines the README proposes** (`SPIKE/README.md:116-123`). Today `linear.env` is listed with `LINEAR_API_KEY` only, and `tunnel.env` is "whatever the chosen tunnel needs" (`docs/development.md:9,12`). The real run also needs `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET` and `LINEAR_WEBHOOK_SECRET` in `linear.env`, and `OSTRA_DEV_PUBLIC_URL` in `tunnel.env`. It also needs a tunnel to be chosen. That's the maintainer's call (`AGENTS.md`: ask before building on a vendor or paid service).

6. **Milestone 1: carry the shapes, not the code.** The spike is throwaway (`AGENTS.md`). These shapes are worth keeping:
   - the `SessionState` union (`SPIKE/src/session-model.ts:7-17`)
   - the order: verify, claim the delivery ID and the signature in one insert, answer 200, then work (`SPIKE/src/server.ts:195-261`)
   - first thought and link in parallel, with hedged retries on one activity ID (`SPIKE/src/retry.ts:36-91`)
   - the address pre-check shown on the setup screen (`SPIKE/src/manifest.ts:69-135`). Its new setting needs a working default and a line in the configuration reference (the self-hosting rule in `AGENTS.md`)

7. **Adapter parity.** The spike never touches the `TrackerAdapter` interface. It makes no claim about "agent sessions" as a declared optional capability (ADR 0013:5). The interface work stays with milestone 1, and the Jira fake joins the tracker contract suite from milestone 2 (ADR 0047:47).

---

## 5. What's still open

**SKIPPED in today's run (4 bullets).** Each needs the same base: a public https address that forwards to `SPIKE_PORT` (default 8787), put in `OSTRA_DEV_PUBLIC_URL`, and a workspace admin on the test Linear workspace (`SPIKE/src/criteria.ts:75-80`; `SPIKE/README.md:107-114,125-134`). `LINEAR_API_KEY` is optional and automates the delegations. I didn't load or read `linear.env`.

1. **Bullet 1, the install.**
   - Run `OSTRA_DEV_PUBLIC_URL=... pnpm spike:real`. It prints the manifest link. An admin opens it, clicks Create, and copies three values into `linear.env`. Run it again, and the admin clicks Authorize on the printed install link (`SPIKE/README.md:127-128`).
   - It decides whether Linear accepts the manifest and whether the token is the app's own user.

2. **Bullet 2, 50 delegations.**
   - The same script creates and delegates 50 tickets when `LINEAR_API_KEY` is set. It refuses a key from another workspace, and archives the tickets afterwards (`SPIKE/README.md:129,132`).
   - Without the key, a person delegates 50 tickets by hand. The judging code is the same as the fake runs use (`SPIKE/src/scenarios/evaluate.ts`).

3. **Bullet 3, stop and follow-up.** A person posts a follow-up on one session and presses Send stop request on another (`SPIKE/README.md:130`). It decides the stop's real shape (Bullet 3 above).

4. **Bullet 4, 35 silent minutes.** The script watches the last session for 35 wall-clock minutes, polling its status once a minute and every 10 s from minute 28 (`SPIKE/README.md:131`). It decides whether an ephemeral thought counts. If the session goes stale, switch the heartbeat's `kind` to `thought` and run again (`SPIKE/src/real-run.ts:354`). The whole real run takes about an hour (an estimate: 35 watched minutes plus the install and the 50 delegations; the README gives no total).

**Assumptions only the real run can settle** (`SPIKE/README.md:136-148`). Each is something the fake passed because the fake says so:
- an ephemeral thought counts as activity (Surprise 2)
- a stop arrives as `prompted` with `signal: "stop"` (bullet 3)
- a repeated activity ID is answered as the original (Gotcha 10)
- API delegation by a personal key starts a session (Gotcha 16)
- a retry is stamped afresh (Gotcha 9)
- `agentSession(id) { status }` can be read with the app's own token
- Linear's server enforces the manifest schema as published

**Not covered, though no bullet names it:**
- **The durable inbox and the proxy in the ack path.** The ack was measured against a `Map` (Surprise 4). It needs the real Postgres insert and the real tunnel or proxy, in milestone 1.
- **A stop on another replica.** Needs the turn's state in Postgres (`SPIKE/README.md:183`; RUN note).
- **Refresh-token rotation, the shared rate limiter and the reconciler for missed webhooks** (`SPIKE/README.md:181`). Linear's access tokens last 24 hours, with a rotating 30-day refresh token (`research/trackers.md:69`, the `actor=app` row).
- **Linux and macOS.** Only Windows 11 ran. The process-tree kill has a non-Windows branch that hasn't run (`SPIKE/src/tsc-measure.ts:40-52`).
- **`@linear/sdk` 103.0.0.** Published this morning, not tested.
- **The editor's language server, TypeScript 7 and ostra's whole repo**, for the cost of the SDK (bullet 5).
- **Real-time keep-alive against the fake.** No run of this version is saved. It would add nothing about Linear.

**Decisions the spike can't make:**
- which tunnel the development setup uses (`docs/development.md:12`)
- when the maintainer or an admin can spend about an hour on the real run
- whether the heartbeat should be shorter than 20 minutes (Gotchas 11 and 12). That waits for the real run.
