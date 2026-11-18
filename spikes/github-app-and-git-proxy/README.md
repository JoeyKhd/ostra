# Spike 4: `github-app-and-git-proxy`

Milestone 0, throwaway code (`AGENTS.md`). Findings go into `context/research/` only after real runs against the sandbox org.

## The question

**Can the App and the git proxy carry all of a task's work on GitHub?** (`context/build-order.md`, spike 4)

**Decisions it tests:** Q26 (keeping keys from the agent: the sidecar's git proxy, ADR 0030), Q41 (who commits: the box, through the git proxy, ADR 0030 and ADR 0040) and Q55 (who authors PRs: the GitHub App, with co-author trailers and the `ostra/independent-review` check, ADR 0040). It also exercises the hidden ref of ADR 0039 and the read-only proxy for refine and review tasks (F-090).

**Passes when** (copied from `context/build-order.md`):

- The manifest flow creates the App from a local server, with the permissions v1 needs, `checks: write` among them.
- Through the proxy, stock git clones, fetches and pushes the task's branch. A push to the default branch, a delete and a push to another repo are refused before a byte reaches GitHub. The token never appears in the agent's container.
- LFS, a shallow clone and a 500 MB pack work, or their limits are written down.
- A PR the App opened with a co-author trailer shows the member as co-author. The App can post a comment-type review with line comments on its own PR. A check run flips when someone approves.
- Linear's GitHub integration links a PR the App opened.

**If it fails:** the sidecar pushes from its own clean clone instead of proxying.

## Architecture

```
agent's git ──(url.<proxy>/.insteadOf https://github.com/)──▶ git proxy ──(Basic x-access-token:<ghs_…>)──▶ GitHub
  no token, env from an allowlist                              one repo, one task's refs        or the local stand-in
```

- **`src/git-proxy.ts`: the proxy.** It serves the smart-HTTP endpoints of one repo (`info/refs`, `git-upload-pack`, `git-receive-pack`) plus the LFS batch and lock-verify endpoints. Every other path and every other repo gets a 403 or a 404. It drops every client header but a short allowlist (so the agent's own `Authorization` is gone), and adds the token upstream. Answers are streamed both ways. Upstream 401, 403 and 3xx become a 502, so git never prompts for a credential and never follows a redirect the policy didn't see.
- **The push check.** On `git-receive-pack`, the proxy reads the pkt-line command list up to its flush-pkt (`src/pkt-line.ts`) and decides (`src/policy.ts`) before it opens any upstream connection:
  - It allows only exact matches of `refs/heads/<task branch>` and `refs/ostra/wip/<task>`.
  - It refuses deletes, all of a push when one ref is bad, signed pushes and malformed lists.
  - A refusal drops the rest of the body and answers with a `report-status` (in side-band when asked), so stock git prints `! [remote rejected] … (ostra: …)`.
  - A read-only policy refuses `info/refs?service=git-receive-pack` outright.
- **LFS.** The batch answer's `actions` (signed URLs and their `Authorization` headers) stay in the proxy under random nonces, with a TTL of at most 1 h. The agent gets `<proxy>/_ostra/lfs/<nonce>` instead, and the proxy forwards to the real URL with the real headers and git-lfs's own `User-Agent`. An action is kept only when it points at the upstream's own origin, or at `https` on an allowlisted host. The default list is the hosts github.com's answers named on 2026-11-18: `github-cloud.s3.amazonaws.com` (upload), `lfs.github.com` (verify) and `github-cloud.githubusercontent.com` (download), plus `*.githubusercontent.com`. The S3 bucket is named exactly, since anyone can own a bucket under `s3.amazonaws.com`. The list is configurable for GitHub Enterprise Server (`lfsActionHosts`). IP literals, `localhost`, plain `http`, other ports, `user:pass@` and look-alike hosts are refused. When any of an object's actions is refused, the object gets none of them: it gets a per-object error, `ostra: the LFS server sent this object's transfer to a host the proxy doesn't allow`, so git-lfs fails. An object with no actions would tell git-lfs that the server already has it, and the push would "succeed" with nothing uploaded.
- **`src/upstream-stub.ts`: the local stand-in for GitHub.** It's a Node smart-HTTP server over local bare repos, in its own process. It runs `git upload-pack/receive-pack --stateless-rpc` the way `git-http-backend` does, and serves an LFS server whose object URLs need their own `RemoteAuth` credential, like GitHub's. Like GitHub, it refuses a request with no `User-Agent` with a 403. It counts every request.
- **Fake tokens in GitHub's shape (`src/fake-token.ts`).** The stand-in accepts only `ghs_<APPID>_<JWT>` tokens of about 520 characters, as GitHub's stateless installation tokens are (`research/platform-auth-github.md` §2.4), signed with an HMAC key and unexpired. So the leak scan, the Basic header and git's header handling all see a realistic token, and the harness can mint short-lived and expired ones.
- **`src/github/`: the GitHub half, written with Octokit.** It runs once the sandbox org exists:
  - the manifest flow (`manifest.ts`, `manifest-cli.ts`, `manifest-store.ts`)
  - installation tokens narrowed to the repos and permissions each step needs (`app-auth.ts`)
  - the PR flow (`pr-flow.ts`): the box commits as `<slug>[bot]` with a `Co-authored-by` trailer and pushes through the proxy. The App opens the PR, posts a `COMMENT` review with two line comments, and publishes `ostra/independent-review` as in progress. A second user approves, and the check flips to success, from the webhook when one is wired (`independent-review.ts` verifies its signature), else by polling.
  - the Linear probe (`src/linear/linear-api.ts`): it makes an issue, names the branch and the PR title after its identifier, writes `Fixes <ID>` in the body, and waits for Linear's integration to attach the PR.
- **`src/harness/`: the harness.** It runs the same git scenarios (`git-scenarios.ts`) against both targets (`local-target.ts`, `github-target.ts`). The agent's git runs with arguments as arrays, never a shell. Its environment is built from an allowlist with `GIT_CONFIG_NOSYSTEM=1`, and it gets its own `HOME`. Traces are on, with redaction off (`GIT_TRACE`, `GIT_TRACE_CURL`, `GIT_TRACE_PACKET`, `GIT_CURL_VERBOSE`, `GIT_TRACE_REDACT=0`), so a leaked token would show. The proxy runs inside the harness process, so its memory figures are the harness's.
- **What counts as a refusal.** A refused step counts only on the proxy's own evidence, never on a failed git exit alone:
  - git printed the proxy's refusal, word for word: `[remote rejected] … (ostra: …)` for a ref, or the 403 body `ostra: this task's proxy serves only its own repo` for another repo.
  - the proxy's `refusedPushes` and `refusedRequests` counters moved by exactly this refusal, and its forwarded `receive-pack` counter didn't move.
  - the refs the step aimed at read the same on the upstream before and after.
  - On the stand-in, the upstream's own counters must show no `receive-pack` request and nothing for the other repo. On GitHub, its activity log must show only the allowed push made right after the refusals (the positive control, so the log is known to have caught up), and nothing in the other repo.

## How to run

Node 24, pnpm, git and git-lfs. From this directory only:

```sh
pnpm install
pnpm typecheck        # strict tsc, no emit
pnpm lint             # the repo's strict-type-checked rules (eslint.config.js), 0 warnings
pnpm test             # node:test unit tests: pkt-line parser, ref policy, LFS host allowlist, fake tokens
pnpm check:inputs     # which inputs are present; never prints a value
pnpm spike            # every criterion it can run (see the exit codes below)
pnpm spike:local      # the same, but exit 0 when only the GitHub half is missing
pnpm manifest         # interactive: creates the sandbox App (see below)
```

`pnpm spike` prints one row per part of the pass bar, then the verdict bullet by bullet:

- `PASS`, `FAIL` or `SKIPPED` (with the missing input) for GitHub, and for the agent's container.
- `LOCAL-ONLY` for a part that passed against the local stand-in. It's evidence for the design, never for the criterion: every bullet names GitHub. Where the stand-in run covers less than the bullet says, the row says so in its wording, for example "here, the approver rule and the webhook signature only (no check run)".
- `pass bar: N of 5 bullets met on GitHub`. A bullet is met only when each of its parts has a GitHub `PASS`, and the token bullet also needs the container's `PASS`.
- Exit codes: `0` when all five bullets are met; `1` on any `FAIL`; `2` when nothing failed but a bullet is unmet. `--local` (`pnpm spike:local`) turns the `2` into `0`.

A full run takes about 5 minutes on this machine, most of it the 500 MiB pack. `SPIKE_LARGE_PACK_MB=0` skips the pack, and `SPIKE_LARGE_PACK_MB=50` shrinks it. A pack under 500 MiB is labelled with its size, and counts as no evidence for bullet 3, local-only or not. Sizes in the output are binary: 1 MiB = 1,048,576 bytes, so the "500 MB pack" of the pass bar is run as 500 MiB (524 MB). Scratch repos go to a temp directory that is removed at the end (`SPIKE_KEEP=1` keeps it). Ctrl-C kills every child process tree and removes the scratch directory. The last results are written to `.data/last-run.json`, which is gitignored.

### For the GitHub half

1. Create the sandbox org, and two repos in it, each with at least one commit: the task's repo and the "other" repo.
2. `export GITHUB_TEST_ORG=<sandbox org>`, then run `pnpm manifest`. Open the printed `http://127.0.0.1:3434` (`OSTRA_DEV_MANIFEST_PORT` to change it) in a browser signed in as an owner of the org, and click Create on GitHub. The App's ID, client secret, webhook secret and key path go to `~/.config/ostra-dev/github.env`, with the key as a `.pem` beside it, never in the repo. If `github.env` already exists, they go to `github-app-<id>.env` instead. A non-secret record of the conversion goes to `github-app-manifest-result.json`. The command prints the permission and event keys GitHub returned (research S6). It gives up after an hour. If the exchange fails, it exits non-zero. If GitHub made the App but the files can't be written, the one-time key goes to `github-app-<id>-recovered-<random>.pem`, and the command tells you to regenerate the client and webhook secrets on GitHub.
3. Install the App on **both** sandbox repos (the link is printed). The harness reads the other repo to prove nothing landed there, so it refuses to run if it can't. Install Linear's own GitHub app on the org for the last criterion.
4. Load the inputs, then run the spike again: `set -a; . ~/.config/ostra-dev/github.env; . ~/.config/ostra-dev/github-test.env; . ~/.config/ostra-dev/linear.env; set +a; pnpm spike`. `github-test.env` holds the sandbox's names: `GITHUB_TEST_ORG`, `GITHUB_TEST_REPO`, `GITHUB_TEST_OTHER_REPO`, `GITHUB_TEST_MEMBER_LOGIN` and `GITHUB_APP_INSTALLATION_ID`.

| Criterion | Inputs it needs |
|---|---|
| Manifest flow, on GitHub | `pnpm manifest` run once, then `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`, `GITHUB_TEST_ORG` |
| Clone, fetch and push; the refusals; the token on this host; token re-mint; LFS; shallow, on GitHub | the above, plus `GITHUB_TEST_REPO` and `GITHUB_TEST_OTHER_REPO`, the App installed on both. Optional: `GITHUB_APP_INSTALLATION_ID` |
| 500 MB pack, on GitHub | the above, plus `SPIKE_GITHUB_LARGE_PACK=1` (it pushes 500 MiB to the sandbox repo, in 50 MiB files under GitHub's 100 MB file limit) |
| Co-author | the App inputs, `GITHUB_TEST_REPO`, plus `GITHUB_TEST_MEMBER_LOGIN` (the member credited and treated as the task's driver) |
| Comment-type review with line comments | the App inputs and `GITHUB_TEST_REPO` |
| Check run flips on approval | the above, plus `GITHUB_TEST_MEMBER_LOGIN` and `GITHUB_TEST_REVIEWER_TOKEN`: a token of a second sandbox user, not the driver, who can approve. Optional: `GITHUB_WEBHOOK_SECRET` with `OSTRA_DEV_WEBHOOK_PORT`, and a tunnel from `OSTRA_DEV_PUBLIC_URL` to that port, to flip from the webhook instead of polling |
| Linear links the PR | the above, plus `LINEAR_API_KEY` and `LINEAR_TEST_TEAM_ID`, and Linear's GitHub app on the sandbox org. Optional: `LINEAR_API_URL` (default `https://api.linear.app/graphql`) |
| The token never appears in the agent's *container* | spike 3's box: the agent's container beside its sidecar, on Docker on Linux |

No model endpoint is used: this spike makes no model call, so `model.env` isn't needed. The run cleans up what it makes on GitHub (the PR is closed, the branches and the hidden ref are deleted, the Linear issue is archived), unless `SPIKE_KEEP=1`. A cleanup that fails is logged as `cleanup.failed` with the ref and the HTTP status, printed as `left behind: …` at the end, and fails the run.

## Status on 2026-11-18

**Against GitHub.** The runs used the sandbox org `ostra-test`, with `test1` as the task's repo and `test2` as the other repo, each holding one commit, a README. They ran as the test App `ostra-sandbox-036d7c` (app 5821041), installed on both. The machine is the same as for the local runs: Windows 11, Node 24.14.0, git 2.53.0.windows.1, git-lfs 3.7.1. Each run used `SPIKE_LARGE_PACK_MB=50`, and none had a reviewer token, Linear inputs or `SPIKE_GITHUB_LARGE_PACK`.

- **The first run** gave 9 PASS, 10 LOCAL-ONLY, 2 FAIL and 4 SKIPPED. LFS and shallow failed on GitHub. Both failures were bugs in the spike, and both are fixed (below). No check was loosened; the shallow checks are stricter now.
- **Two runs after the fixes** each gave **11 PASS, 10 LOCAL-ONLY, 0 FAIL, 4 SKIPPED** in 100 s, and exited 2. Verdict: **`pass bar: 1 of 5 bullets met on GitHub (4 with local-only evidence)`**.
- **The final run, after the review follow-ups,** gave the same: **11 PASS, 10 LOCAL-ONLY, 0 FAIL, 4 SKIPPED** in 102 s, exit 2, `pass bar: 1 of 5 bullets met on GitHub (4 with local-only evidence)`, with `SPIKE_LARGE_PACK_MB=50`. It ran the new mixed-object LFS probe on the stand-in (an upload on an allowed host and a verify on a hostile one: the object came back with the proxy's error, 0 actions, 0 called), and it recorded the LFS action hosts and `expires_in` on GitHub (see the limits). With a pack under 500 MiB, the large-pack row says the size pushed, and counts neither as local-only evidence nor as a PASS for bullet 3. The end of the run says that LFS objects stay in the sandbox repo's LFS storage. The cleanup deletes refs, PRs and issues only; see the LFS storage under the limits. `pnpm typecheck`, `pnpm lint` and `pnpm test` (16 tests) pass.
- **Which local figures come from which run.** The local figures in this file are from one of two sets. The *earlier 500 MiB runs* are the three runs with no GitHub inputs, made before the fixes: the pack figures under the limits, and the token row's file counts and sizes (528 files, 2,065 to 2,085 MiB). The *50 MiB runs after the fixes* are the local halves of today's runs against GitHub: the 50 MiB pack's push (2.2 to 2.3 s) and clone (4.6 to 5.4 s). Every other local row is a pass count, the same in both sets.
- **Earlier the same day,** three runs with no GitHub inputs gave 1 PASS, 10 LOCAL-ONLY, 0 FAIL and 14 SKIPPED each. Their 500 MiB pack figures are under the limits.

**The pass bar is not met.**

- Bullet 1 is met.
- Bullet 2 waits only on the agent's container, which is spike 3's box.
- Bullet 3 waits on the 500 MiB pack on GitHub.
- Bullet 4 waits on the check flip, which needs a second sandbox user's token.
- Bullet 5 waits on Linear.

**What failed, and the fixes:**

- **LFS: two proxy bugs.** GitHub showed them; the stand-in didn't.
  1. **Hosts outside the allowlist.** GitHub's upload batch answer points the `upload` action at `github-cloud.s3.amazonaws.com` and the `verify` action at `lfs.github.com`. Neither host was on the default allowlist, so the proxy dropped both actions and passed the object on with an empty `actions`. git-lfs reads that as "the server has it already". The push exited 0 with nothing uploaded, and only the clone failed: "Clone succeeded, but checkout failed", after the download batch answered `404 Object does not exist on the server`.
     - Fixed: both hosts are on the default list now, by exact name.
     - Fixed: an object with a refused action now gets a per-object error instead of an empty `actions`. The stand-in's probe checks this too.
  2. **No `User-Agent`.** With the hosts allowed, the S3 upload went through (200). GitHub then refused the verify three times (git-lfs retries) with a 403. The proxy sent the action's own headers plus `content-type`, `content-length` and `accept`, but no `User-Agent`, and Node's `http.request` adds none. lfs.github.com answers a request with no `User-Agent` with `403 Request forbidden by administrative rules. Please make sure your request has a User-Agent header`. Replaying the same verify action outside the proxy reproduced it: 403 without the header, 200 with git-lfs's (observed by a manual probe on 2026-11-18, not by the harness).
     - Fixed: the proxy passes git-lfs's `User-Agent` on to LFS actions, the batch and the lock check.
     - Fixed: the stand-in now refuses a request without a `User-Agent`, as GitHub does. With the proxy fix taken out again, the local LFS push fails too.
- **Shallow: a harness bug.** The shallow clone was of the default branch, which in `test1` is one root commit. A `--depth 1` clone of a one-commit history is complete, so git writes no `.git/shallow`, and `fetch --unshallow` stops with `fatal: --unshallow on a complete repository does not make sense`. The "1 commit" check had passed only because the history was one commit long.
  - Fixed: the shallow clones are of the task's branch, which has 4 commits on GitHub by then (6 locally).
  - Fixed: each step now checks `git rev-parse --is-shallow-repository` and counts its commits against a full clone. After the clone: 1 commit, shallow. After `--deepen 1`: 2 commits. After `--unshallow`: the full count, not shallow.

| Part of the pass bar | Local stand-in | GitHub, 2026-11-18 (the two runs after the fixes) |
|---|---|---|
| The manifest flow creates the App from a local server, with the v1 permissions, `checks: write` among them | **LOCAL-ONLY**, mechanics only, against a stub conversion endpoint, so no App was created. Covered: the page, the random state, a wrong state refused, one exchange, no second run, the files outside the repo, no secret in the pages, a failed exchange ends the command with an error, and a failed store saves the one-time key to a fallback file | **PASS**. The harness authenticates as app 5821041, the App `pnpm manifest` created. GitHub reports every v1 permission: `actions:read`, `checks:write`, `contents:write`, `issues:read`, `metadata:read`, `pull_requests:write`, `statuses:read`. It reports no events, since a manifest with no public URL has no webhook. GitHub refused two things on the way, both fixed in commit 7a2d2b2 (`src/github/manifest.ts`): `email_addresses` ("Default permission records resource is not included in the list"), and a webhook URL on 127.0.0.1, even with `active: false` |
| Stock git clones, fetches and pushes the task's branch | **LOCAL-ONLY**: clone and fetch on protocol v2 and v0, a push, and a fetch after another clone's push | **PASS**: a clone on protocol v2 (896 to 962 ms) and on v0 (475 to 518 ms), a push of the task's branch (1.3 to 1.7 s), a fetch after another clone's push, and a fetch on v0 |
| (Not in the pass bar) the hidden ref `refs/ostra/wip/<task>` pushes | **LOCAL-ONLY** | **PASS**: GitHub accepts the push, and the ref reads back with the pushed commit. Whether it starts CI is spike 2's question |
| A push to the default branch, a delete and a push to another repo are refused before a byte reaches GitHub | **LOCAL-ONLY**: 12 refusals. A push and a history-rewriting force push to the default branch; deletes of the task's branch, of the hidden ref and of the default branch; a push to and a clone of another repo; a tag; `<branch>-evil`; the branch in other case; a mixed push, refused whole; a push through the read-only proxy. Each one had git printing the proxy's own refusal, the proxy's refusal counter moving by exactly 1, no `receive-pack` forwarded, and its target ref the same before and after. The stand-in's own counters show 0 `receive-pack` requests, and no request at all for the other repo. The agent's own `Authorization` header is dropped | **PASS**: the same 12 refusals, with the same evidence for each. The refs were read through GitHub's API before and after. GitHub's activity log (`GET /repos/{owner}/{repo}/activity`, readable with a `contents: read` installation token) shows only the allowed push made after the refusals, and nothing in the other repo. The agent's own `Authorization` header is dropped |
| The token never appears in the agent's container | **LOCAL-ONLY**, for the agent's git on this host only. In the earlier 500 MiB runs: 0 hits in 528 files (2,065 to 2,085 MiB: both agent worlds, the 500 MiB pack's included, with git config, LFS store and traces with redaction off), across 30 needles (5 forms of every credential, against 520-character `ghs_` tokens). Also 0 hits in 144 output streams, in the environment (21 allowlisted variables) and in 138 proxy log records. Every Host header git and git-lfs sent was a proxy | **PASS**, for the agent's git on this host only, in the 50 MiB runs after the fixes. 0 hits in 418 files (52.5 to 73.1 MiB: the main agent world, with git config, the LFS store and traces with redaction off), across 24 needles: every form of the real installation tokens, which are 390 characters long. Also 0 hits in 152 output streams, in the environment (21 allowlisted variables) and in 256 proxy log records. Every Host header git and git-lfs sent was a proxy's. **The container itself: SKIPPED**, it needs spike 3's box (Docker on Linux) |
| (Not in the pass bar) git keeps working across a token re-mint | **LOCAL-ONLY**: clone, fetch and push through a proxy whose provider re-minted twice: 3 tokens minted, and 3 distinct tokens accepted upstream. An expired token is refused upstream, and git shows the proxy's message rather than prompting | **PASS**: clone, fetch and push through a proxy whose provider re-minted real installation tokens twice: 3 tokens minted. The expired-token case runs on the stand-in only, since the harness can't make an expired real token |
| LFS | **LOCAL-ONLY**: a 3 MiB object pushed (1 batch, 2 actions: upload and verify) and downloaded on clone, content checked. Of 9 offered actions that pointed outside the upstream, 1 was kept (GitHub's storage host). 8 were refused (IPs, `localhost`, `http`, port 8443, look-alike hosts), each object with the proxy's error, and none was called. A mixed object, with its upload on an allowed host and its verify on a hostile one, got the proxy's error and no actions, and nothing was called (the final run) | **PASS**, after the fixes above. A 3 MiB object was pushed through the proxy (1 batch, 2 actions: the S3 upload and the verify on `lfs.github.com`), then downloaded on clone from `github-cloud.githubusercontent.com`, and its content checked. The probe of hostile action URLs runs on the stand-in only, since GitHub's answers can't be made to point elsewhere |
| A shallow clone | **LOCAL-ONLY**: `--depth 1` on v2 and v0 (1 of 6 commits, shallow), `--deepen 1` (2 commits), a push of the task's branch from a shallow clone, and `--unshallow` (6 of 6, not shallow). Also recorded: `--filter=blob:none` works | **PASS**, after the fix above: `--depth 1` on v2 and v0 (1 of 4 commits, shallow), `--deepen 1` (2 commits), a push of the task's branch from a shallow clone, and `--unshallow` (4 of 4, not shallow). Also recorded: `--filter=blob:none` works |
| A 500 MB pack | **LOCAL-ONLY** at 500 MiB in the earlier runs (see the limits below). In the 50 MiB runs after the fixes it is labelled a 50 MiB pack and is no evidence for bullet 3 | SKIPPED: needs `SPIKE_GITHUB_LARGE_PACK=1` |
| A PR the App opened with a co-author trailer shows the member as co-author | not applicable | **PASS**. The App opened the PR as `ostra-sandbox-036d7c[bot]` (#3, then #4). GraphQL `Commit.authors` resolves the commit's authors to two users: the bot, and the member named in the `Co-authored-by` trailer by their `<id>+<login>@users.noreply.github.com` address |
| The App can post a comment-type review with line comments on its own PR | not applicable | **PASS**: the App's `COMMENT` review on its own PR reads back as `COMMENTED`, with 2 of 2 line comments |
| A check run flips when someone approves | **LOCAL-ONLY**, logic only, with no check run involved: 8 cases of the approver ≠ driver rule (the driver, the bot, a stale commit, a withdrawn approval, a later comment, case), and the webhook signature accepted, forged and missing | SKIPPED: needs `GITHUB_TEST_REVIEWER_TOKEN` |
| Linear's GitHub integration links a PR the App opened | not applicable | SKIPPED: needs `LINEAR_API_KEY`, `LINEAR_TEST_TEAM_ID`, and Linear's GitHub app on the org |
| (Harness) no process or server left after the run | **PASS** in every run: 0 tracked children alive at the end, 0 servers listening, and 0 stray processes in the OS's own process list (descendants of the harness, or any command line naming the scratch directory or the stub) | n/a: the same runs |

### Limits as measured, 2026-11-18

The pass bar asks for the limits to be written down.

**The local stand-in, on this machine,** from the earlier 500 MiB runs: the three runs with no GitHub inputs, made before the fixes. The runs against GitHub, after the fixes, used a 50 MiB pack locally: its push took 2.2 to 2.3 s and its clone 4.6 to 5.4 s.

| What | The earlier 500 MiB runs (three) |
|---|---|
| The 500 MiB pack (incompressible data, 10 files of 50 MiB) | 500.2 MiB forwarded upstream on every run |
| Its push through the proxy | 42.3 to 47.7 s (10.5 to 11.8 MiB/s) |
| Its clone through the proxy | 503.3 MiB in 75.2 to 78.0 s |
| The same clone straight from the stand-in, without the proxy | 73.8 to 74.9 s |
| What the proxy adds to the clone | 1.4 to 4.1 s (2 to 5 %). Each run's gap is larger than the spread of the direct clones, so the overhead is small but measurable. git's packing and indexing set the pace |
| Peak RSS of the harness process, which hosts the proxy | 106.6 to 157.1 MiB, +7.6 to +69.1 MiB over the start of the push. Under the 200 MiB bound, so the pack streams, but the number includes the harness's own buffers and varies run to run |
| A refused push's body | drained up to 4 GiB so git can read the answer; cut past that |

**GitHub, as found against `ostra-test`:**

| What | Found |
|---|---|
| Where GitHub sends LFS transfers | `upload`: `github-cloud.s3.amazonaws.com`, `expires_in` 900 s. `verify`: `lfs.github.com`, with no `expires_in`. `download`: `github-cloud.githubusercontent.com`, `expires_in` 3600 s. The hosts and `expires_in` are recorded by the harness, from the proxy's log of the batch answers in the final run (host names only, never a URL). The header names are not: the upload's signed headers (`Authorization`, `x-amz-content-sha256`, `x-amz-date`) and the verify's `Authorization: RemoteAuth …` (not the installation token) with `Accept` were *observed by a manual probe on 2026-11-18*. The proxy must allow these hosts, and nothing wider than the one S3 bucket |
| `User-Agent` | lfs.github.com refuses a request with none (403, "Request forbidden by administrative rules"): *observed by a manual probe on 2026-11-18*. The batch endpoint on github.com answered without one (the same probe), but the proxy passes it on everywhere. An action's own `User-Agent`, in any case, wins over the client's |
| LFS storage outlives the cleanup | The cleanup deletes refs, not LFS objects, so each run leaves its 3 MiB object in `test1`'s LFS storage, and the run's last line says so. There are now two verified 3 MiB objects from the passing runs, one 3 MiB upload whose verify failed, and two 64-byte objects from the probes that found the `User-Agent` cause. How GitHub counts them against the org's LFS quota, and how to remove them, wasn't checked |
| Installation tokens | 390 characters here. The stand-in's fake tokens are about 520, so they're the stricter case for the leak scan |
| A one-commit default branch | `--depth 1` of it is complete, not shallow, so a shallow test needs history: it uses the task's branch |
| Not measured on GitHub | the 500 MiB push (pack size limit, push timeout), LFS bandwidth and storage quota, and how far the activity log lags (the check uses the allowed push after the refusals as a positive control instead) |

### Observed on the runs

- **The refusal is answered after the body.** The proxy reads and drops the rest of a refused push before it answers, so that git reads the `report-status` and prints the reason. Answering early wasn't tried.
- **The empty probe.** A push over `http.postBuffer` (1 MiB) first sends an empty command list (`0000`). The proxy forwards it, since it updates no ref.
- **git-lfs honours the `insteadOf` rule** for its endpoint: all its requests went to the proxy, on GitHub too. It never reached S3, lfs.github.com or githubusercontent.com itself.
- **Case-insensitive refs on the stand-in.** On this NTFS volume, the bare repo resolves `refs/heads/OSTRA/<task>` to the task's own branch. The refusal checks compare refs before and after each step for that reason, rather than expecting them to be absent.
- **Octokit's request log prints paths.** For the manifest conversion, the path holds the one-time code, so that Octokit is built with a silent log.
- **A misleading message.** The proxy turns any upstream 401 or 403 into `ostra: GitHub refused the task's credential (status 403)`. For the verify, the credential was fine; the missing `User-Agent` was the cause. git-lfs printed only "Errors logged to …", and the proxy logs the status but not GitHub's reason. The cause was found by replaying the verify outside the proxy (a manual probe on 2026-11-18).

## What's left

- **The GitHub column, which is the gate.** Still open:
  - a 500 MiB push, under GitHub's limits (`SPIKE_GITHUB_LARGE_PACK=1`)
  - the check flip, which needs a second sandbox user and `GITHUB_TEST_REVIEWER_TOKEN`, and a real `pull_request_review` webhook (only polling and the local signature check have run)
  - Linear's integration linking the App's PR (`LINEAR_API_KEY`, `LINEAR_TEST_TEAM_ID`, Linear's GitHub app on the org)
  - LFS bandwidth and storage quota, and removing the LFS objects the runs leave
  - how far the activity log lags
- **Settled on GitHub on 2026-11-18:**
  - GitHub accepts the manifest without `email_addresses` and, with no public URL, without a webhook, and returns the permission keys above
  - GraphQL `Commit.authors` resolves the co-author's noreply address to the member
  - GitHub accepts a push to `refs/ostra/wip/*`
  - LFS works through GitHub's signed URLs, once `github-cloud.s3.amazonaws.com` and `lfs.github.com` are allowed and the `User-Agent` is passed on
  - the activity log is readable with a `contents: read` installation token
- **The agent's container.** The token check covers only the agent's git on this host: both of its worlds, the large pack's included. The same check from a shell in the agent's container, beside the sidecar, is spike 3's.
- **The proxy's address in a box.** The LFS URLs it hands out use its own listen address. In a box, they must use the address the agent reaches the sidecar by. The proxy has no per-task secret in its URL, because it relies on the box's network for that (spike 3).
- **Token expiry mid-stream.** Re-minting between requests is tested; a token that expires while a long push or clone is in flight isn't. On GitHub, that needs a transfer longer than the token's hour, or GitHub's answer to whether a token is checked only at the start of a request.
- **LFS hosts by name only.** The allowlist checks host names, not the addresses they resolve to, so a DNS answer pointing an allowed name at a private address isn't caught. A production proxy would pin the resolved address.
- **The upstream's reason for a refusal.** A production proxy should log the upstream's reason (without the body's content where it could carry a secret) and word its message by status, not blame the credential for every 403.
- **Not tried:** submodules on other repos (refused by design as "another repo"), and `.github/workflows/` changes without `workflows: write` (S7). `workflows` is left out of the manifest on purpose (`src/github/manifest.ts`), and so is `setup_url`, since the spike has no post-install page.
- **A known limit, by design:** a refused push's body is drained, so git can read the answer, up to 4 GiB. Past that, the connection is cut.
- **After the real runs:** write the findings to `context/research/`, with every claim cited, and set F-090, F-006, F-104 and F-030 as the results allow.

## Dependencies

Exact versions. Octokit and `zod` are allowed for this spike by answers §4.6 and ADR 0007, and `typescript` by the task. The ESLint packages are the versions the repo's own `eslint.config.js` already uses, all MIT, so that `pnpm lint` holds the spike to the repo's rules (the root config ignores `spikes/**`).

| Package | Version | License | For |
|---|---|---|---|
| `@octokit/rest` | 22.0.1 | MIT | REST and GraphQL calls: PRs, reviews, check runs, refs, activity, the manifest conversion |
| `@octokit/auth-app` | 8.3.1 | MIT | App JWTs and installation tokens narrowed to repos and permissions |
| `@octokit/webhooks-methods` | 6.0.0 | MIT | Verifying the `pull_request_review` webhook's signature |
| `zod` | 4.6.7 | MIT | The boundaries: env, the stub's config and start line, LFS JSON, the manifest conversion, GraphQL answers, GitHub's activity log, webhooks, Linear |
| `typescript` (dev) | 6.0.3 | Apache-2.0 | `pnpm typecheck`. 6.0.3, as at the repo root, because `typescript-eslint` 8.73 builds on it |
| `@types/node` (dev) | 24.19.2 | MIT | Node types |
| `eslint` (dev) | 10.15.0 | MIT | `pnpm lint` |
| `typescript-eslint` (dev) | 8.73.0 | MIT | `strict-type-checked` and `stylistic-type-checked` |
| `eslint-plugin-unicorn` (dev) | 80.0.0 | MIT | kebab-case file names, as at the root |

Octokit's typed REST responses (pulls, reviews, checks, refs, users) are used as typed, not parsed again with Zod. Linear is reached with `fetch` and Zod, without `@linear/sdk`. Tests use `node:test`, so the spike doesn't need Vitest. Node runs the `.ts` files directly, with its built-in type stripping, so `tsx` isn't needed either. git and git-lfs are system tools, not packages.
