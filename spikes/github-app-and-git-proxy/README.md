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
- **LFS.** The batch answer's `actions` (signed URLs and their `Authorization` headers) stay in the proxy under random nonces, with a TTL of at most 1 h. The agent gets `<proxy>/_ostra/lfs/<nonce>` instead, and the proxy forwards to the real URL with the real headers. An action is kept only when it points at the upstream's own origin, or at `https` on an allowlisted host: `github-cloud.githubusercontent.com` and `*.githubusercontent.com` by default, configurable for GitHub Enterprise Server (`lfsActionHosts`). IP literals, `localhost`, plain `http`, other ports, `user:pass@` and look-alike hosts are dropped.
- **`src/upstream-stub.ts`: the local stand-in for GitHub.** It's a Node smart-HTTP server over local bare repos, in its own process. It runs `git upload-pack/receive-pack --stateless-rpc` the way `git-http-backend` does, and serves an LFS server whose object URLs need their own `RemoteAuth` credential, like GitHub's. It counts every request.
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

A full run takes about 5 minutes on this machine, most of it the 500 MiB pack. `SPIKE_LARGE_PACK_MB=0` skips the pack, and `SPIKE_LARGE_PACK_MB=50` shrinks it. Sizes in the output are binary: 1 MiB = 1,048,576 bytes, so the "500 MB pack" of the pass bar is run as 500 MiB (524 MB). Scratch repos go to a temp directory that is removed at the end (`SPIKE_KEEP=1` keeps it). Ctrl-C kills every child process tree and removes the scratch directory. The last results are written to `.data/last-run.json`, which is gitignored.

### For the GitHub half

1. Create the sandbox org, and two repos in it, each with at least one commit: the task's repo and the "other" repo.
2. `export GITHUB_TEST_ORG=<sandbox org>`, then run `pnpm manifest`. Open the printed `http://127.0.0.1:3434` (`OSTRA_DEV_MANIFEST_PORT` to change it) in a browser signed in as an owner of the org, and click Create on GitHub. The App's ID, client secret, webhook secret and key path go to `~/.config/ostra-dev/github.env`, with the key as a `.pem` beside it, never in the repo. If `github.env` already exists, they go to `github-app-<id>.env` instead. A non-secret record of the conversion goes to `github-app-manifest-result.json`. The command prints the permission and event keys GitHub returned (research S6). It gives up after an hour. If the exchange fails, it exits non-zero. If GitHub made the App but the files can't be written, the one-time key goes to `github-app-<id>-recovered-<random>.pem`, and the command tells you to regenerate the client and webhook secrets on GitHub.
3. Install the App on **both** sandbox repos (the link is printed). The harness reads the other repo to prove nothing landed there, so it refuses to run if it can't. Install Linear's own GitHub app on the org for the last criterion.
4. Load the inputs, then run the spike again: `set -a; . ~/.config/ostra-dev/github.env; . ~/.config/ostra-dev/linear.env; set +a; pnpm spike`.

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

Three full runs of `pnpm spike` on this machine (Windows 11, Node 24.14.0, git 2.53.0.windows.1, git-lfs 3.7.1), with no GitHub or Linear inputs. Each run gave **1 PASS, 10 LOCAL-ONLY, 0 FAIL, 14 SKIPPED**, in 221 to 232 s, and exited 2. Verdict: **`pass bar: 0 of 5 bullets met on GitHub (4 with local-only evidence)`**. Bullet 5, Linear, has no local evidence at all. `pnpm typecheck`, `pnpm lint` and `pnpm test` (15 tests) pass.

**The pass bar is not met.** Every bullet names GitHub, and no GitHub run has happened. The local column is evidence that the design works, not that the criterion holds.

| Part of the pass bar | Local stand-in | GitHub |
|---|---|---|
| The manifest flow creates the App from a local server, with the v1 permissions, `checks: write` among them | **LOCAL-ONLY**, mechanics only, against a stub conversion endpoint, so no App was created. Covered: the page, the random state, a wrong state refused, one exchange, no second run, the files outside the repo, no secret in the pages, a failed exchange ends the command with an error, and a failed store saves the one-time key to a fallback file | SKIPPED: `pnpm manifest`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`, `GITHUB_TEST_ORG` |
| Stock git clones, fetches and pushes the task's branch | **LOCAL-ONLY**: clone and fetch on protocol v2 and v0, a push, and a fetch after another clone's push | SKIPPED: the App inputs, `GITHUB_TEST_REPO`, `GITHUB_TEST_OTHER_REPO` |
| (Not in the pass bar) the hidden ref `refs/ostra/wip/<task>` pushes | **LOCAL-ONLY** | SKIPPED, same inputs |
| A push to the default branch, a delete and a push to another repo are refused before a byte reaches GitHub | **LOCAL-ONLY**: 12 refusals. A push and a history-rewriting force push to the default branch; deletes of the task's branch, of the hidden ref and of the default branch; a push to and a clone of another repo; a tag; `<branch>-evil`; the branch in other case; a mixed push, refused whole; a push through the read-only proxy. Each one had git printing the proxy's own refusal, the proxy's refusal counter moving by exactly 1, no `receive-pack` forwarded, and its target ref the same before and after. The stand-in's own counters show 0 `receive-pack` requests, and no request at all for the other repo. The agent's own `Authorization` header is dropped | SKIPPED, same inputs. There, GitHub's activity log is read too |
| The token never appears in the agent's container | **LOCAL-ONLY**, for the agent's git on this host only: 0 hits in 528 files (2,065 to 2,085 MiB: both agent worlds, the 500 MiB pack's included, with git config, LFS store and traces with redaction off), across 30 needles (5 forms of every credential, against 520-character `ghs_` tokens). Also 0 hits in 144 output streams, in the environment (21 allowlisted variables) and in 138 proxy log records. Every Host header git and git-lfs sent was a proxy | SKIPPED, same inputs. **The container itself: SKIPPED**, it needs spike 3's box (Docker on Linux) |
| (Not in the pass bar) git keeps working across a token re-mint | **LOCAL-ONLY**: clone, fetch and push through a proxy whose provider re-minted twice: 3 tokens minted, and 3 distinct tokens accepted upstream. An expired token is refused upstream, and git shows the proxy's message rather than prompting | SKIPPED, same inputs |
| LFS | **LOCAL-ONLY**: a 3 MiB object pushed (1 batch, 2 actions: upload and verify) and downloaded on clone, content checked. Of 9 offered actions that pointed outside the upstream, 1 was kept (GitHub's storage host), 8 were dropped (IPs, `localhost`, `http`, port 8443, look-alike hosts), and none was called | SKIPPED, same inputs |
| A shallow clone | **LOCAL-ONLY**: `--depth 1` on v2 and v0, `--deepen 1`, a push of the task's branch from a shallow clone, `--unshallow`. Also recorded: `--filter=blob:none` works | SKIPPED, same inputs |
| A 500 MB pack | **LOCAL-ONLY**: see the limits below | SKIPPED: also needs `SPIKE_GITHUB_LARGE_PACK=1` |
| A PR the App opened with a co-author trailer shows the member as co-author | not applicable | SKIPPED: the App inputs, `GITHUB_TEST_REPO`, `GITHUB_TEST_MEMBER_LOGIN` |
| The App can post a comment-type review with line comments on its own PR | not applicable | SKIPPED: the App inputs, `GITHUB_TEST_REPO` |
| A check run flips when someone approves | **LOCAL-ONLY**, logic only, with no check run involved: 8 cases of the approver ≠ driver rule (the driver, the bot, a stale commit, a withdrawn approval, a later comment, case), and the webhook signature accepted, forged and missing | SKIPPED: also `GITHUB_TEST_MEMBER_LOGIN`, `GITHUB_TEST_REVIEWER_TOKEN` |
| Linear's GitHub integration links a PR the App opened | not applicable | SKIPPED: also `LINEAR_API_KEY`, `LINEAR_TEST_TEAM_ID`, and Linear's GitHub app on the org |
| (Harness) no process or server left after the run | **PASS** in all three runs: 0 tracked children alive at the end, 0 servers listening, and 0 stray processes in the OS's own process list (descendants of the harness, or any command line naming the scratch directory or the stub) | n/a |

### Limits as measured, 2026-11-18, local stand-in only

The pass bar asks for the limits to be written down. These are the stand-in's, on this machine. GitHub's own limits (pack size, LFS quota, push timeouts) are not measured yet.

| What | Three runs |
|---|---|
| The 500 MiB pack (incompressible data, 10 files of 50 MiB) | 500.2 MiB forwarded upstream on every run |
| Its push through the proxy | 42.3 to 47.7 s (10.5 to 11.8 MiB/s) |
| Its clone through the proxy | 503.3 MiB in 75.2 to 78.0 s |
| The same clone straight from the stand-in, without the proxy | 73.8 to 74.9 s |
| What the proxy adds to the clone | 1.4 to 4.1 s (2 to 5 %). Each run's gap is larger than the spread of the direct clones, so the overhead is small but measurable. git's packing and indexing set the pace |
| Peak RSS of the harness process, which hosts the proxy | 106.6 to 157.1 MiB, +7.6 to +69.1 MiB over the start of the push. Under the 200 MiB bound, so the pack streams, but the number includes the harness's own buffers and varies run to run |
| A refused push's body | drained up to 4 GiB so git can read the answer; cut past that |

### Observed on the local runs

- **The refusal is answered after the body.** The proxy reads and drops the rest of a refused push before it answers, so that git reads the `report-status` and prints the reason. Answering early wasn't tried.
- **The empty probe.** A push over `http.postBuffer` (1 MiB) first sends an empty command list (`0000`). The proxy forwards it, since it updates no ref.
- **git-lfs honours the `insteadOf` rule** for its endpoint: all its requests went to the proxy.
- **Case-insensitive refs on the stand-in.** On this NTFS volume, the bare repo resolves `refs/heads/OSTRA/<task>` to the task's own branch. The refusal checks compare refs before and after each step for that reason, rather than expecting them to be absent.
- **Octokit's request log prints paths.** For the manifest conversion, the path holds the one-time code, so that Octokit is built with a silent log.

## What's left

- **The GitHub column, which is the gate.** Every bullet waits on the sandbox org, two repos, the App (through `pnpm manifest`), a second sandbox user, and Linear's GitHub app. Only the real run settles these:
  - whether GitHub accepts a manifest with `hook_attributes.active: false`, `callback_urls`, and these exact permission keys, `email_addresses` and `statuses` among them (`research/platform-auth-github.md` S6). The run prints the keys GitHub returns.
  - whether `GraphQL Commit.authors` resolves the co-author's noreply address
  - whether GitHub accepts a push to `refs/ostra/wip/*`
  - LFS through GitHub's signed storage URLs, whether they fall inside the default host allowlist, and LFS bandwidth quota
  - a 500 MiB push, under GitHub's limits
  - whether GitHub's repository activity log (`GET /repos/{owner}/{repo}/activity`) is readable with a `contents: read` installation token, and how far it lags
  - the check flip from a real `pull_request_review` webhook. Only polling and the local signature check have run.
- **The agent's container.** The token check covers only the agent's git on this host: both of its worlds, the large pack's included. The same check from a shell in the agent's container, beside the sidecar, is spike 3's.
- **The proxy's address in a box.** The LFS URLs it hands out use its own listen address. In a box, they must use the address the agent reaches the sidecar by. The proxy has no per-task secret in its URL, because it relies on the box's network for that (spike 3).
- **Token expiry mid-stream.** Re-minting between requests is tested; a token that expires while a long push or clone is in flight isn't. On GitHub, that needs a transfer longer than the token's hour, or GitHub's answer to whether a token is checked only at the start of a request.
- **LFS hosts by name only.** The allowlist checks host names, not the addresses they resolve to, so a DNS answer pointing an allowed name at a private address isn't caught. A production proxy would pin the resolved address.
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
