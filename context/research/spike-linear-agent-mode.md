# Research: Spike 5, `linear-agent-mode`: can the server alone meet Linear's agent deadlines from a self-hosted install?

**Status:** Research, 2026-11-18, updated the same day after the first run against real Linear. Feeds ADR 0013 (Linear works in two modes), Q25 and ADR 0025 (the official SDK, wrapped in an adapter), ADR 0008 (strict typing), F-012 (Start from Linear), and the open rows `integrations-platform.md` S-1 and S-10.
**Method:**
- **First version of this note (fake Linear only).** `pnpm spike` was run twice in `spikes/linear-agent-mode/` on 2026-11-18, on Windows 11 with Node 24.14.0: first by the author of that version (47.2 s, exit 0), then again when it was checked (46.9 s, exit 0, nothing from the watchdog). Both runs gave the same verdicts and check counts, and where a timing differs between them this note gives the range. Also run then: `node src/measure-sdk-tsc.ts 5`, `tsc --extendedDiagnostics` on the two measure projects, `tsc` on the SDK project without the shim, ESLint from the repo root, and `tsc` on the SDK project under the repo's own `tsconfig.base.json`. No Linear credential was loaded and every scenario pointed the server at the fake's loopback endpoints (`SPIKE/src/scenarios/common.ts:152`). Everything marked "RUN" below comes from those runs.
- **The real run.** Later the same day `pnpm spike:real` ran against the Linear workspace `ostra-test` (team OST), through a Cloudflare quick tunnel, on Windows 11, Node 24.14.0 and pnpm 11.28.2 (`README:22`). I did not see its log: the log is not kept in the repo (`README:22`), and this update takes its figures and the lines it quotes from the run's console output as they were handed to me. Everything marked "REAL" is as reported, not rechecked. Two things were done after the run, by hand and while the server still ran: the follow-up and the stop (bullet 3).
- **This update.** I re-read the spike's working tree: the README, `real-run.ts`, `thread-reply.ts`, `token-store.ts`, `server.ts`, `linear-api.ts`, `scenarios/stop-follow-up.ts`, `scenarios/common.ts`, `scenarios/evaluate.ts`, and the parts of `fake-linear/fake-linear.ts` and `agent-sessions.ts` cited below. I ran nothing: not `pnpm spike`, `pnpm measure:tsc`, `tsc` or ESLint, and no `git`. So the fake-Linear check counts for bullets 1 and 3 are the README's (marked "README, not rerun"), and the timings and bullet 5 figures are those of the first version's runs. The session's `git status` at the start listed these files as changed since the first version, so every line cite into them was re-read: `README.md`, `criteria.ts`, `fake-linear/fake-linear.ts`, `linear-api.ts`, `real-run.ts`, `scenarios/common.ts`, `scenarios/install.ts`, `scenarios/stop-follow-up.ts`, `server.ts`, plus the new `thread-reply.ts` and `token-store.ts`. Cites into the other spike files are carried from the first version, whose files are the same as now.
- I re-read Linear's `agent-signals` and `agent-interaction` pages during this update, through a page fetcher that summarises, and did not check the summaries against the page text. The rest of the docs quotes were checked against the page text in the first version, and "not stated" means a search of that text found nothing. The first version also read the installed `@linear/sdk` 102.0.0 declarations and source, asked the npm registry, and fetched Linear's live manifest schema (byte-identical to the spike's snapshot, 9,303 bytes). None of that was repeated.
- Anything I didn't rerun is marked "README, not rerun". Anything I couldn't confirm against a primary source is marked **unverified**. "Inferred" means I read the code or docs and didn't run it.

**Source links.**
- `SPIKE` means `spikes/linear-agent-mode`. A cite like `SPIKE/src/server.ts:220-286` is a file and its lines.
- `RUN` means the output of the first version's `pnpm spike` runs (the fake Linear), cited by bullet and row text.
- `REAL` means the console output of `pnpm spike:real` on 2026-11-18 against real Linear, cited by bullet number ([1] to [4]). Where this note puts a line in quotes, the line is the run's own, as handed to me.
- `README` means `SPIKE/README.md`.
- `PASSBAR` means the spike's pass bar in `context/build-order.md`, lines 129-137.
- `SDK` means `SPIKE/node_modules/@linear/sdk/dist/`.
- `DOCS` pages are Linear's, under `https://linear.app/developers/`: [agents](https://linear.app/developers/agents), [agent-interaction](https://linear.app/developers/agent-interaction), [agent-best-practices](https://linear.app/developers/agent-best-practices), [agent-signals](https://linear.app/developers/agent-signals), [webhooks](https://linear.app/developers/webhooks), [sdk-webhooks](https://linear.app/developers/sdk-webhooks), [oauth-app-manifests](https://linear.app/developers/oauth-app-manifests), [oauth-actor-authorization](https://linear.app/developers/oauth-actor-authorization) and [rate-limiting](https://linear.app/developers/rate-limiting).

---

## Facts (checked 2026-11-18)

| Thing | Version | Note | Source |
|---|---|---|---|
| `@linear/sdk` | 102.0.0, exact pin | MIT. The real run used it too. The first version found npm `latest` was **103.0.0**, published 2026-11-18 at 04:05 UTC (not rechecked). The spike never ran on 103.0.0 | `SPIKE/package.json:18`; `README:191` |
| `zod` | 4.6.7 | validation at every boundary | `SPIKE/package.json:19` |
| TypeScript | 6.0.3 | the same as the repo root's | `SPIKE/package.json:23`; root `package.json:25` |
| `@types/node` | 26.6.6 | the same as the repo root's | `SPIKE/package.json:22`; root `package.json:20` |
| Node | 24.14.0 | runs the `.ts` files directly | RUN header; `README:22`; `SPIKE/package.json:7-9` |
| pnpm | 11.28.2 | the real run | `README:22` |
| Platform | Windows 11 only | no Linux or macOS run, fake or real | RUN header; `README:22` |
| The real test setup | Linear workspace `ostra-test`, team OST; a Cloudflare quick tunnel to this machine | one real run, 2026-11-18, with the admin's personal API key (`LINEAR_API_KEY`) set | `README:22`; REAL |
| Linear's manifest schema | unchanged since the spike's snapshot | byte-identical when the first version checked | `SPIKE/snapshots/linear-oauth-app-manifest.schema.json`; `https://linear.app/.well-known/oauth-app-manifest.schema.json` |

---

## 1. The question, and the answer

**Question.** Can the server alone meet Linear's agent deadlines from a self-hosted install? It tests ADR 0013 and Q25, and F-012 rests on it (`SPIKE/README.md:5-9`; `PASSBAR`). The deadlines are an answer to each webhook within 5 s, a first response within 10 s, and more activity within about 30 minutes.

**Answer.** Yes on everything that ran for real, with two parts of the bar still open. The bar is not passed, and it is not failed.
- **Passed on real Linear.**
  - The app installed as its own workspace user, a different user from the admin ([1]).
  - The server answered all 50 delegations and posted a first thought to each. The server's own ack was p50 1.1 ms and max 5.8 ms, and the first thought p50 90 ms and max 463 ms ([2], server-side).
  - A 35.1-minute silent turn stayed alive with one ephemeral heartbeat: 0 stale episodes, longest silence 20.0 minutes, the session ended complete ([4]).
  - `@linear/sdk` typechecks under all eight strict flags and adds about 0.8 s to `tsc` with lib checking on, against a budget of 20 s ([5], measured by the first version).
- **Open.**
  - **Bullet 3 is not passed.** The harness reported FAIL on its 6 checks, but only because its 15-minute human-wait window expired before anyone acted. Both events did reach the server afterwards: a follow-up as a thread reply, and a stop pressed in Linear's UI, each answered by an accepted `prompted` webhook. The harness did not verify that the follow-up reached the turn, that the stop stopped it, or that ostra's own state ended. So the stop's real shape (`signal: "stop"`) is still unverified.
  - **Bullet 2's end-to-end figure is INCONCLUSIVE.** This machine's clock was about 1,103 ms behind Linear's, so "our clock at receipt minus Linear's timestamp" came out negative and the true delay from Linear's send cannot be recovered. The figures above leave transit out. The tunnel's share, the 200's return leg and the durable Postgres insert were never in them either.
- **Why the bar is not failed.** Nothing observed contradicts it, so the fallback in `PASSBAR` (F-012 moves after v1; the plain API stays) isn't triggered.
- **Why it is not passed.** Bullet 3 has no verified pass and bullet 2 has no end-to-end number. The run's last line was FAIL, because the harness lets a failed check outrank "inconclusive" (`SPIKE/src/real-run.ts:399-403`). `pnpm spike` cannot know about a real run, so it still prints SKIPPED for bullets 1 to 4 (`README:22`; `SPIKE/src/harness.ts:102`).
- **What moved since the first version.** That version named three risks the fake couldn't settle.
  - Whether Linear counts an ephemeral thought as activity: consistent with yes, from one real run ([4], Surprise 6).
  - How the app's three secrets get back to ostra after the admin clicks Create: the admin did get them, by inference (Surprise 9).
  - How much of the 5 s the durable insert and the proxy will use: still unmeasured, but the server's own share is under 6 ms (Surprise 8).
- **New from the real run:** a person's stop cannot be sent with an API key. That changes the design (Surprise 1, section 4).

---

## 2. Results per pass-bar criterion

| # | Pass-bar bullet | Real Linear, 2026-11-18 | Against the fake |
|---|---|---|---|
| 1 | Installs from a manifest link, as its own workspace user | **PASS**, 3 of 3 checks | 51 of 51 checks pass (README, not rerun) |
| 2 | 50 delegations: ack under 5 s, first activity under 10 s, no runner | **PASS server-side**, 6 of 6 checks. **End to end INCONCLUSIVE** (clock skew) | 65 of 65 checks pass (RUN) |
| 3 | Stop and follow-up arrive | **FAIL in the harness**, 6 checks, because its wait window expired. Both events then **observed**, not verified | 29 of 29 checks pass (README, not rerun) |
| 4 | A silent turn of 35 minutes stays alive | **PASS**, 5 of 5 checks | 17 of 17 checks pass, on a clock 300x faster than the wall clock (RUN) |
| 5 | `@linear/sdk` typechecks strictly, adds under 20 s to `tsc` | no real-Linear tier | **PASS** (RUN) |
| H | Webhook edges (not a bullet) | n/a | 25 of 25 checks pass (README, not rerun) |

Sources: REAL [1] to [4]; the fake column is RUN where the check count did not change and `README:28-33` where it did. The README's counts for bullets 1 and 3 are higher than the first version's 34 and 21 because checks were added after the real run: the saved-token checks (`SPIKE/src/scenarios/install.ts:84-165`) and the thread-reply and personal-key checks (`SPIKE/src/scenarios/stop-follow-up.ts:50-70`). The harness's rule still is that a bullet that needs real Linear is SKIPPED when its fake checks pass, and FAIL when one fails (`SPIKE/src/harness.ts:102`). Bullet 5 is the only one with no real-Linear tier (`SPIKE/src/criteria.ts:112-119`).

**1. The app installs from a manifest link, as its own workspace user: PASS on real Linear, 3 of 3.**
- REAL [1]: "The app installed as its own user, with the scopes app:assignable, app:mentionable, read and write, and it's a different user from the admin." The three checks are the install, the agent scopes and "a different user from the admin" (`SPIKE/src/real-run.ts:273,276,282`). The scopes are those in the token response, not read back (`SPIKE/src/server.ts:352`).
- **Settled: `viewer.app` is true for an `actor=app` token.** The first version had this as inferred. The server refuses a token that is not an app user with 409 and replaces nothing (`SPIKE/src/server.ts:345-351`), and the install check passed. The docs don't say how to check it ([DOCS/oauth-actor-authorization](https://linear.app/developers/oauth-actor-authorization) says only that the token's actions "will come from the app itself"), so this is the first real evidence.
- **Inferred: Linear accepted the manifest link, and the admin got the three values.** The real run cannot start the server without `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET` and `LINEAR_WEBHOOK_SECRET` (`SPIKE/src/real-run.ts:173-183`), which the README says come from the Create click (`README:149`), and the install then passed. The facts I was given don't say how Linear shows the values or whether a step needed fixing by hand.
- What the pass does not show: that Linear *rejects* a bad manifest. A valid manifest was accepted, and the Zod copy that built it is compared with the published schema's 25 facts (RUN; `SPIKE/src/manifest-schema-check.ts:49-61`). Whether Linear's server enforces the schema as published is still the fake's word.
- Not run for real: the saved-token reuse. The run was the first, so the install was fresh. The reuse path was added afterwards and is covered against the fake only (`README:47-51,156`).
- The agent scopes match the docs: `app:assignable` lets the app be a delegate, `app:mentionable` lets it be mentioned, and admin permission is needed for the workspace install ([DOCS/agents](https://linear.app/developers/agents)).

**2. 50 delegations, ack under 5 s, first activity under 10 s, no runner: PASS server-side on real Linear, 6 of 6. End to end INCONCLUSIVE.**
- REAL [2], over 50 delegations:
  - Webhook ack, request in to 200 flushed: p50 1.1 ms, max 5.8 ms.
  - First activity, a posted thought: p50 90 ms, p95 227 ms, max 463 ms.
  - "Every session got a thought, and Linear reported them all active."
- The six checks are the three of `evaluateLatency` (all delivered and answered, every ack under 5 s, every first activity under 10 s), "every session got a thought", "Linear reports every session active, none in error or stale", and "the first thought was posted before the stand-in runner was asked" (`SPIKE/src/real-run.ts:319-340`; `SPIKE/src/scenarios/evaluate.ts:20-37`).
- The delegations were made through the API by the admin's key: `createIssue` with `delegateId` for 50 tickets, 250 ms apart (`SPIKE/src/real-run.ts:217-220`). Each started a session and sent a `created` event. This settles Gotcha 20.
- What the figures are. The ack is the time inside this server, from the request arriving to the 200 being flushed (`SPIKE/src/server.ts:220-222,275-277`). The first-thought time runs from receipt to the posted thought (`SPIKE/src/scenarios/evaluate.ts:44-48`), so unlike the fake's it includes one real round trip to Linear's API. Transit is left out because of the skew (below).
- **The end-to-end figure is INCONCLUSIVE.** REAL [2]: this machine's clock was "about 1,103 ms behind Linear". The run measures our clock at receipt minus Linear's own timestamp, which is transit plus skew. It came out negative, so the true delay cannot be recovered from it. The run says so and leaves transit out of the figures above, instead of clamping the skew away (`SPIKE/src/real-run.ts:312-318,328-330`). The README gives the fix, a Windows time resync, then run again (`README:38`).
- What the numbers leave for the parts nobody measured. Against the 5 s, the 5.8 ms max leaves about 4.99 s for the transit, the tunnel, TLS, the 200's return leg and the durable insert, none of which is in it (`README:58`). Against the 10 s, the 463 ms max leaves about 9.5 s for the transit and whatever the real inbox adds. That is arithmetic on a server-side figure, not a measured margin.
- Indirect evidence for the 10 s: Linear reported all 50 sessions active, none in error or stale (REAL [2]; `SPIKE/src/real-run.ts:335-336`). The read came after all 50 delegations were in (`SPIKE/src/real-run.ts:293-297`), so it says no session was left behind, not that any thought was inside 10 s.
- Times from RUN, over 50 delegations unless the row says otherwise, as the range between the two fake runs (not rerun since). "Ack" is the round trip as the sender saw it, and "first thought" is the posted thought, measured from the webhook being sent. The real server-side figures above sit in the same low-millisecond range as the fake's unloaded rows. The slower rows are the fake's injected delays, so only the real run's numbers describe Linear.

| Variant | Ack, max | First thought, max |
|---|---|---|
| paced, 40 ms apart | 3.6 to 4.0 ms | 4.5 to 5.0 ms |
| burst, all at once | 51.5 to 54.5 ms | 73.2 to 78.3 ms |
| no runner (the driver says "unavailable") | 46.2 to 50.9 ms | 82.9 to 90.6 ms |
| slow Linear (600 ms a call, first attempt fails) | 40.1 to 43.2 ms | 1.36 to 1.37 s |
| very slow Linear (5 s a call, 10 delegations) | 13.0 to 13.9 ms | 5.02 s |
| durable insert modelled as 250 ms | 312.8 to 326.5 ms | 335.1 to 339.7 ms |
| durable insert modelled as 4 s (10 delegations) | 4.01 s | 4.01 s |

- RUN: the inbox probe. With a 4.50 s insert, every webhook was still answered inside 5 s (slowest 4.51 s). With a 5.20 s insert, Linear's 5 s ran out and the webhook counted as undelivered (`SPIKE/src/scenarios/latency.ts:167-195`). This is the only evidence on what the insert and the proxy may cost, and it is the fake's.
- The first-activity check counts a posted *thought* only. A session whose thought is refused but whose external link lands passes Linear's "unresponsive" rule and still fails the bar here (RUN; `SPIKE/src/scenarios/evaluate.ts:39-48`). That is stricter than Linear: [DOCS/agent-interaction](https://linear.app/developers/agent-interaction) says an agent is "expected to send an activity or update your external URL within 10 seconds".
- "No runner" means a stand-in driver, not the absence of a design: a silent turn, a pool with nothing free, and a turn that ends at once (`SPIKE/src/turn-driver.ts:48-119`). The real run used the silent one (`SPIKE/src/real-run.ts:127`).
- RUN: in each variant of the table, every ticket had shell syntax and marker strings in its title and description, and none of the markers appeared in any log line or in the body of any activity posted (`SPIKE/src/scenarios/latency.ts:11-14,102-108`). That checks the `AGENTS.md` rule that logs never carry content. Not checked in the real run (its tickets had plain titles, `SPIKE/src/real-run.ts:217`).
- Why [2] is not a full PASS: the real ack was measured against an in-memory `Map` for the inbox (`SPIKE/src/server.ts:185-190`; `SPIKE/src/webhook-verify.ts:66-89`), with no Postgres, and it leaves out the tunnel's share and the 200's return leg (`README:58`).

**3. Stop and follow-up arrive: FAIL in the harness, and the reason is the harness. Both events observed, not verified.**
- REAL [3]: the harness reported FAIL on its 6 checks. It waited 15 minutes for a person to post a follow-up and press Send stop request, and the window expired before anyone acted. All six checks are about those two events, and the run reported FAIL on them: a follow-up webhook arrived, it was passed to the running turn, a stop arrived, it stopped the turn, ostra's state is ended (stopped), and Linear shows the session complete (`SPIKE/src/real-run.ts:355-361`). The window is now `SPIKE_HUMAN_WAIT_MIN`, default 30 (`SPIKE/src/real-run.ts:49-50,60,352`; `README:50`).
- Observed afterwards, while the server still ran, with the run's log lines (by hand, not by the harness):
  - The follow-up was posted at 18:59:53Z through the API, by the admin's personal key, as a reply in the session's thread: `commentCreate` with `parentId` = `agentSession.comment.id`, on OST-5. Linear delivered an `AgentSessionEvent` with action `prompted` to the server, which accepted it.
  - The stop was pressed in Linear's UI ("Send stop request") on OST-6 at 19:02:44Z. A `prompted` webhook was accepted, and Linear then showed both sessions' status as `complete`.
- **Not verified for these late events:**
  - that the follow-up reached the turn (`SPIKE/src/real-run.ts:356`)
  - that the stop stopped it (`SPIKE/src/real-run.ts:358`)
  - that ostra's own state ended (`SPIKE/src/real-run.ts:359`)
  - that the stop webhook carried `signal: "stop"`. An accepted `prompted` webhook can't show it: the server's log line names the action only (`SPIKE/src/server.ts:279-284`), and the stop is told from a follow-up by that one field (`SPIKE/src/webhook-schema.ts:122`; `SPIKE/src/agent-sessions.ts:420-426`). If the field had been missing, the stop would have been handled as a follow-up, with a thought and no halt. See Surprise 4.
- Why OST-5, which only got a follow-up, also showed `complete` is not explained by anything the harness recorded.
- **Personal API keys can't stop.** REAL [3]: `agentActivityCreate` with a personal API key is refused, for both a prompt and `signal: stop`, with "Using an unexpected authentication method (apiKey) for an operation" (403 FORBIDDEN). Surprise 1 has what follows from it.
- The fake: 29 checks pass (README, not rerun). They include the stop's shape the spike assumed, and, new since the first version, a thread reply by a personal key becoming a `prompted` event, and the 403 for a key's activity (`SPIKE/src/scenarios/stop-follow-up.ts:50-70`; `SPIKE/src/fake-linear/fake-linear.ts:454-456,541-571`). The fake's reply path and refusal copy what the real run showed. They show the code works, not that real Linear behaves so for `thread-reply.ts`: that file has never run against Linear, because the real reply was posted by hand through the API (`README:59`).
- RUN (the older fake checks): a follow-up reached the running turn word for word and was answered with a thought 6.7 to 7.9 ms later, and the turn kept running. A stop ended in a final `response` 6.5 to 7.8 ms after it was sent, the turn was stopped once, the heartbeat stopped with it, and the fake saw nothing posted after the final response. A follow-up on a stopped session reopened it and started a second turn from the follow-up's text. A stop sent right after the delegation still ended the session with a final response (a race a script wins, as the harness says).
- Linear's rule for a stop is that the agent halts, takes no further action, and emits a final `response` or `error` ([DOCS/agent-signals](https://linear.app/developers/agent-signals)). The spike follows it (`SPIKE/src/agent-sessions.ts:341-348`). The fake records any other activity after a stop as a violation (`SPIKE/src/fake-linear/fake-linear.ts:279-289`).
- What the docs say about who sends a stop, re-read for this update through a summarising fetcher: the stop signal is on an activity "generated when a user requests the agent to stop from within Linear" ([DOCS/agent-signals](https://linear.app/developers/agent-signals)), and "An agent cannot generate a `prompt` type activity" ([DOCS/agent-interaction](https://linear.app/developers/agent-interaction)). Neither page says anything about API keys. The stop signal sits on a `prompt`-type activity ([DOCS/agent-signals](https://linear.app/developers/agent-signals)), and a `prompted` event is "a user sent a new message into an existing Agent Session" ([DOCS/agent-interaction](https://linear.app/developers/agent-interaction)). That the stop arrives as `prompted` with `signal: "stop"` is still the fake's guess (`SPIKE/src/webhook-schema.ts:48-61,122`).
- Not covered: a stop that reaches a different replica than the one running the turn. Session state is a per-process `Map` (`SPIKE/src/agent-sessions.ts:116`). A `prompted` event for a session the process never saw is treated as an ended session, so it gets its final response and can't stop anything (`SPIKE/src/agent-sessions.ts:411-418`).

**4. A silent turn of 35 minutes stays alive: PASS on real Linear, 5 of 5.**
- REAL [4]: the turn ran 35.1 minutes with 0 stale episodes; the longest silence was 20.0 minutes; the session ended `complete`. "A heartbeat kept it alive: 1 posted, 0 missed." The five checks are the four of `evaluateKeepAlive` (ran at least 35 minutes, never stale, no silence reached 30 minutes, ended complete) and "kept alive by a heartbeat, not by luck" (`SPIKE/src/real-run.ts:382-388`; `SPIKE/src/scenarios/evaluate.ts:58-67`).
- What held: an **ephemeral thought** every **20 minutes** (`SPIKE/src/real-run.ts:184`; `SPIKE/src/scenarios/keep-alive.ts:12`). The turn was silent for 35 minutes, and Linear's documented staleness is 30. Without a heartbeat that counted, the session would have been silent for 35, so the pass is consistent with an ephemeral thought counting as activity (Surprise 6).
- How it was judged: the probe session's status was polled once a minute, and every 10 s from minute 28, so a short stale episode is seen (`SPIKE/src/real-run.ts:66,371-377`). The final status was read back through the API (`SPIKE/src/real-run.ts:379-387`).
- What it does not show:
  - **One run, one heartbeat, one session.** The other 49 sessions' statuses were not followed through the 35 minutes.
  - **No control on real Linear.** The run with no heartbeat, which the fake did go stale on (RUN), was not made for real, so Linear marking a session stale after 30 minutes of silence was not itself observed. The 30 minutes is still the docs' figure and the spike's reading (Surprise 5).
  - **The longest silence is ostra's own post gap** (`SPIKE/src/real-run.ts:384`), not Linear's view of the session.
- RUN: the fake's side. 17 checks pass, on a clock 300x faster than the wall clock (7.0 s real for a 35.2-minute turn; `SPIKE/src/scenarios/keep-alive.ts:113-126`). Three sessions: 0 stale episodes, longest silence 20.0 minutes, one heartbeat each. The control with no heartbeat did go stale (1 episode, 35.0 minutes of silence; `SPIKE/src/scenarios/keep-alive.ts:86-93`). A faulty heartbeat got through a server error and a rate limit (5 activity calls for one first thought, one heartbeat and one response).
- The fake defines the staleness rule, and its `touch()` resets the clock on any thought, ephemeral or not (`SPIKE/src/fake-linear/rules.ts:14-18,51-59`; `SPIKE/src/fake-linear/fake-linear.ts:291-292`). So the fake's passes never showed that Linear counts what it posts. The real run is the first evidence that it does.
- No 35-minute real-time run against the fake is recorded, and none is needed now: it would test only the fake (`README:60`).

**5. `@linear/sdk` typechecks under ostra's strict flags and adds under 20 s to `tsc`: PASS.** From the first version's runs, not rerun; the files behind it (`measure/`, `src/tsc-measure.ts`, `src/scenarios/sdk-strict.ts`, `src/sdk-shims.d.ts`) are not among the changed ones.
- RUN, strict: the spike typechecks with TypeScript 6.0.3 in 2.06 to 2.08 s over 460 files, with `skipLibCheck` **off**, so `tsc` reads the SDK's own declarations. The config has all eight flags of `AGENTS.md` (`SPIKE/tsconfig.base.json:8-15`), plus `noUnusedLocals`, `noUnusedParameters` and `erasableSyntaxOnly`.
- RUN, root-style: the SDK's usage typechecks with `skipLibCheck` on, no DOM lib and no shim file in 656.3 to 697.9 ms over 427 files, with no errors (`SPIKE/measure/root-style/tsconfig.json:1-5`). That project extends the spike's own `tsconfig.base.json`, not the repo's, and the two differ: the spike's uses `module`/`moduleResolution` `nodenext` and `types: ["node"]`, plus `erasableSyntaxOnly`, `isolatedModules` and `noUnused*`, where the root's has `ESNext`, `Bundler` and none of those (`SPIKE/tsconfig.base.json:3-22`; root `tsconfig.base.json:4-20`). So the first version also ran `tsc` on the same usage file (`measure/with-sdk/index.ts`) under the repo's real `tsconfig.base.json`, from a scratch config outside the repo that extends it and adds only `types: ["node"]` and a `typeRoots` pointing at the spike's `node_modules`. It reported no errors over 427 files in 0.66 s, with `moduleResolution` `bundler`, `module` `esnext` and `skipLibCheck` on. So ostra's own config needs no shim.
- RUN, cost: the SDK adds **about 0.8 s** with `skipLibCheck` off, against 20 s. The two `pnpm spike` runs gave 805.8 ms (1.11 s without the SDK, 1.91 s with it) and 778.3 ms (1.09 s and 1.87 s), and `pnpm measure:tsc` with 5 runs gave 772.0 ms (1.11 s and 1.88 s). It is the difference of two projects that differ only by the SDK (`SPIKE/measure/baseline/index.ts`, `SPIKE/measure/with-sdk/index.ts`), as the median wall time of the whole process after a warm-up (3 runs in `pnpm spike`, `SPIKE/src/harness.ts:32`; `SPIKE/src/tsc-measure.ts:101-165`). The 20 s is a working value (`PASSBAR`, line 136).
- RUN, start-up: a cold `import` costs 33.9 to 35.9 ms for `@linear/sdk`, 7.3 to 8.1 ms for `@linear/sdk/webhooks` and 59.7 to 62.4 ms for `zod`.
- RUN (`measure:tsc`, which also times `skipLibCheck` on; `pnpm spike` times "off" only, `SPIKE/src/harness.ts:89`): with `skipLibCheck` on, the SDK adds 247.6 ms (401.5 ms to 649.2 ms). The README says 0.26 s (`README:69`). The SDK brings 133 files (295 to 428) and 116,337 lines of declarations (64,494 to 180,831, from `tsc --extendedDiagnostics`). With lib checking on, `tsc` memory goes from 259 to 456 MB, about 200 MB more, and with `skipLibCheck` on from 88 to 218 MB.
- The DOM shim: the SDK's declarations name `JsonWebKey` and `CryptoKeyPair` (`SDK/dpop-D3rojqN8.d.mts:13,80`). `tsc` on the SDK project with the spike's flags, `skipLibCheck` off, no DOM lib and no shim file reports exactly two errors, TS2304 `Cannot find name 'JsonWebKey'` and TS2552 `Cannot find name 'CryptoKeyPair'`, both in the SDK's own `.d.mts`. A four-line alias fixes it (`SPIKE/src/sdk-shims.d.ts:1-11`). It's needed only if ostra turns `skipLibCheck` off. This is why bullet 5's "typechecks" with lib checking on holds only with the shim.
- Scope: this is `tsc` on a small project. It isn't ostra's whole repo, and it isn't the editor's language server. TypeScript 7 wasn't measured (`README:77`). Lint is not part of the bullet. The first version ran it anyway, from the repo root: `node_modules/.bin/eslint --no-ignore spikes/linear-agent-mode/src spikes/linear-agent-mode/measure`. It linted 36 files and reported 0 errors and 0 warnings, under the root `eslint.config.js`, which loads typescript-eslint's `strictTypeChecked` and `stylisticTypeChecked` (`eslint.config.js:69`; `README:119`). The spike has gained files since (`thread-reply.ts`, `token-store.ts`) and several were edited, so that lint count is not current.

**Beyond the bar: webhook edges [H]: 25 of 25 passed in the first version's runs and, per the README, still pass (README, not rerun; `README:33`).** RUN: a correctly signed `created` is accepted. An identical replay is acknowledged but not processed. The same body under a new delivery ID is caught by its signature. A body changed after signing, a wrong secret, no signature, a signature older than a minute and one stamped in the future are all refused with 400. A 2 MiB body is refused with 413 before it is parsed. A later-added field is tolerated, and no secret reached a log line. The real run adds one fact to this: Linear's real signatures passed the SDK's verifier, and its real timestamps passed the 60 s window with this machine about 1.1 s behind (REAL [2]; `SPIKE/src/webhook-verify.ts:18`).

---

## 3. What surprised us, and the gotchas

**Surprises**

1. **A personal API key can't send a stop, or a prompt.**
   - REAL [3]: `agentActivityCreate` with a personal API key is refused, "for both a prompt and signal: stop, with 'Using an unexpected authentication method (apiKey) for an operation' (403 FORBIDDEN)". The harness's own prompt says the same (`SPIKE/src/real-run.ts:230-233`), and the thread-reply module's header records it (`SPIKE/src/thread-reply.ts:10-11`).
   - So a person's stop cannot be automated with an API key, and the real run needs a person to press Send stop request.
   - It fits the docs: the stop signal is generated "when a user requests the agent to stop from within Linear" and "An agent cannot generate a `prompt` type activity" ([DOCS/agent-signals](https://linear.app/developers/agent-signals), [DOCS/agent-interaction](https://linear.app/developers/agent-interaction), through a summarising fetcher). They don't say a key is refused.
   - The refusal names the authentication method, not the content. The real run showed it for a prompt and for a stop. That a key can't post a plain thought either is the fake's assumption (`SPIKE/src/fake-linear/fake-linear.ts:454-456`; `SPIKE/src/scenarios/stop-follow-up.ts:62-68`), **unverified** on real Linear.

2. **A follow-up can be automated, as a thread reply.**
   - REAL [3]: the reply was posted through the API as the admin's user: `commentCreate` with `parentId` = `agentSession.comment.id`, on OST-5. Linear sent the server a `prompted` event for it.
   - `thread-reply.ts` does the same in two requests, one to find the session's comment and issue and one to reply (`SPIKE/src/thread-reply.ts:13-15,44-46`). It has not run against real Linear (`README:59`).
   - One session, one way of starting it: OST-5 was delegated through the API. Whether a session started in another way (a mention, or Delegate in the UI) has a comment to reply under is not shown. The code treats it as nullable (`SPIKE/src/thread-reply.ts:21,45`).
   - What the reply came from: the admin's personal key, as the admin. That is a test tool. It is not a product path (section 4).

3. **Clock skew made the end-to-end figure unusable, and the run said so.**
   - REAL [2]: this machine was "about 1,103 ms behind Linear". The run's design held: it refused to clamp a negative transit, called bullet 2 INCONCLUSIVE and left transit out of its figures (`SPIKE/src/real-run.ts:312-318,328-330`).
   - The skew also matters to ostra. The SDK's verifier refuses a webhook whose signed timestamp is more than 60 s away (Surprise 11). At 1.1 s the real webhooks were fine. A host whose clock is a minute or more off would have every webhook refused with 400 (**inferred** from the verifier and the hardening checks), and Linear would retry and could disable the webhook (Surprise 8).

4. **The stop's shape is still unverified, and the log can't show it.**
   - The harness's FAIL was its own window, not Linear. The follow-up and the stop were delivered, as accepted `prompted` webhooks.
   - The server logs the action but not the `stop` flag (`SPIKE/src/server.ts:279-284`). So the run's log can't say whether the stop arrived with `signal: "stop"`. The README says the same (`README:42,165`).
   - A boolean flag isn't content, so logging it is allowed by the "IDs and structured fields, never content" rule (`AGENTS.md`). The next real run should log it.

5. **The 30-minute rule is stated in one place, and as a note.**
   - The 5 s is on the webhooks page: a reply that "takes longer than 5 seconds (5000ms)" counts as failed ([DOCS/webhooks](https://linear.app/developers/webhooks)). The agent-interaction page repeats it.
   - The 10 s is on the agents, agent-interaction and best-practices pages.
   - The 30 minutes appears once, in a note on the best-practices page: "Follow-up activities after the first response can still be sent for up to 30 minutes before the session is considered stale", and "this stale state is recoverable by sending another agent activity" ([DOCS/agent-best-practices](https://linear.app/developers/agent-best-practices)). The agent-interaction page lists `stale` as a state and gives no threshold (re-read for this update through a summarising fetcher: it says Linear tracks the lifecycle "based on the last emitted activity", and "does not mention a 30-minute rule").
   - ADR 0013 words it as "post again at least every 30 minutes" (`context/decisions/0013-tracker-adapters-and-linear-modes.md:14`). The reading "30 minutes since the last activity" is the spike's and `trackers.md`'s, and the fake encodes it (`SPIKE/src/fake-linear/rules.ts:14-18,51-59`). The docs don't state that the clock restarts on each activity. **Unverified**, though the real run (bullet 4) did not contradict it.
   - Because stale is recoverable, a wrong reading is not fatal. The next activity brings the session back.

6. **An ephemeral thought looks like it counts as activity.**
   - The docs didn't say. The SDK says an ephemeral activity is hidden "after the next activity" (`SDK/index-BPbyHLYG.d.mts:237`). The docs page says it is replaced when the next activity arrives ([DOCS/agent-interaction](https://linear.app/developers/agent-interaction)). Neither says whether it moves the stale clock.
   - REAL [4]: a 35.1-minute silent turn, one ephemeral heartbeat at 20 minutes, no stale episode seen. That is consistent with yes, as bullet 4 above sets out, with its limits (one run, no control).
   - The spike's heartbeat is ephemeral by default (`SPIKE/src/agent-sessions.ts:17-22`; `SPIKE/src/scenarios/common.ts:157`; `SPIKE/src/real-run.ts:184`). The fallback is a one-word config change to `kind: "thought"`, which is permanent and visible. `research/integrations-platform.md` S-10 asks the same question (line 429).

7. **A link counts as a first response, and the spike doesn't rely on it.**
   - The agents page says "Emit a `thought` activity within 10 seconds" ([DOCS/agents](https://linear.app/developers/agents)). The agent-interaction page says an activity or an external-URL update. The spike posts both at once, with hedged retries (the thought on one client-made activity ID), inside a 7 s budget (`SPIKE/src/agent-sessions.ts:301-328`; `SPIKE/src/scenarios/common.ts:154`; `SPIKE/src/real-run.ts:184`), and judges only the thought.

8. **The 5 s is a Postgres and proxy question, not a CPU one.**
   - The server's own part of the ack is a few milliseconds, and now measured on real Linear: p50 1.1 ms, max 5.8 ms (REAL [2]). The insert and the proxy share the rest: with the fake's modelled insert, 4.5 s held and 5.2 s broke (RUN, inbox probe).
   - A miss isn't free. Linear retries after 1 minute, 1 hour and 6 hours, and the webhook "might be disabled" if the URL stays unresponsive ([DOCS/webhooks](https://linear.app/developers/webhooks)). So a slow insert could end with the app's webhook switched off.
   - ADR 0013 names Cloudflare Tunnel and Tailscale Funnel as ways to get a public address (`0013:10`). The real run went through a Cloudflare quick tunnel, so the hop was in the path. Its share of the 5 s was not measured: the ack stops at the 200 being flushed, and the return leg is outside it (`README:58`).

9. **The manifest saves the form, and the three values did come back.**
   - The first version could say only that the real-run script has the admin copy the client ID, client secret and webhook secret from Linear into `linear.env` after Create (`README:149`; `SPIKE/src/real-run.ts:173-180`), and that the manifest page says nothing about those values: the word "secret" does not occur on it ([DOCS/oauth-app-manifests](https://linear.app/developers/oauth-app-manifests)).
   - The real run could not have started without them (`SPIKE/src/real-run.ts:173-183`), and it installed. So by inference the admin got all three after Create. How Linear presents them is not in the facts I was given.
   - F-012's setup is therefore three steps: Create on the link, paste three values into ostra, then Authorize. The Authorize step is the one the app token comes from, and the token lasts 24 hours (Gotcha 23).

10. **The SDK's webhook types don't narrow, and one is probably wrong on the wire.**
    - `LinearWebhookPayload` includes `EntityWebhookPayloadWithUnknownEntityData`, whose `type` is a plain `string` (`SDK/index-BPbyHLYG.d.mts:70423,70514,4513`). So `payload.type === "AgentSessionEvent"` doesn't narrow.
    - The top-level `createdAt` is typed `Date` (`SDK/index-BPbyHLYG.d.mts:23,4507`). The spike's fake sends an ISO string (`SPIKE/src/fake-linear/payloads.ts:9-12`), and Linear's docs type `createdAt` as `string` in the other agent payload examples, `AppUserNotification` and `PermissionChange` ([DOCS/agent-best-practices](https://linear.app/developers/agent-best-practices)). The real run received real `AgentSessionEvent`s, but the spike's schema doesn't read `createdAt` (`SPIKE/src/webhook-schema.ts:30-38`), so the real value was not compared and this stays **unverified**.
    - Zod at the boundary was required anyway (`AGENTS.md`). The spike's schemas tolerate unknown fields, as the rule for vendor formats says (`SPIKE/src/webhook-schema.ts:4-5`; Zod's `z.object` drops unknown keys, as at `:18-28`, and the hardening run's "fields Linear adds later are tolerated" passes). The real events parsed: 50 `created` events produced 50 sessions (REAL [2]).

11. **`LinearWebhookClient.verify` is thin.**
    - It checks a constant-time HMAC-SHA256, then the signed body's `webhookTimestamp` against a 60 s window, and throws plain `Error`s (`SDK/webhooks-DyX3tY_A.mjs:200-208`). It keeps no memory of what it has seen.
    - The sdk-webhooks page states neither the 60 s nor any replay protection ([DOCS/sdk-webhooks](https://linear.app/developers/sdk-webhooks)). The webhooks page only recommends a check "within a minute".
    - The spike tells failures apart by message text (`SPIKE/src/webhook-verify.ts:27-33`). A reworded message would change only the logged reason, because both answers are 400 (`SPIKE/src/server.ts:236-242`). The inbox dedupes on the delivery ID and on the signature (`SPIKE/src/server.ts:243-255`).
    - It verified real Linear's webhooks in the real run (Surprise 3).

12. **`createAgentActivity` hands back an ID, not the activity, and that held on real Linear.**
    - The wrapper reads `agentActivityId` and parses it as a UUID, and throws if it can't (`SPIKE/src/linear-api.ts:65-76`). In the SDK's source the payload's `agentActivity` getter is a second request (`new AgentActivityQuery(...).fetch(id)`) and `agentActivityId` is read from the first response (`SDK/index.mjs:71358-71364`).
    - The first version feared real Linear might return another shape, so that a real post would count as failed. It did not: a thought counts as the first thought only when its post succeeded (`SPIKE/src/agent-sessions.ts:302-307`), and all 50 sessions got one (REAL [2]), and the heartbeat posted (REAL [4]).

**Gotchas**

13. **A retry may arrive with the old timestamp.** The fake stamps every retry afresh and marks that "(Assumed: unverified)" (`SPIKE/src/fake-linear/fake-linear.ts:398`). If Linear resends the original body, the SDK's 60 s check refuses the first retry, which comes a minute later. The server answers 400, and the next retry comes an hour on. The docs don't say whether retries reuse the body or the `Linear-Delivery` ID ([DOCS/webhooks](https://linear.app/developers/webhooks)). No retry was seen in the facts I was given, so this is **unverified**. A reconciler for missed webhooks is already on the spike's not-built list (`README:205`).

14. **A repeated activity ID is the spike's idempotency, and Linear's answer to it is unknown.** Every attempt of one activity carries one client-made UUID (`SPIKE/src/agent-sessions.ts:157`; `SPIKE/src/retry.ts:16-20`). The SDK says the `id` is "The identifier in UUID v4 format. If none is provided, the backend will generate one" (`SDK/index-BPbyHLYG.d.mts:239-240`). It says nothing about a repeat. The "very slow Linear" run passed because the fake answers a repeat as the original (RUN, "10 repeats answered as the original"; `SPIKE/src/fake-linear/fake-linear.ts:486-494`). The real run, as reported, doesn't say a repeat happened. **Unverified** on real Linear.

15. **The heartbeat ignores other posts, and its retry window reaches the stale edge (inferred).** The loop sleeps 20 minutes and posts, whatever else was posted (`SPIKE/src/agent-sessions.ts:179-222`). Its retries may run up to half an interval, so a heartbeat that fails for 10 minutes lands at 30 minutes of silence (`SPIKE/src/agent-sessions.ts:205-206`). In the spike nothing else posts, so this doesn't show. In ostra the runner's stream will post, and the timer should reset on any post.

16. **A shorter heartbeat costs little.** One request per 20 minutes is 3 an hour per silent session. Against 5,000 an hour for an app user ([DOCS/rate-limiting](https://linear.app/developers/rate-limiting)), that is about 1,600 silent sessions per workspace (RUN, keep-alive note). That is derived from the doc figure, not measured. 5,000 is the standard limit: the page also lists plan multipliers (Business 2x, Enterprise 5x) and says workspace-level OAuth apps using actor authorization get dynamic increases based on paid users, without saying how much, so the figure is a floor.

17. **Everything in the session service is in memory.** Sessions, the 24-hour dedupe window and the pending-install table are per-process `Map`s (`SPIKE/src/agent-sessions.ts:116`; `SPIKE/src/server.ts:131,181-190`). A restart, or a second replica, loses them. The README lists the Postgres versions as not built (`README:204-208`).

18. **The install routes are open.** The spike bounds what they hold (100 pending, 10-minute TTL, a sweep timer) but requires no ostra admin session (`SPIKE/src/server.ts:132,183,289-318`; RUN, "12 install starts"). The README says the product needs an admin session with the OAuth `state` bound to it (`README:208`). In the real run the install routes were on a public quick-tunnel address while the run lasted (`README:22`).

19. **The address pre-check is stricter than Linear's published rule.** Linear says the webhook host "must not be a loopback host, private-network host, or `linear.app`" and must use `https://` ([DOCS/oauth-app-manifests](https://linear.app/developers/oauth-app-manifests)). The spike also refuses a host with no dot and the suffixes `.local`, `.internal`, `.lan` and `.home.arpa` (`SPIKE/src/manifest.ts:109-135`). The app's name falls back to plain `ostra` when the host contains "linear", because the schema forbids that word in a name (`SPIKE/src/manifest.ts:144-149,219-223`). A Cloudflare quick tunnel's address passed the pre-check in the real run (the run stops at the pre-check otherwise, `SPIKE/src/real-run.ts:162-166`).

20. **API delegation by a personal key starts a session: settled.** The SDK says delegation "can start an agent session on the issue and requires permission to invoke that agent" (`SDK/index-BPbyHLYG.d.mts:7592`). The real run created 50 issues with `delegateId` through the admin's key (`SPIKE/src/real-run.ts:217`), and each sent a `created` event (REAL [2]; `README:168`). The "can" held for this admin. A key whose user lacked permission is not shown.

21. **The real-run script's Linear-facing parts have now run, except the new ones.** Run for real: the install, the workspace check, `issueCreate` with `delegateId`, the tunnel self-check, the status reads, the archive (all 50 issues archived), and the keep-alive (`README:156`; REAL). Never run against Linear: the automated thread reply, the saved-token reuse, and the configurable window, all added after the run and rehearsed against the fake only (`SPIKE_REHEARSAL=1 pnpm spike:real`; `README:47-51,156`). The script reports INCONCLUSIVE, and would exit 2, if this machine's clock is behind Linear's by more than the transit and nothing failed (`SPIKE/src/real-run.ts:314,399-403`). It exited on FAIL here (Surprise 4).

22. **The spike's own runs found bugs in the spike.** A reopened session lost its follow-up text. `receivedAt` mixed two clocks. A timed-out request was abandoned, not hedged. Review found that the real run could count a link as the first activity (`README:185`). The real run added two harness gaps: a fixed 15-minute wait for a human (now configurable), and a log that can't show the stop's signal (Surprise 4). That's a reason to keep trusting the harness's refusal to count fake passes.

23. **The app's token lasts a day, and the spike keeps it in a file.** `actor=app` access tokens last 24 hours, with a rotating 30-day refresh token (`research/trackers.md:69`, the `actor=app` row). The spike keeps only the access token, in `~/.config/ostra-dev/linear-app-token.json`, outside the repo, and reuses it while Linear confirms `viewer.app`, the user and the scopes. An expired one is refused and the install runs again (`SPIKE/src/token-store.ts:9-14,81-86`; `README:134`). Refresh rotation is not built (`README:205`).

**Housekeeping.** The first version's harness watchdog reports and exits if a handle is left open (`SPIKE/src/harness.ts:141-148`), and it printed nothing in either fake run. For this update I ran nothing, so I did not check for leftover processes. I don't know whether the real run's server or tunnel is still up. The real run archived its 50 issues (REAL cleanup). The README says up to 49 agent sessions stay in the test workspace, because the spike posts no final activity to them on shutdown (`README:45,154`).

---

## 4. What this changes in the plan

These are recommendations for the maintainer. I changed no other file.

**Recommendations for ostra's product, from the real run**

1. **A stop always comes from a signed-in user's click in Linear, never from an API key.**
   - A key is refused (Surprise 1), the docs call the stop a user's request from within Linear, and an agent can't generate a prompt-type activity ([DOCS/agent-signals](https://linear.app/developers/agent-signals); [DOCS/agent-interaction](https://linear.app/developers/agent-interaction)). So ostra never builds a path that sends a stop to Linear for someone, and never keeps a member's personal key to try.
   - The stop reaches ostra as a `prompted` event with `signal: "stop"`, which ostra turns into "stop the turn, post one final `response`, end the session" (`SPIKE/src/webhook-schema.ts:122`; `SPIKE/src/agent-sessions.ts:341-348`). The signal is **unverified** until the next real run, which must log it (Surprise 4).
   - A stop pressed in ostra's own panel is a different action. It stops the runner's turn and posts the final `response` with the app's token, which is the activity Linear expects after a stop. It doesn't claim a user stopped it in Linear. **Derived**, not run: the real run posted a final response only on the fake's path.
   - A follow-up typed in Linear arrives as `prompted`, and the spike hands it to the running turn (`SPIKE/src/agent-sessions.ts:350-362`). Posting a follow-up by thread reply with a personal key is a test tool (`SPIKE/src/thread-reply.ts:6-8`), and a follow-up typed in ostra's panel goes to the turn directly. Neither needs a member's key.

2. **Heartbeat: an ephemeral thought every 20 minutes.**
   - That is what held (REAL [4]): `kind: "ephemeral-thought"`, `intervalMs` 20 minutes, 1 posted and 0 missed over a 35.1-minute silent turn (`SPIKE/src/real-run.ts:184`). Keep the `thought` kind as the one-word fallback (`SPIKE/src/agent-sessions.ts:17-22`).
   - Reset the timer on any post, not only on its own (Gotcha 15). Keep the retry window shorter than the margin left to the 30 minutes: with a 20-minute interval and a retry deadline of half an interval, a heartbeat that fails for 10 minutes lands exactly at 30 minutes of silence (`SPIKE/src/agent-sessions.ts:205-206`).
   - A shorter interval is cheap (Gotcha 16): 15 minutes is 4 requests an hour per silent session. The spike tested no other interval, so that's a choice, not a finding.
   - It rests on one run with one heartbeat (bullet 4).

3. **A durable inbox in the ack path.**
   - The handler's path is verify, one insert keyed by both the signature and the delivery ID, 200, then work (`SPIKE/src/server.ts:236-286`). The insert has to be durable before the 200, or a restart loses an event whose 200 already told Linear to stop. A failed delivery is retried after 1 minute, 1 hour and 6 hours ([DOCS/webhooks](https://linear.app/developers/webhooks)).
   - The server's own share was p50 1.1 ms and max 5.8 ms (REAL [2]), so about 4.99 s of the 5 s are left for the insert, the proxy or tunnel, TLS and the return leg. The fake's probe held at a 4.5 s insert and broke at 5.2 s (RUN). Real Postgres and a real proxy are not in any measurement yet, so milestone 1 measures them before that margin is trusted (section 5).
   - Give the insert its own deadline, well inside the 5 s, and answer a non-2xx when it fails, so Linear retries instead of the event being lost behind a 200. That is **derived** from the docs' retry rule and not run.
   - Keep the host's clock within the SDK's 60 s window, and record transit per webhook, as the spike does (`SPIKE/src/server.ts:273`). Warn when it is far from zero (Surprise 3). Derived, not run.

**Changes to documents**

4. **ADR 0013: keep the decision, and amend it after the next real run.**
   - Nothing failed, so the fallback in `PASSBAR` isn't triggered. Amend once bullet 3 and bullet 2's end-to-end figure are closed, because both change the Consequences line (`0013:14`).
   - Say the 5 s covers the TLS proxy and the durable insert, so the handler's path is verify, insert, 200 and nothing else. Say Linear retries after 1 minute, 1 hour and 6 hours and may disable a webhook that stays unresponsive.
   - Word the 30 minutes as the docs do, and say that a real 35-minute silent turn stayed alive on a 20-minute ephemeral heartbeat, and that a stop is a user's action in Linear that an API key can't send.

5. **F-012: leave it `planned`, and don't call it de-risked.**
   - Its spec (`context/specs/`, not yet written) should carry what the spike found:
     - the fast lane runs on the server and never waits for a runner (`SPIKE/src/agent-sessions.ts:292-339`)
     - the turn's state lives in Postgres, so a stop reaches a turn on another replica (Gotcha 17)
     - the heartbeat is an ephemeral thought at 20 minutes and resets on any post (recommendation 2)
     - the setup is Create, paste three values, Authorize (Surprise 9), and the token lasts a day, with a rotating refresh token (Gotcha 23)
     - the stop is a user's click in Linear, never an API call (recommendation 1)
     - the install route needs an admin session (Gotcha 18)
   - Add to F-012's "done when" that spike 5's four real-Linear bullets passed. The ledger row today names none (`context/features.md:73`). Two of them have (1 and 4), bullet 2 has its server-side half, and bullet 3 has none.

6. **Q25, ADR 0025, ADR 0008: the SDK stays, wrapped in the adapter.**
   - Bullet 5 passes with a margin of about 25 times (0.8 s against 20 s), and the root config needs no shim (bullet 5 above).
   - The real run also ran the SDK's webhook verifier on real signatures (Surprise 11) and its `createAgentActivity` on real Linear (Surprise 12).
   - Keep the hot path on ostra's own GraphQL documents, as the spike does for the viewer and session status (`SPIKE/src/linear-api.ts:51-60,86-96`), and the SDK for mutations and for webhook verification.
   - Pin the SDK exactly. 103.0.0 is newer than the 102.0.0 the spike ran on. Rerun `pnpm spike -- --only sdk-strict` before bumping.
   - Add one line to ADR 0008, or a comment in the root `tsconfig.base.json`, that turning `skipLibCheck` off needs the four-line shim or the `dom` lib in server packages.

7. **Research rows: close one, narrow one, keep the rest.**
   - `integrations-platform.md` S-1 (line 420: does the SDK typecheck cleanly under ostra's flags with `skipLibCheck: false`, and what does it cost `tsc` and the editor): answered for `tsc`, not for the editor. With `skipLibCheck: false` and no DOM lib the answer is "not cleanly": two errors in the SDK's own declarations, fixed by a four-line shim, and then it adds about 0.8 s. Under the repo's real `skipLibCheck: true` it is clean with no shim and adds about 0.25 s (bullet 5). The editor's cost was not measured. Mark it so.
   - `integrations-platform.md` S-10 (line 429: does Linear mark a silent session stale, and is there a 30-minute heartbeat): **narrowed, not closed.** A 35.1-minute silent turn did not go stale with a 20-minute ephemeral heartbeat (bullet 4). Linear marking a session stale after 30 minutes without one was not observed, and the silence in the stand-in turn is not a long tool call. A control run with the heartbeat off, for 35 real minutes, would close it (`SPIKE/src/agent-sessions.ts:18,181` support the `off` kind). It adds little for the product, which will ship the heartbeat either way.
   - `README:203` says the finding belongs to `integrations-platform.md` S-1 and S-10 and `trackers.md` S-1 and S-3. It does not answer the `trackers.md` ones. S-1 asks about the client-credentials grant, and the spike uses the authorization-code grant only (`SPIKE/src/manifest.ts:263`; `SPIKE/src/oauth.ts:67-75`). S-3 asks what Linear does with a dead webhook URL, and no dead URL was tried. Leave both open. S-6 (activity throughput) gains only a derived number (Gotcha 16): the real run posted 50 thoughts and one heartbeat and the facts I was given report no rate limit, which is not a load test.

8. **`docs/development.md`: add the lines the README proposes** (`README:138-145`). Today `linear.env` is listed with `LINEAR_API_KEY` only, and `tunnel.env` is "whatever the chosen tunnel needs" (`docs/development.md:9,12`). The real run also needed `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET` and `LINEAR_WEBHOOK_SECRET` in `linear.env`, and `OSTRA_DEV_PUBLIC_URL` in `tunnel.env`. It also keeps the app's token in `~/.config/ostra-dev/linear-app-token.json` (`README:134`), which `docs/development.md` doesn't list. A tunnel had to be chosen: the run used a Cloudflare quick tunnel. Which tunnel the docs recommend is the maintainer's call (`AGENTS.md`: ask before building on a vendor or paid service).

9. **Milestone 1: carry the shapes, not the code.** The spike is throwaway (`AGENTS.md`). These shapes are worth keeping:
   - the `SessionState` union (`SPIKE/src/session-model.ts:7-17`)
   - the order: verify, claim the delivery ID and the signature in one insert, answer 200, then work (`SPIKE/src/server.ts:220-286`)
   - first thought and link in parallel, with hedged retries on one activity ID (`SPIKE/src/retry.ts:36-91`)
   - the heartbeat as a config with a kind and an interval (`SPIKE/src/agent-sessions.ts:17-22`)
   - the check that a token is the app's own user before it is kept (`SPIKE/src/server.ts:345-351,392-426`)
   - the address pre-check shown on the setup screen (`SPIKE/src/manifest.ts:69-135`). Its new setting needs a working default and a line in the configuration reference (the self-hosting rule in `AGENTS.md`)

10. **Adapter parity.** The spike never touches the `TrackerAdapter` interface. It makes no claim about "agent sessions" as a declared optional capability (ADR 0013:5). The interface work stays with milestone 1, and the Jira fake joins the tracker contract suite from milestone 2 (ADR 0047:47). What the real run adds to the interface's shape: a tracker's "stop" is a person's action inside the tracker, so the capability is an event ostra receives, not a call ostra makes.

---

## 5. What's still open

**Left open by the real run (3 items).**

1. **Bullet 3, stop and follow-up: not passed.**
   - Rerun `pnpm spike:real` with `LINEAR_API_KEY` set, so the follow-up is automatic, and with a person ready to press Send stop request, with a `SPIKE_HUMAN_WAIT_MIN` that covers it (`README:201`; `SPIKE/src/real-run.ts:223-234`). Log the `stop` flag first (Surprise 4).
   - A pass needs the harness itself to see the four things it checks: the follow-up reached the turn, the stop reached the turn and stopped it, ostra's state ended (stopped), and Linear shows the session complete (`SPIKE/src/real-run.ts:355-361`).
   - It also settles why the follow-up's session showed `complete`.

2. **Bullet 2's end-to-end figure.** Resync this machine's clock first (a Windows time resync, `README:38`), then run again, so "our clock at receipt minus Linear's timestamp" is positive. Even then the figure leaves out the 200's return leg (`SPIKE/src/server.ts:94-98`).

3. **The after-run changes have never met Linear:** the thread-reply module, the saved-token reuse and the configurable wait window (`README:47-51,156`). The next real run exercises all three.

**The assumptions the fake made, and where each stands** (`README:160-172`):

| Assumption | After the real run |
|---|---|
| An ephemeral thought counts as activity | Consistent with yes: one 35-minute run, no control (bullet 4) |
| A stop arrives as `prompted` with `signal: "stop"` | A `prompted` webhook arrived; its signal was not logged. **Open** |
| A repeated activity ID is answered as the original | Not observed. **Open** |
| A retry is stamped afresh | Not observed. **Open** |
| `viewer.app` is true for the `actor=app` token | **Settled** (bullet 1) |
| `agentSession(id) { status }` can be read with the app's own token | **Settled**: all 50 statuses were read that way (`README:167`) |
| API delegation by a personal key starts a session | **Settled** (Gotcha 20) |
| A personal key can reply in a thread, and the reply becomes `prompted` | **Observed once, by hand**, on OST-5 (Surprise 2) |
| A personal key can't post a prompt or a stop | **Settled**: 403 (Surprise 1). A plain thought by a key is untested |
| Linear's server enforces the manifest schema as published | A valid manifest was accepted. Refusal of a bad one **open** |

**Not covered, though no bullet names it:**
- **The durable inbox and the proxy in the ack path.** The ack was measured against a `Map` (Surprise 8). It needs the real Postgres insert and the real tunnel or proxy, in milestone 1.
- **A stop on another replica.** Needs the turn's state in Postgres (`README:207`).
- **Refresh-token rotation, the shared rate limiter and the reconciler for missed webhooks** (`README:205`). The saved token stops working after a day (Gotcha 23).
- **Linux and macOS.** Only Windows 11 ran, fake and real. The process-tree kill has a non-Windows branch that hasn't run (`SPIKE/src/tsc-measure.ts:40-52`).
- **`@linear/sdk` 103.0.0.** Not tested.
- **The editor's language server, TypeScript 7 and ostra's whole repo**, for the cost of the SDK (bullet 5).
- **Real `createdAt` on an `AgentSessionEvent`** (Surprise 10).
- **Real Linear's own record of the webhook round trips**, if it shows one. Nobody read it.

**Decisions the spike can't make:**
- which tunnel the development setup, and the docs, recommend. A quick tunnel worked for one run (`docs/development.md:12`)
- when the maintainer or an admin can spend another stretch on the rerun: the real run is long because the keep-alive watches 35 real minutes (`SPIKE/src/real-run.ts:366-377`)
- whether the heartbeat should be shorter than 20 minutes (Gotchas 15 and 16, recommendation 2). 20 minutes held in the one real run
