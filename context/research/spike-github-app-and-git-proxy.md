# Research: Spike 4, `github-app-and-git-proxy`: the GitHub App and the git proxy

**Status:** Research, 2026-11-18, rewritten after the runs against real GitHub. Feeds ADR 0030 (no credential enters the agent's container), ADR 0040 (the GitHub App opens every PR), ADR 0039 (idle boxes, hidden refs and session archives), ADR 0031 (the safety minimum), Q26, Q41 and Q55, and F-006, F-030, F-060, F-090, F-104 and F-119.
**Method:**
- I ran `pnpm spike` in `spikes/github-app-and-git-proxy/` on 2026-11-18 with `github.env` and `github-test.env` from `~/.config/ostra-dev/` loaded, and `SPIKE_LARGE_PACK_MB=50`. It ended at 18:39:26Z (the `at` stamp of its results file) and took 101 s. The sandbox is the org `ostra-test`, with the App `ostra-sandbox-036d7c` (app 5821041) installed on both test repos (`SPIKE/README.md:95`; the run's own row, `RUN[manifest, GitHub]`: "app 5821041"). I did not load `linear.env`, and no run input held a reviewer token or `SPIKE_GITHUB_LARGE_PACK`. The machine runs Windows 11, Node 24.14.0, pnpm 11.28.2, git 2.53.0.windows.1 and git-lfs 3.7.1 (checked again with `--version` calls on 2026-11-18). The run is the one below called "today's run".
- The results file the harness writes at the end of a run, `SPIKE/.data/last-run.json` (written at `SPIKE/src/harness/spike.ts:390-393`), now holds this run. It replaced the file of the earlier stand-in-only run that the first version of this file reported. That run's figures are not cited here. Three older stand-in-only runs, at the full 500 MiB, left their console logs in `SPIKE/.data/run-1.txt`, `run-2.txt` and `run-3.txt` (all exit 2, `run-exits.txt`), and the 500 MiB figures below come from those.
- Today's summary, from the console and the file's rows: **11 PASS, 10 LOCAL-ONLY, 0 FAIL, 4 SKIPPED**, `pass bar: 1 of 5 bullets met on GitHub (4 with local-only evidence)`, exit 2 (`spike.ts:381-399`). The 11 PASS are 10 GitHub rows and the process check. The 4 SKIPPED are the agent's container, the 500 MiB pack on GitHub, the check flip and Linear.
- **What I did not reproduce.** The first GitHub run had 2 FAILs (LFS and shallow). Both are fixed, and that run's output isn't kept. What I know of the failures comes from the README (`SPIKE/README.md:97,113-122`), from comments the fixes left in the code, and from today's passing run. The manual probe of lfs.github.com (`SPIKE/README.md:117,162,175`) was the README's, not the harness's, and I didn't repeat it. The manifest flow ran earlier in a browser. Today's run only reads back what it made (`SPIKE/src/harness/spike.ts:191-212`).
- I read the spike's README, code and tests as they stand in the working tree (4,994 lines of `.ts` under `src/` and `test/`). The working tree is ahead of the latest commit, `f8c5b2b` ("fix LFS and shallow on real GitHub"): five spike files (the README, `git-proxy.ts`, `git-scenarios.ts`, `spike.ts`, `upstream-stub.ts`) hold changes not yet committed, so every line number below is the working tree's.
- `pnpm spike` doesn't run the spike's own checks (`SPIKE/package.json:15`). I ran them in the spike's folder on 2026-11-18: `pnpm test` passes 16 of 16 (4 test files in `SPIKE/test/`), and `pnpm typecheck` and `pnpm lint` both exit 0. That agrees with the README (`SPIKE/README.md:99`).
- I read the official docs of GitHub, git, git-lfs and Linear on 2026-11-18 (links inline). For `url.<base>.insteadOf` and `http.postBuffer` I read the git-config manual that ships with the installed git 2.53.0, the page at https://git-scm.com/docs/git-config.
- Anything I couldn't confirm against a primary source is marked **unverified**. "Inferred" means I read the code or docs and didn't run it.
- After the run, the harness's own last row reported 0 tracked children, 0 listening servers and 0 stray processes, and the run's last line reported no refs, PRs or issues left on GitHub or Linear (`RUN[processes]`; the console, "left behind on GitHub or Linear: no refs, PRs or issues"). LFS objects are the exception (Section 4, item 5).

**Source links.**
- `SPIKE` means `spikes/github-app-and-git-proxy`. A cite like `SPIKE/src/git-proxy.ts:34-44` is a file and its lines.
- `RUN[part, where]` means the row of that part in today's run, by its `part` name and `where` in `SPIKE/.data/last-run.json`. `where` is "GitHub" or "local stand-in". `RUN[git, GitHub]` is the GitHub row of `git`. The part names, and the pass-bar words each stands for, are in `SPIKE/src/harness/spike.ts:66-94`.
- `RUN500[n]` means `SPIKE/.data/run-n.txt`, one of the three older stand-in-only runs at 500 MiB.
- `README` means `SPIKE/README.md`.
- `PASSBAR` means the spike's pass bar in `context/build-order.md`, lines 118-127.

---

## Facts (checked 2026-11-18)

| Thing | Version | License | Note | Source |
|---|---|---|---|---|
| git, git-lfs, Node, pnpm | 2.53.0.windows.1, 3.7.1, 24.14.0, 11.28.2 | n/a | the machine's own, run on Windows 11 | `git --version`, `git lfs version`, `node --version`, `pnpm --version`, today |
| `@octokit/rest`, `@octokit/auth-app`, `@octokit/webhooks-methods` | 22.0.1, 8.3.1, 6.0.0 | MIT | exact pins; the GitHub half only | `SPIKE/package.json:20-22`; versions and licenses read from `SPIKE/node_modules/<package>/package.json` on 2026-11-18, which match the README's table (`SPIKE/README.md:204-214`) |
| `zod` | 4.6.7 | MIT | the boundaries (env, LFS JSON, the conversion, webhooks, Linear) | `SPIKE/package.json:23`; the same `node_modules` read |
| TypeScript | 6.0.3 | Apache-2.0 | the same as the repo root | `SPIKE/package.json:29`; the repo's root `package.json:25` pins 6.0.3 too |
| The proxy and the stand-in | none of their own | n/a | Node's `http` and `https`, no HTTP framework; `zod` checks the LFS JSON | `SPIKE/src/git-proxy.ts:1-8`; `SPIKE/src/upstream-stub.ts:1-12` |
| GitHub installation token, as seen | 390 characters | n/a | the real tokens of today's run. The earlier research expects about 520 | `RUN` metrics, `github.credentialLengths` "390-390"; `context/research/platform-auth-github.md:314` |

---

## 1. The question, and the answer

**Question.** Can the GitHub App and a git proxy in the box's sidecar carry all of a task's work on GitHub? That means: the App is created from a local manifest server, stock git clones, fetches and pushes only the task's refs while no token reaches the agent, LFS, a shallow clone and a 500 MB pack work, the App opens a PR with a co-author, reviews it and flips a check on approval, and Linear links the PR (`PASSBAR`). It tests Q26, Q41 and Q55, which ADR 0030 (settles Q26 and Q41) and ADR 0040 (settles Q55 and the authorship part of Q41) wrote down (`context/decisions/0030-no-credential-enters-the-agents-container.md:3`; `context/decisions/0040-the-github-app-opens-every-pr.md:3`). Each ADR names this spike as its test (`0030-no-credential-enters-the-agents-container.md:58`; `0040-the-github-app-opens-every-pr.md:23`).

**Answer.** The proxy and the App work on GitHub. The pass bar is not yet met: **1 of 5 bullets**, and nothing failed (`RUN` verdicts). The bar says it needs four more inputs, and none of them is a defect:
- **Bullet 1, the manifest flow: met.** The App exists, and GitHub reports every v1 permission, `checks: write` among them.
- **Bullet 2 waits on the agent's container only.** On GitHub, stock git cloned, fetched and pushed the task's branch and its hidden ref. 12 pushes and fetches were refused, with git printing the proxy's own reason, with no `receive-pack` request forwarded, and with GitHub's own activity log showing only the allowed push. 0 hits for any credential turned up in 418 files and 73.1 MiB of the agent's side. The container is spike 3's box, which needs Docker on Linux.
- **Bullet 3 waits on the 500 MiB pack on GitHub.** LFS and shallow clones pass on GitHub, after two fixes (Section 3, Gotchas 1 and 2). The pack needs `SPIKE_GITHUB_LARGE_PACK=1`, which pushes 500 MiB to the test repo.
- **Bullet 4 waits on the check flip.** The co-author and the comment-type review with 2 line comments pass on GitHub. The check flip needs a second sandbox user's token.
- **Bullet 5 waits on Linear.** Nothing was run.

The two FAILs of the first GitHub run were both the spike's own bugs, in the proxy's LFS handling and in the harness's shallow test (Section 3). Nothing about GitHub made the design fail. ADR 0030's fallback (the sidecar pushes from its own clean clone) is not triggered by anything seen so far. It is not retired either: the 500 MiB push on GitHub and the container are open.

---

## 2. Results per pass-bar criterion

`PASSBAR` is five bullets. The harness splits them into 12 parts, plus two parts that are not in the bar (the hidden ref and a token re-mint) and two harness rows, no process left and nothing left behind on GitHub or Linear (`SPIKE/src/harness/spike.ts:66-94`). The second harness row is written only when it fails (`spike.ts:349-351`). It counts a bullet as met only when every one of its parts has a PASS on GitHub, and the token bullet also needs a PASS from the agent's container (`spike.ts:96-117,366-380`). A pass on the stand-in is `LOCAL-ONLY`: evidence for the design, never for the criterion, because every bullet names GitHub (`spike.ts:17-24,144`). I use the same rule. A 50 MiB pack is short of the 500 MiB the bar names, so it counts as no evidence for bullet 3, local-only or not (`spike.ts:129-132,373`).

| # | Pass-bar bullet | Result on GitHub | What it waits on |
|---|---|---|---|
| 1 | The manifest flow creates the App from a local server, with the permissions v1 needs | **MET** | nothing. The local rows (10 of 10) are mechanics against a stub |
| 2 | Stock git clones, fetches and pushes the task's branch; a default-branch push, a delete and a push to another repo are refused before a byte reaches GitHub; the token never appears in the agent's container | **NOT MET**: `git`, `refusals`, `token` PASS; the container SKIPPED | spike 3's box: the agent's container beside its sidecar, on Docker on Linux |
| 3 | LFS, a shallow clone and a 500 MB pack work, or their limits are written down | **NOT MET**: `lfs`, `shallow` PASS; the pack SKIPPED | `SPIKE_GITHUB_LARGE_PACK=1` |
| 4 | A co-author shows; a comment-type review with line comments; a check run flips on approval | **NOT MET**: `co-author`, `review` PASS; `check` SKIPPED | `GITHUB_TEST_REVIEWER_TOKEN`, a second sandbox user |
| 5 | Linear's GitHub integration links a PR the App opened | **NOT MET**: SKIPPED | `linear.env` loaded with a `LINEAR_TEST_TEAM_ID`, and Linear's GitHub app on the org |

Source for every row, result and count: `RUN` and its `verdicts`, the rows named below.

**1. The manifest flow: PASS on GitHub.**
- `RUN[manifest, GitHub]`, 4 of 4 checks:
  - the App the harness authenticates as is the one the manifest flow created: app 5821041. The harness reads the flow's result record, `github-app-manifest-result.json` (`SPIKE/src/harness/spike.ts:193-202`), then calls `GET /app`.
  - GitHub reports every v1 permission, `checks: write` among them.
  - the keys GitHub returned, recorded: `actions:read, checks:write, contents:write, issues:read, metadata:read, pull_requests:write, statuses:read`.
  - the events GitHub returned, recorded: none. A manifest with no public URL has no webhook.
- **GitHub refused two things on the way, and the manifest was fixed** (commit `7a2d2b2`, per the README at `SPIKE/README.md:126`; I didn't see the refusals, so this is the code's own record):
  - `email_addresses`: "Default permission records resource is not included in the list" (comment at `SPIKE/src/github/manifest.ts:18-21`). The key is out of the manifest now (`manifest.ts:30-38`).
  - a webhook URL on `127.0.0.1`, even with `active: false`: "Hook url is not supported because it isn't reachable over the public Internet" (`manifest.ts:60-64`). With no public URL the manifest now carries no webhook and no events (`manifest.ts:65-76`).
- Not an open point any more: GitHub accepted a manifest whose `redirect_url` is on the local server. The App exists, so the flow completed against a plain-`http` loopback address (inferred from the redirect URL the manifest carries, `manifest.ts:71`, and the App's existence in `RUN[manifest, GitHub]`).
- `RUN[manifest, local stand-in]`, LOCAL-ONLY, 10 of 10 checks:
  - the local page posts a manifest to the org's "new App" form, with a random state of at least 32 characters
  - the manifest asks for the v1 permissions (`manifest.ts:30-38`)
  - a callback with the wrong state is refused with 400 and no exchange happens
  - the right state exchanges the code once, and a second try gets 410
  - the key, an env file and a non-secret result land in the config directory, outside the repo (`SPIKE/src/github/manifest-store.ts:22-40`)
  - no secret shows in the pages
  - a failed exchange ends the setup with an error (502), where it could have waited
  - when the credentials can't be written, the one-time key goes to a fallback file and the setup ends with an error
- **Scope of the local rows.** The conversion endpoint was a stub, so no App was created (`SPIKE/src/harness/manifest-local.ts:18-23`). The stub answers with the permissions the manifest asked for (`manifest-local.ts:102`). So the local permission check shows what the manifest asks for. The GitHub row is what GitHub grants.
- What GitHub documents: all three steps of the flow must finish within one hour, the conversion returns `id`, `pem` and `webhook_secret`, and the permission object "uses the permission name for the key (for example, `issues`)" ([GitHub: registering a GitHub App from a manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)). The command gives up after an hour (`SPIKE/src/github/manifest-cli.ts:11`).

**2. Clone, fetch, push, the refusals and the token: PASS on GitHub, container SKIPPED.**
- **Clone, fetch and push: PASS, 5 of 5** (`RUN[git, GitHub]`). A clone on protocol v2 (1,036 ms) and on v0 (474 ms), a push of the task's branch with the upstream ref matching (1,877 ms), a fetch after another clone's push (569 ms) and a fetch on v0 (255 ms). The same 5 checks are LOCAL-ONLY on the stand-in (`RUN[git, local stand-in]`).
- **The hidden ref: PASS** (`RUN[hidden-ref, GitHub]`, not in the bar). GitHub accepts a push to `refs/ostra/wip/<task>` through the proxy, and the ref reads back with the pushed commit. Whether GitHub starts CI for it is spike 2's question (`RUN` note: "spike 2 checks that GitHub starts no CI for it"; `context/decisions/0039-idle-boxes-hidden-refs-and-session-archives.md:38`).
- **The refusals: PASS, 18 of 18** (`RUN[refusals, GitHub]`; the stand-in's 18 are LOCAL-ONLY). Twelve steps were refused: a push to the default branch, a history-rewriting force push to it, deletes of the task's branch, of the hidden ref and of the default branch, a push to another repo, a clone of another repo, a tag, `<branch>-evil`, the branch in other case, a mixed push of the task's branch with the default branch (refused whole), and a push through the read-only proxy that refine and review tasks get.
  - A step counts only with the proxy's own evidence. On GitHub, git printed the proxy's refusal word for word, for example `[remote rejected] HEAD -> main (ostra: only the task's branches and its hidden ref can be pushed)`, or for another repo `ostra: this task's proxy serves only its own repo`. The proxy's refusal counters moved by exactly this refusal. No `receive-pack` request was forwarded (the proxy's own counter: "0 forwarded"). The target ref read the same before and after, read through GitHub's API (`SPIKE/src/harness/git-scenarios.ts:163-212`).
  - **GitHub's own record agrees.** The activity log, `GET /repos/{owner}/{repo}/activity`, showed since the refusals began only the allowed push made right after them, "0 other entries (none), 0 in the other repo" (`RUN[refusals, GitHub]`; the check, `git-scenarios.ts:423-445`). The allowed push is the positive control, so the log is known to have caught up (`git-scenarios.ts:423-436`). **The log is readable with a `contents: read` installation token**: the harness reads it with exactly that (`SPIKE/src/harness/github-target.ts:43,94-96`). GitHub's page names no permission for it ([GitHub: list repository activities](https://docs.github.com/en/rest/repos/repos#list-repository-activities)), so this is the first evidence.
  - After the refusals, the task's branch still pushed. The agent's own `Authorization` header was dropped: a fetch that carried a made-up one still went through on the proxy's token (`RUN[refusals, GitHub]`; `SPIKE/src/git-proxy.ts:132-152`).
  - On the stand-in, its own counters agree: 0 `receive-pack` POSTs and 0 requests for the other repo (`RUN[refusals, local stand-in]`). The stand-in is set to allow deletes, so a refused delete is the proxy's doing (`SPIKE/src/harness/local-target.ts:69-71`). The check on GitHub has no such counter, so the activity log stands in for it.
  - How the proxy decides: it reads the push's command list up to its first flush-pkt, and decides before it opens an upstream connection (`SPIKE/src/pkt-line.ts:79-134`; `SPIKE/src/git-proxy.ts:366-414`). The format is git's: `old-id new-id name` lines, then a flush-pkt, then the pack ([git: gitprotocol-pack](https://git-scm.com/docs/gitprotocol-pack)). The allowed refs match exactly: the task's branches and `refs/ostra/wip/<task>`, nothing else (`SPIKE/src/policy.ts:28-41`).
- **The token on this host: PASS, 5 of 5** (`RUN[token, GitHub]`): 0 hits for 24 needles in 418 files and 73.1 MiB (the main agent world, with git config, the LFS store and git/curl/packet traces on with redaction off). 0 hits in 152 output streams. 21 environment variables, all from an allowlist. Every request git and git-lfs made went to a proxy (3 distinct `Host` headers, 0 not a proxy). 0 hits in 258 proxy log records. The needles are each credential as it is, inside a Basic header (base64, with and without the `x-access-token:` prefix), URL-encoded, and, for the long ones, a slice from the middle that catches a token cut short by a log line (`SPIKE/src/git.ts:177-193`). The credentials are 390 characters (`RUN` metrics, `credentialLengths`). That is the agent's own `git` only: "no token in the agent's git on this host (container: not tested)" (`spike.ts:75-78`). The stand-in's tokens are built to about 520 characters in the shape of `ghs_<APPID>_<JWT>` (`SPIKE/src/fake-token.ts:11,34`), so they were the stricter case. The earlier stand-in-only runs scanned both agent worlds, the 500 MiB pack's included: 0 hits for 30 needles in 528 files and 2,065.3 to 2,085.4 MiB, 144 streams and 138 log records (`RUN500[1-3]`).
- **The agent's container: SKIPPED.** It needs spike 3's box, Docker on Linux (`RUN[token-container]`). The machine has no Docker and no WSL (the row's own note says Docker on Linux isn't on this machine; the first version of this file checked `docker: command not found` and `wsl --status`: WSL not installed, on 2026-11-18, and I didn't repeat that).

**3. LFS, a shallow clone and a 500 MB pack: LFS and shallow PASS on GitHub, the pack SKIPPED.**
- **LFS: PASS, 3 of 3** (`RUN[lfs, GitHub]`), after the fix of Gotcha 1:
  - a 3 MiB object pushed through the proxy: 1 batch call and 2 actions (the S3 upload and the verify)
  - the clone downloaded it, and the content matched
  - the actions GitHub offered, recorded by host name only: `upload` on `github-cloud.s3.amazonaws.com` with `expires_in=900`, `verify` on `lfs.github.com` with no `expires_in`, and `download` on `github-cloud.githubusercontent.com` with `expires_in=3600` (`RUN[lfs, GitHub]`; recorded from the proxy's log of the batch answers, `git-scenarios.ts:610-624`; the log field is `keptActions`, `SPIKE/src/git-proxy.ts:519-521,536`)
- **LFS on the stand-in: LOCAL-ONLY, 5 of 5** (`RUN[lfs, local stand-in]`): the same push and clone (1 batch, 2 actions), the recorded actions (all on the stand-in's own origin), and two probes of hostile batch answers:
  - of 9 actions that pointed outside the upstream, 1 was kept (a made-up path on `github-cloud.githubusercontent.com`) and 8 were dropped: IP literals, `localhost`, a host not on the list, plain `http`, port 8443, a look-alike host. Each dropped object got the proxy's per-object error, and 0 of the actions were called (`SPIKE/src/upstream-stub.ts:36-47`; `SPIKE/src/harness/git-scenarios.ts:625-656`)
  - an object whose upload is on an allowed host (the S3 bucket) and whose verify is on a hostile one (`169.254.169.254`) got the proxy's error and no actions, and nothing was called (`upstream-stub.ts:51-53,241-257`; `git-scenarios.ts:657-673`). The probes only run on the stand-in, since GitHub's answers can't be made to point elsewhere (`SPIKE/src/harness/github-target.ts:98`).
- **Shallow: PASS, 6 of 6** (`RUN[shallow, GitHub]`), after the fix of Gotcha 2. On the task's branch, which has 4 commits by then: `--depth 1` on v2 (1 of 4 commits, shallow) and on v0 (1 commit, shallow), `--deepen 1` (2 commits), a push of the task's branch from a shallow clone, `--unshallow` (4 of 4, not shallow), and `--filter=blob:none` (recorded, not in the bar). On the stand-in the same 6 are LOCAL-ONLY, with 1 of 6 and 6 of 6 commits (`RUN[shallow, local stand-in]`).
- **A 500 MiB pack: SKIPPED on GitHub** (`RUN[large, GitHub]`: "needs SPIKE_GITHUB_LARGE_PACK=1 (pushes the large pack to the sandbox repo)"; `SPIKE/src/harness/spike.ts:289-290`). On the stand-in today's run pushed a 50 MiB pack, labelled as short of the bar, so it is no evidence for the bullet (`RUN[large, local stand-in]`, 3 of 3 checks).
  - **The 500 MiB figures are the stand-in's, from the three older runs, and not GitHub's.** The pack is 10 files of 50 MiB of random, incompressible data (`SPIKE/src/harness/git-scenarios.ts:57-65,684-690`, with `largeFileMb: 50` at `SPIKE/src/harness/local-target.ts:161` and `github-target.ts:100`).

  | What | The three 500 MiB stand-in runs | Today's 50 MiB stand-in run |
  |---|---|---|
  | Push through the proxy | 524,449,041 to 524,449,044 bytes forwarded in 42.3 to 47.7 s (10.5 to 11.8 MiB/s) | 52,445,550 bytes in 2.3 s (22.1 MiB/s) |
  | Clone through the proxy | 527,762,718 to 527,763,526 bytes in 75.2 to 78.0 s | 55,612,025 bytes in 5.4 s |
  | The same clone, straight from the stand-in | 73.8 to 74.9 s | 4.9 s |
  | Peak RSS of the harness process, which hosts the proxy | 106.6 to 157.1 MiB, +7.6 to +69.1 MiB over the start of the push | 136.3 MiB, +0.0 |

  Source: `RUN500[1-3]` (the push, clone and RSS lines, and the `largePackDirectCloneMs` metric: 73,809, 74,001 and 74,926 ms); `RUN[large, local stand-in]` and its metrics. The README says the proxy adds 2 to 5 % to the clone at 500 MiB (`SPIKE/README.md:153`). The gap per run is 1.4 to 4.1 s, from the metrics above. The RSS figure includes the harness's own buffers (`SPIKE/src/harness/git-scenarios.ts:67-79,741-746`).
- **GitHub's limits, as documented and not tested.** GitHub warns on a file over 50 MiB and blocks one over 100 MiB. It recommends repos under 1 GB, "less than 5 GB is strongly recommended", and states no push-size limit ([GitHub: about large files](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github)). The Git LFS file limit is 2 GB on Free and Pro, 4 GB on Team and 5 GB on Enterprise Cloud, and that page states no bandwidth or storage quota ([GitHub: about Git LFS](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-git-large-file-storage)). The harness splits the pack into 50 MiB files for the 100 MiB limit (`SPIKE/src/harness/target.ts:53-54`; `SPIKE/src/harness/github-target.ts:100`).
- **What GitHub's side showed about LFS:** the hosts and expiries above, and nothing else. The upload's expiry is 900 s, the download's 3,600 s, and the verify has none, so the proxy gives it the 1 h cap (`SPIKE/src/git-proxy.ts:98,537`; inferred from the code, since the run doesn't print the cap used). LFS bandwidth and storage quota were not measured (`SPIKE/README.md:166`).
- The bar's "or their limits are written down" is half met for the pack. The stand-in's limits are written, and GitHub's own are not measured. So the bullet stays unmet.

**4. A co-author, a comment-type review and a check run: co-author and review PASS on GitHub, the check flip SKIPPED.**
- **Co-author: PASS, 2 of 2** (`RUN[co-author, GitHub]`). The App opened PR #7 as `ostra-sandbox-036d7c[bot]`, and GraphQL `Commit.authors` resolved the commit's authors to two users: the bot, and the member named in the `Co-authored-by` trailer by their `<id>+<login>@users.noreply.github.com` address. What the code does: it commits as `<slug>[bot]` with that trailer, then asks GraphQL `Commit.authors` for the member's login, 10 tries 2 s apart (`SPIKE/src/github/pr-flow.ts:83,93,155-168`). GitHub says credit needs an email tied to the co-author's account, or their no-reply address ([GitHub: commits with multiple authors](https://docs.github.com/en/pull-requests/committing-changes-to-your-project/creating-and-editing-commits/creating-a-commit-with-multiple-authors)). The ID-based no-reply form resolves: that was the open point of the first version.
- **Comment-type review with line comments: PASS, 2 of 2** (`RUN[review, GitHub]`). The App's `COMMENT` review on its own PR reads back as `COMMENTED`, with 2 of 2 line comments (on lines 3 and 5; `pr-flow.ts:172-191`).
- **A check run flips on approval: SKIPPED on GitHub.** `RUN[check, GitHub]`: "needs GITHUB_TEST_REVIEWER_TOKEN". It's a second sandbox user's token, and it is in no file of the config directory (key names of `github-test.env`: the org, the repos, the member login and the installation ID; I read names only). The code creates `ostra/independent-review` as `in_progress`, confirms that the App's own comment review doesn't flip it, has the second user approve, and re-evaluates for up to 120 s, by webhook when one is wired (it wakes at once, and otherwise every 15 s) or by polling every 3 s (`pr-flow.ts:194-223,283-293`). GitHub says only a GitHub App can create a check run ([GitHub: check runs](https://docs.github.com/en/rest/checks/runs)). The PR flow itself ran today (PR #7), so it created the check as `in_progress` and confirmed the App's own review doesn't flip it (inferred from the code, `pr-flow.ts:194-224`). Those two checks are not in the row: the harness records the check row as SKIPPED when the reviewer token is missing (`SPIKE/src/harness/spike.ts:321-322`; `RUN[check, GitHub]`: 0 checks).
- **Local, LOCAL-ONLY, 11 of 11, logic only** (`RUN[check, local stand-in]`): 8 cases of the approver rule, and a webhook signature accepted, forged and missing. The cases: no review, the App's own comment, the driver's approval, someone else's approval of the head, an approval of an older commit, an approval withdrawn by a change request, an approval followed by a comment, and the driver in other case (`SPIKE/src/harness/review-local.ts:22-31`; `SPIKE/src/github/independent-review.ts:25-45`). No check run was involved.

**5. Linear links the PR: SKIPPED.**
- `RUN[linear, GitHub]`: "needs LINEAR_API_KEY and LINEAR_TEST_TEAM_ID". I loaded no `linear.env`, as the task's command says. Its key names (values redacted) include `LINEAR_API_KEY` and `LINEAR_TEST_TEAM_KEY`, and I saw no `LINEAR_TEST_TEAM_ID`, which is the name the harness reads (`SPIKE/src/inputs.ts:30,56,93`). So loading `linear.env` alone would probably leave the row skipped (inferred). Whether Linear's own GitHub app is installed on the sandbox org is unknown (README: the criterion needs it, `SPIKE/README.md:77,88`). There is no local evidence, and none is possible.
- The code makes an issue, names the branch `ostra/<identifier>-<task>`, starts the PR title with the identifier, writes `Fixes <ID>` in the body, and polls the issue's attachments for up to 120 s (`SPIKE/src/github/pr-flow.ts:104,143,316-330`; `SPIKE/src/linear/linear-api.ts:27-49`).
- Linear documents the same signals: the issue ID in the branch name, the PR title or the description, with magic words such as `Fixes`. The integration is installed by a GitHub organization owner, or by a repo admin for repo access. PR linking works without code access ([Linear: GitHub](https://linear.app/docs/github)).

**Beyond the bar (RUN):**

| Part | Result | Note |
|---|---|---|
| The hidden ref `refs/ostra/wip/<task>` pushes | **PASS** on GitHub, LOCAL-ONLY on the stand-in | GitHub accepted the push and the ref reads back. Spike 2 checks that GitHub starts no CI for it (`RUN[hidden-ref, GitHub]`) |
| Git keeps working across a token re-mint | **PASS** on GitHub (1 of 1), LOCAL-ONLY on the stand-in (2 of 2) | on GitHub, 3 real installation tokens minted (1 for the clone) and git kept working. An expired token is refused upstream, and git shows the proxy's message, not a credential prompt: the stand-in only, because the harness can't make an expired real token (`RUN[token-renewal, local stand-in]`; `SPIKE/README.md:131`) |
| No process or server is left | **PASS** | 0 tracked children, 0 listening servers, 0 stray processes in the OS list (`RUN[processes]`) |
| Nothing left behind on GitHub or Linear | no row | a row exists only on failure (`spike.ts:349-351`), and none was written. The console says no refs, PRs or issues are left. LFS objects stay (Section 4, item 5) |

---

## 3. What surprised us, and the gotchas

**The two bugs GitHub showed.** Both passed on the stand-in, and both were the spike's own. Both are fixed, and today's run passes (`RUN[lfs, GitHub]`, `RUN[shallow, GitHub]`).

**Gotchas 1 and 2 first, since they are what the run on GitHub added.**

1. **LFS, two proxy bugs: hosts off the allowlist, and no `User-Agent`.**
   - **(a) The hosts.**
     - **What GitHub does.** Its upload batch answer points the `upload` action at `github-cloud.s3.amazonaws.com` and the `verify` action at `lfs.github.com`. Its download answer points at `github-cloud.githubusercontent.com` (`RUN[lfs, GitHub]`, the recorded actions). The first version of this file expected only `github-cloud.githubusercontent.com` and `*.githubusercontent.com`, and said that LFS on GitHub was **unverified** and would fail closed if the hosts were wrong. It was right on both counts.
     - **What the proxy did.** Neither of the first two hosts was on the default allowlist, so the proxy dropped both actions and passed the object on with an empty `actions` (the old behaviour, per `SPIKE/README.md:114`). The git-lfs batch spec says "If a client requests to upload an object that the server already has, the server should omit the `actions` property completely" ([git-lfs: batch API](https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md)). So git-lfs read it as "the server has it already". The push exited 0 with nothing uploaded, and only the clone failed: "Clone succeeded, but checkout failed", after the download batch answered `404 Object does not exist on the server` (`SPIKE/README.md:114`, the first run's account; not reproduced).
     - **Why the stand-in didn't show it.** On the stand-in the real LFS transfers pointed at the stand-in's own origin, which the proxy always allows (`SPIKE/src/upstream-stub.ts:275`; `SPIKE/src/git-proxy.ts:63`). The allowlist was only exercised by probes, and the probes' one kept host was a made-up path on `github-cloud.githubusercontent.com` (`upstream-stub.ts:45-46`).
     - **The fix.** Both hosts are on the default list by exact name, and the S3 bucket is named exactly "since anyone can own a bucket under `s3.amazonaws.com`" (`SPIKE/src/git-proxy.ts:34-44`). `SPIKE/test/lfs-action-href.test.ts:13-23` checks the two names pass, and `evil.s3.amazonaws.com`, `s3.amazonaws.com/evil` and look-alikes of both names don't. An object with any refused action now gets a per-object error, `ostra: the LFS server sent this object's transfer to a host the proxy doesn't allow`, and none of its actions (`git-proxy.ts:46-49,522-533`), so git-lfs fails instead of reading "no actions" as "already uploaded". The per-object `error` is the batch spec's way to report a problem with one object, with codes that "should match HTTP status codes where possible" (the same spec). The stand-in's mixed-object probe covers it (Section 2, bullet 3).
     - **Corroboration of the hosts.** GitHub's Copilot allowlist reference lists `lfs.github.com`, `github-cloud.s3.amazonaws.com` and `github-cloud.githubusercontent.com` under "GitHub: Content & API" ([GitHub: Copilot allowlist reference](https://docs.github.com/en/enterprise-cloud@latest/copilot/reference/copilot-allowlist-reference)). The page is about Copilot, not LFS, so it names no LFS requirement. It agrees with what the run saw.
   - **(b) No `User-Agent`.**
     - **What happened.** With the hosts allowed, the S3 upload went through (200). GitHub then refused the `verify` three times (git-lfs retries) with a 403. The proxy sent the action's own headers plus `content-type`, `content-length` and `accept`, and no `User-Agent`, since Node's `http.request` adds none. lfs.github.com answers a request with none with `403 Request forbidden by administrative rules. Please make sure your request has a User-Agent header`. Replaying the verify action outside the proxy gave 403 without the header and 200 with git-lfs's (`SPIKE/README.md:117`, a manual probe on 2026-11-18, not repeated here).
     - **The rule is GitHub's in general.** The REST docs say "All API requests must include a valid `User-Agent` header" and that requests with none are rejected ([GitHub: getting started with the REST API](https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api)). That page is about the REST API. lfs.github.com's refusal is the README's manual probe.
     - **The fix.** The proxy passes the client's `User-Agent` on to the LFS batch, the lock check and every LFS action, with `ostra-git-proxy` as the fallback, and an action's own `User-Agent` wins, in whatever case (`git-proxy.ts:154-159,478-482,577-581,601-603`). The stand-in now refuses a request with no `User-Agent`, as GitHub does (`upstream-stub.ts:371-377`). With the proxy fix taken out again, the local LFS push fails too (README's claim, `SPIKE/README.md:119`; not repeated).
     - **A gap I see in the fix (inferred, not run).** The `User-Agent` is copied to a git smart-HTTP request only when the client sent one (`git-proxy.ts:134,137-142`); the fallback applies to LFS requests only (`git-proxy.ts:157`). Stock git always sends one, so nothing failed. A client with none would send none to github.com.
   - **What the README says, and the run confirms:** git-lfs honours the `insteadOf` rule for its endpoint on GitHub too, and never reached S3, lfs.github.com or githubusercontent.com itself (3 distinct `Host` headers, 0 not a proxy: `RUN[token, GitHub]`).

2. **Shallow: a harness bug, a one-commit history.**
   - The shallow clone was of the default branch, which in `test1` is one root commit. A `--depth 1` clone of a one-commit history is complete, so git writes no `.git/shallow`, and `fetch --unshallow` stops with `fatal: --unshallow on a complete repository does not make sense` (`SPIKE/README.md:120`, the first run's account; not reproduced). The "1 commit" check had passed only because the history was one commit long.
   - **Why the stand-in didn't show it.** Its seed repo has 3 commits on the default branch (`SPIKE/src/harness/local-target.ts:74`), so the clone there really was shallow.
   - **The fix.** The shallow clones are now of the task's branch, which has history by then (`SPIKE/src/harness/git-scenarios.ts:474-489`). Each step checks `git rev-parse --is-shallow-repository` and counts its commits against a full clone (`git-scenarios.ts:480-487,490-529`). After the clone: 1 commit, shallow. After `--deepen 1`: 2 commits. After `--unshallow`: the full count, not shallow. On GitHub: 1 of 4, 2, then 4 of 4 (`RUN[shallow, GitHub]`). No check was loosened; the checks are stricter now (`SPIKE/README.md:97`).
   - The lesson is about the stand-in's data, not its protocol. A stand-in with a different history shape hides the bug the same way one with different hosts does. The README records the default branch's one commit as a limit (`SPIKE/README.md:165`).

**Surprises**

3. **A refusal that stock git can read needs a forged `receive-pack` report.**
   - A plain 403 makes git exit 128. A ref refusal makes it exit 1 and print `! [remote rejected] … (ostra: …)`. Both show in `RUN[refusals, GitHub]`: exit 128 on the other-repo and read-only rows, which are 403s, and exit 1 on the ref rows.
   - So the proxy answers with the status report of git's own protocol: `unpack ok`, then `ng <ref> <reason>` for each ref, wrapped in side-band when the client asked for it ([git: gitprotocol-pack](https://git-scm.com/docs/gitprotocol-pack), "Report Status"). The code does this by hand (`SPIKE/src/pkt-line.ts:139-159`). It falls back to a plain 403 when the client didn't ask for a report (`SPIKE/src/git-proxy.ts:356-361`).

4. **A refused push is answered only after the proxy has read and dropped the whole body.**
   - This is so that git reads the answer instead of a reset connection (`SPIKE/src/git-proxy.ts:343-355`). The cap is 4 GiB, and the connection is cut beyond it (`git-proxy.ts:96,351-354`). Answering early wasn't tried (`SPIKE/README.md:170`).
   - So "refused before a byte reaches GitHub" holds, but a refused 500 MiB push still costs the box the full upload to its sidecar.

5. **"Before a byte reaches GitHub" is about the push, not the handshake.**
   - A read-write proxy sends the ref advertisement (`GET info/refs?service=git-receive-pack`) upstream before it sees the command list (`SPIKE/src/git-proxy.ts:306-320`). The refusal then happens on the POST. The read-only proxy refuses the advertisement as well (`git-proxy.ts:312-316`).
   - The counters the run relies on count `receive-pack` POSTs (`SPIKE/src/harness/git-scenarios.ts:153-157,198-200`). On GitHub, the proof is the repository activity log, which lists pushes, force pushes and branch creations and deletions ([GitHub: list repository activities](https://docs.github.com/en/rest/repos/repos#list-repository-activities)). It would not show a GET (inferred from that list). The run's log check passed (Section 2, bullet 2).

6. **LFS is where the proxy keeps state.**
   - GitHub's batch answer carries signed URLs and headers, an `Authorization` among them. The proxy keeps them under random nonces for at most 1 h, and gives git `<proxy>/_ostra/lfs/<nonce>`. Otherwise those credentials reach the agent (`SPIKE/src/git-proxy.ts:534-549,98`). The batch format is git-lfs's ([git-lfs: batch API](https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md)). The proxy also sets `authenticated: true` on each object (`git-proxy.ts:550`). The spec says that when it's omitted or false, git-lfs looks for credentials for the URL (the same page). I didn't run it without the flag, so I can't say it's needed.
   - The verify's header on GitHub is `Authorization: RemoteAuth …`, which is not the installation token, with `Accept`; the upload's signed headers are `Authorization`, `x-amz-content-sha256` and `x-amz-date` (`SPIKE/README.md:161`, observed by a manual probe, not by the harness). The run itself records host names and `expires_in` only.

7. **git-lfs followed the `insteadOf` rule to the proxy with no extra setting, and the docs don't say it would.**
   - The git-lfs server-discovery page derives the endpoint from the remote URL and says nothing about URL rewrites ([git-lfs: server discovery](https://github.com/git-lfs/git-lfs/blob/main/docs/api/server-discovery.md)). Git's manual says any URL starting with the `insteadOf` value is rewritten ([git: git-config](https://git-scm.com/docs/git-config), `url.<base>.insteadOf`).
   - The run is the evidence, on both targets: with `GIT_CURL_VERBOSE` on, every `Host` header git and git-lfs sent was a proxy, LFS object transfers included (`RUN[token, GitHub]`: 3 hosts, 0 not a proxy; `RUN[token, local stand-in]`: 4 hosts, 0 not a proxy).

8. **The check's logic only moves one way, and it is built for one head and one driver.**
   - The re-evaluation only ever writes `success` (`SPIKE/src/github/pr-flow.ts:210-219`). The evaluator knows an approval can be withdrawn or go stale (`independent-review.ts:25-45`; `RUN[check, local stand-in]`), but nothing sets a green check back.
   - The check is made for one `head_sha` (`pr-flow.ts:194-200`). After a new push the PR has another head, and the spike has no step that publishes the check for it. This is inferred, not tried.
   - The evaluator takes a list of drivers, and the flow passes one login (`pr-flow.ts:209`). ADR 0040 credits every member whose prompt led to a commit (`context/decisions/0040-the-github-app-opens-every-pr.md:7`), so "who didn't drive the task" has to mean none of them.
   - No step has the driver approve on GitHub. Only the evaluator's local case covers it. That matters, because GitHub's own rule that an author can't approve their own PR doesn't cover a human approving a bot's PR (`context/research/platform-auth-github.md`, §2.5).

9. **Three tokens with three scopes ran in one flow, and narrowing is the caller's job.**
   - The box's proxy token is `contents: write` on one repo (`SPIKE/src/github/pr-flow.ts:106`; `SPIKE/src/harness/github-target.ts:35`). The PR, the review and the check use a second token with `contents`, `pull_requests` and `checks` write (`pr-flow.ts:79`). The harness reads with a third, `contents: read` on both repos (`github-target.ts:43`).
   - That is the split of ADR 0030 and ADR 0040: the box's proxy token is for one repo (`context/decisions/0030-no-credential-enters-the-agents-container.md:24`), and the App, which is the server's, opens every PR (`context/decisions/0040-the-github-app-opens-every-pr.md:5`). GitHub says a token minted without `repositories` or `permissions` gets everything the installation has, so every mint must name both ([GitHub: create an installation access token](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)). The spike's mint does (`SPIKE/src/github/app-auth.ts:37-46`).

**Gotchas**

10. **GitHub's installation tokens were 390 characters, not about 520.** The earlier research says about 520 and warns not to assume a length (`context/research/platform-auth-github.md:314`). The real tokens of the run were 390 (`RUN` metrics, `github.credentialLengths`). The leak scan stayed safe, because the stand-in's fake tokens are the longer, stricter case (`SPIKE/src/fake-token.ts:11,34`). A column or a redaction regex must not hard-code either number. GitHub's own suggested regex is `ghs_[A-Za-z0-9\.\-_]{36,}` (the same research line). Whether the length varies with the repos and permissions a token is narrowed to is **unverified**.

11. **Refs match exactly, and the stand-in's disk is case-insensitive.**
    - The proxy compares refs byte for byte (`SPIKE/src/policy.ts:38-39`), so `refs/heads/OSTRA/<task>` is refused (`RUN[refusals, GitHub]`: "the task's branch in other case is refused"). On this NTFS volume the bare repo resolves that name to the task's own branch, so each step compares the ref before and after rather than expecting it absent (`SPIKE/README.md:173`; `git-scenarios.ts:175-177`). Because the proxy refuses before forwarding, the GitHub row can't say whether GitHub folds case in ref names. That wasn't tested.

12. **Octokit's request log prints paths, and the conversion path holds the one-time code.** The manifest server builds Octokit with a silent log (`SPIKE/src/github/manifest.ts:215-217`). That Octokit's log prints paths is the README's observation (`SPIKE/README.md:174`); I didn't run it. That the code is in the path is in the earlier research, which cites GitHub's conversion API: `POST /app-manifests/{code}/conversions` (`context/research/platform-auth-github.md` §2.2).

13. **The proxy has no per-task secret in its URL.**
    - The first sketch had one: `url.http://127.0.0.1:<port>/<task-token>/.insteadOf=https://github.com/` (`context/research/credential-proxy.md:306`). The spike dropped it, because it relies on the box's network (`SPIKE/README.md:192`). Anything that can reach the sidecar's port can push the task's branch. That is spike 3's check ("another box", `PASSBAR` for spike 3, `context/build-order.md:111`), and the proxy depends on it.

14. **The LFS URLs the proxy hands out use its own listen address.** In a box they must use the address the agent reaches the sidecar by (`SPIKE/README.md:192`; code: `SPIKE/src/git-proxy.ts:547,697`).

15. **A token that expires mid-stream isn't tested.** GitHub's installation tokens last an hour ([GitHub: create an installation access token](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)). The provider re-mints 5 minutes before expiry (`SPIKE/src/github/app-auth.ts:53`). The run showed 3 mints on GitHub, the first for the clone and so 2 re-mints (`RUN[token-renewal, GitHub]`). But the re-mint was triggered by the harness telling the provider a shorter expiry than the token's own (`SPIKE/src/harness/local-target.ts:131-141` on the stand-in; the GitHub target's equivalent is not read here), not by a token running out mid-request. Whether GitHub checks a token only at the start of a request is **unverified** (`SPIKE/README.md:193`).

16. **The LFS allowlist checks host names, not the addresses they resolve to.** A DNS answer that points an allowed name at a private address isn't caught (`SPIKE/README.md:194`; `SPIKE/src/git-proxy.ts:56-69`).

17. **A push over `http.postBuffer` is said to send an empty command list first, and the proxy would forward it.** Git uses chunked transfer for requests larger than the buffer, which is 1 MiB by default ([git: git-config](https://git-scm.com/docs/git-config), `http.postBuffer`; read in the manual that ships with the installed git). That git sends an empty command list (`0000`) first is the README's observation (`SPIKE/README.md:171`). Neither the git manual I read nor this run's data shows it, so I count it as **unverified** here. What the code does with such a list is checked: a command list with no commands refuses nothing and updates nothing, so it passes (`SPIKE/src/policy.ts:45-49`; the parser accepts a bare flush-pkt, `SPIKE/test/pkt-line.test.ts`). The 500 MiB push on the stand-in went through (`RUN500[1-3]`), so the proxy handled such a body there (inferred: the runs didn't record the transfer encoding). No push over 1 MiB went to GitHub in today's run: the 50 MiB pack was local, and the GitHub pushes are small.

18. **The bot's commit email needs the bot's numeric ID.** ADR 0030 has the box author commits as the App's bot (`context/decisions/0030-no-credential-enters-the-agents-container.md:27`). The email is `<id>+<slug>[bot]@users.noreply.github.com` (`context/research/platform-auth-github.md` §2.5, which cites Renovate for the format), and the spike gets the ID with one extra call, `GET /users/<slug>[bot]` (`SPIKE/src/github/pr-flow.ts:82-83`). The spike's agent has a placeholder identity, `ostra agent (spike)`, so the box must set the bot's identity itself (`SPIKE/src/git.ts:108-110`). The co-author's address was built the same way from the member's numeric ID (`pr-flow.ts:93`), and GitHub resolved it (Section 2, bullet 4).

19. **"500 MB" ran as 500 MiB, which is 524 MB, in 50 MiB files, and only on Windows.** Sizes are binary (`SPIKE/README.md:71`). The split is for GitHub's 100 MiB file limit (Section 2, bullet 3). The harness's process handling has Linux and macOS branches that have not run (`SPIKE/src/proc.ts:17,51,89`).

---

## 4. What this changes in the plan

These are recommendations for the maintainer. I changed no other file.

1. **Change no ADR and no ledger status yet, and note what the GitHub run now supports.**
   - Nothing failed. F-006, F-030, F-090, F-104 and F-119 stay `planned` (`context/features.md:29,45,89,154,163`). So does F-060, which rests on the proxy accepting only the task's refs (`context/features.md:169`; `context/decisions/0030-no-credential-enters-the-agents-container.md:54`). Each has a "done when" the spike doesn't finish: the container, the 500 MiB push, the check flip and Linear.
   - ADR 0030's fallback (`0030-no-credential-enters-the-agents-container.md:46`) says "kept as spike 4's fallback, if LFS or large packs break through the proxy". LFS works through the proxy on GitHub now, once the fixes of Gotcha 1 are in. The large pack is the part not yet tried on GitHub. Keep the fallback on the books until it is.
   - ADR 0031's third line (only the task's refs can be pushed; `context/decisions/0031-safety-minimum-revised.md:36` says spike 4 tests it) now has its GitHub evidence: `RUN[refusals, GitHub]`. ADR 0040's authorship also has it: the PR is the App's, the member shows as co-author (`RUN[co-author, GitHub]`). Only the check part of ADR 0040's test is open.

2. **Tighten F-090's "done when" with what the runs settled** (`context/features.md:89`).
   - A refused push gets git's own `remote rejected` line with a reason, and a plain 403 only when the client asked for no report (Surprise 3).
   - The proxy rewrites LFS batch answers so signed URLs and headers never reach the agent. It drops actions that point outside the upstream or the allowlisted hosts, and an object with a refused action gets a per-object error and no actions, never an empty `actions` (Gotcha 1a).
   - A refine or review task's proxy refuses the receive-pack advertisement, LFS uploads, LFS lock checks and every non-GET LFS action, not only the push (`SPIKE/src/git-proxy.ts:312-316,474-477,568-571,597-600`). The run exercised the push refusal and a clone only (`RUN[refusals, GitHub]`), so the LFS branches of the read-only mode are code that has not run.
   - The server narrows every token it mints to one repo and the permissions the step needs (Surprise 9).
   - A refused push still costs the upload, up to a cap (Surprise 4). Decide the cap and write it down.

3. **Add a configuration-reference line per code host for the LFS action hosts.**
   - The hosts a proxy may call for an LFS action are a setting, `lfsActionHosts` (`SPIKE/src/git-proxy.ts:29-31`). For github.com, the default list is `github-cloud.githubusercontent.com`, `*.githubusercontent.com`, `github-cloud.s3.amazonaws.com` and `lfs.github.com` (`git-proxy.ts:34-44`). The reference needs a line that says so, and one that tells a GitHub Enterprise Server install to list its own storage host. Without one, LFS on that install fails closed: the objects get the proxy's error (`git-proxy.ts:522-533`; the stand-in's probes show the behaviour, `RUN[lfs, local stand-in]`).
   - It is a per-code-host line because the shared code host interface has to declare it, and each adapter states its own list (`AGENTS.md`, "Adapter parity", and "Definition of done": a new setting ships with a working default and its line in the reference). GitHub is the only host seen; the hosts of any other code host's LFS are **unverified** until its adapter runs the same test.
   - Decide whether the default keeps `*.githubusercontent.com`. The run saw one exact name under it, `github-cloud.githubusercontent.com` (`RUN[lfs, GitHub]`), and the S3 bucket is already named exactly for the reason in the code comment (`git-proxy.ts:34-38`). The wildcard is wider than the evidence. The action's own headers go only to a host the batch answer named (inferred from `git-proxy.ts:534-549`), which limits the harm either way.
   - Keep the contract test for the list: names that must pass, and look-alikes that must not (`SPIKE/test/lfs-action-href.test.ts:13-23`).

4. **State the `User-Agent` rule in the proxy's contract.**
   - Every upstream request the proxy makes carries a `User-Agent`: lfs.github.com refuses one without it with a 403 (Gotcha 1b; `SPIKE/README.md:117`). GitHub's REST docs state the rule for the REST API ([GitHub: getting started with the REST API](https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api)).
   - Node's `http.request` adds none, so the proxy must set it. Apply the fallback to the git smart-HTTP requests too, not only to LFS (`git-proxy.ts:137-142` against `157-159`; Gotcha 1b, inferred).
   - The test double of any code host must refuse a request with none, as the stand-in now does (`SPIKE/src/upstream-stub.ts:371-377`), so a missing header fails in the harness and not on a real host.

5. **Write down the LFS-storage cleanup limit.**
   - A task's cleanup deletes refs, never LFS objects (`SPIKE/src/harness/github-target.ts:101-114`; the run's last line: "Not removed: LFS objects pushed to the sandbox repo stay in its LFS storage", `spike.ts:385`).
   - GitHub says the same about removal in general: "the Git LFS objects still exist on the remote storage", they "continue to count toward your Git LFS storage quota", and "to remove Git LFS objects from a repository, delete and recreate the repository" ([GitHub: removing files from Git LFS](https://docs.github.com/en/repositories/working-with-files/managing-large-files/removing-files-from-git-large-file-storage)).
   - For the sandbox: each passing run leaves one new 3 MiB random object in `test1` (`git-scenarios.ts:576-587`), on top of the README's count of two verified 3 MiB objects, one 3 MiB upload whose verify failed, and two 64-byte probe objects before today's final run (`SPIKE/README.md:163`). The count after today's run is one more, inferred. The quota GitHub applies to the org, and how it counts them, wasn't checked (`SPIKE/README.md:163,166`). The test repo has to be recreated now and then, or LFS tests have to use a throwaway repo.
   - For the product: ostra can't give back the LFS storage of a task it cleans up. A task's LFS objects count against the org's quota, on GitHub's side, until the repo is gone. Say so where ADR 0039's cleanup and the configuration reference describe LFS, and don't promise otherwise.

6. **Reword the proxy's "GitHub refused the task's credential" message, and log the reason.**
   - The proxy turns every upstream 401, 403, 407 and redirect into `ostra: GitHub refused the task's credential (status N)` (`SPIKE/src/git-proxy.ts:54,281-288`), and an LFS batch 401 or 403 into the LFS variant (`git-proxy.ts:491-495`). That is wrong for the `verify`: the credential was fine, and the missing `User-Agent` was the cause. git-lfs printed only "Errors logged to …", and the proxy logs the status but not GitHub's reason (`git-proxy.ts:285`). The cause was found by replaying the action outside the proxy (`SPIKE/README.md:175`).
   - Word the message by status and by where the refusal came from: the git endpoint or an LFS action host. Log the upstream's reason without the body's content where it could carry a secret (`SPIKE/README.md:195`, and `AGENTS.md`: logs carry IDs and structured fields, never content). A message that blames the credential sends an operator to rotate a token that was never wrong.
   - The harness asserts the prefix (`SPIKE/src/harness/git-scenarios.ts:568`), so a reword changes that check too.

7. **Amend ADR 0030's consequences on the proxy's address.**
   - Say that the git proxy carries no per-task secret, so a box's network must keep other boxes away from the sidecar's port, or the proxy URL must carry the task token the first sketch had (Gotcha 13). Spike 3's "another box" check then covers this port.
   - Say that the proxy must hand out its LFS URLs on the address the agent uses (Gotcha 14).

8. **Specify F-104 from the evaluator, and close its gaps** (`context/features.md:154`).
   - Write the approver rule as the evaluator has it: the latest approval, change request or dismissal of each reviewer counts, a comment doesn't, bots and drivers don't count, and the approval must be of the current head (`SPIKE/src/github/independent-review.ts:25-45`).
   - Define "driver" as every member credited with a trailer on the task (Surprise 8).
   - State what the check does on a new push, on a dismissal and on a withdrawn approval. The webhook already takes `submitted` and `dismissed` (`independent-review.ts:79`), and the flow has no step that returns a green check to pending.
   - Choose what an unapproved PR shows. The spike uses `in_progress`. GitHub's list of conclusions also has `action_required` and `neutral` ([GitHub: check runs](https://docs.github.com/en/rest/checks/runs)). Whether a required check in `in_progress` blocks a merge the way a failing one does is **unverified**.
   - The flip itself is still not seen on GitHub (Section 5).

9. **Settle the details of F-006 and F-119 with what GitHub answered.**
   - **Permission keys: settled.** GitHub accepts `contents`, `pull_requests`, `checks`, `actions`, `issues`, `statuses` and `metadata` as the manifest spells them and returns the same seven (`RUN[manifest, GitHub]`). That answers the earlier research's open point on the spelling of `statuses` (`context/research/platform-auth-github.md:307,456`, S6).
   - **`email_addresses`: refused, so drop it from the proposal.** The research proposes `email_addresses: read` (`platform-auth-github.md:307`); GitHub refused the manifest with it (`SPIKE/src/github/manifest.ts:18-21`). The code's comment says F-119's account link needs only the member's login and ID from the App's OAuth, `GET /user`, which takes no permission (`manifest.ts:18-21`). The spike's co-author step got the member's ID with `GET /users/<login>` instead (`SPIKE/src/github/pr-flow.ts:91-93`), so the OAuth route itself is **unverified** and is F-119's own test.
   - **No webhook in the manifest without a public URL.** GitHub refuses a loopback hook URL even when inactive, so the setup flow adds the webhook and its events after a public address exists (`manifest.ts:60-64`). F-006's "one flow" needs a line on that: the flow with no public URL creates an App with no events (`RUN[manifest, GitHub]`: events none).
   - `workflows: write`. The spike leaves it out on purpose, so a push that touches `.github/workflows/` is expected to fail (`manifest.ts:22-25`; `SPIKE/README.md:196`). The default isn't decided in the plan, and the push was not tried. Raise it as an open question.
   - `setup_url`. It is left out because the spike has no post-install page (`manifest.ts:26-27`).

10. **Keep ADR 0039 as it is.** The policy accepts exactly `refs/ostra/wip/<task>` (`SPIKE/src/policy.ts:28-32`). GitHub accepts a push to it (`RUN[hidden-ref, GitHub]`). Spike 2 still checks that no CI starts for it.

11. **Mark spike 4 as mostly done wherever the plan tracks status.** Bullet 1 is met, and the other four wait on the inputs of Section 5. `context/build-order.md:204` says the sandbox org exists and the test App comes from this spike's manifest flow, and both now do.

12. **Add open questions** to `context/open-questions.md` (`AGENTS.md`: undecided things go there):
    - whether a refused push is answered before its body is read, and the cap on the drained body (Surprise 4)
    - who counts as the driver when several members prompted a task (Surprise 8)
    - whether v1 asks for `workflows: write` (item 9)
    - whether the default LFS host list keeps `*.githubusercontent.com` (item 3)
    - how ostra treats the LFS storage a cleaned-up task leaves behind (item 5)

---

## 5. What's still open

**SKIPPED in today's run: 4 rows.** (`RUN` rows, `where` GitHub or the agent's container.) What each needs, per `context/build-order.md:204-209` (the sandbox org exists, the test App comes from `pnpm manifest`, the Linear workspace and its key exist, a tunnel is started only when a spike needs it, and the Linux machine with Docker is "later, by the maintainer's choice"):

| Criterion (part) | What it needs |
|---|---|
| The token in the agent's container (`token-container`) | spike 3's box: the agent's container beside its sidecar, on Docker on Linux. This machine has neither (`RUN[token-container]`; `context/build-order.md:209`) |
| A 500 MiB pack on GitHub (`large`) | `SPIKE_GITHUB_LARGE_PACK=1` with `SPIKE_LARGE_PACK_MB` at its default or 500, which pushes 500 MiB to the test repo, in 50 MiB files under the 100 MiB limit (`SPIKE/src/harness/spike.ts:289-290`; `SPIKE/README.md:84`). A pack under 500 MiB is no evidence for the bullet (`spike.ts:129-132`) |
| A check run flips on approval (`check`) | `GITHUB_TEST_REVIEWER_TOKEN`, a token of a second sandbox user who isn't the driver and can approve, plus the inputs already set (`SPIKE/src/inputs.ts:85-93,104`). A webhook instead of polling also needs `GITHUB_WEBHOOK_SECRET`, `OSTRA_DEV_WEBHOOK_PORT` and a tunnel to that port. `tunnel.env` holds `OSTRA_DEV_PUBLIC_URL`, but the App has no webhook yet (`RUN[manifest, GitHub]`: events none), and installing `cloudflared` asks the maintainer first (`context/build-order.md:208`) |
| Linear links the PR (`linear`) | `linear.env` loaded, with `LINEAR_API_KEY` and a `LINEAR_TEST_TEAM_ID` (the file's key names include `LINEAR_TEST_TEAM_KEY` and, I saw, no `..._ID`), and Linear's own GitHub app installed on the sandbox org (`SPIKE/README.md:77,88`) |

State of the inputs: the config directory holds `github.env`, `github-test.env`, the App's `.pem`, `github-app-manifest-result.json`, `linear.env`, `model.env` and `tunnel.env` (listing of `~/.config/ostra-dev/`). I read only key names, with values redacted, and I did not open `model.env`. The manifest result record names the App's permissions and no events.

**Settled on GitHub since the first version of this file** (`RUN`, and `SPIKE/README.md:185-190`):
- GitHub accepts the manifest without `email_addresses` and, with no public URL, without a webhook, and returns the permission keys above (Section 2, bullet 1).
- GraphQL `Commit.authors` resolves the co-author's no-reply address to the member.
- GitHub accepts a push to `refs/ostra/wip/*`.
- LFS works through GitHub's signed URLs, once `github-cloud.s3.amazonaws.com` and `lfs.github.com` are allowed and the `User-Agent` is passed on.
- The activity log is readable with a `contents: read` installation token.
- The token re-mint works against real installation tokens.

**Not covered by any row, though the bar's words reach them:**
- The 500 MiB push on GitHub: its limits, its timeout, and whether a push over `http.postBuffer` meets anything unexpected (Gotcha 17). The LFS bandwidth and storage quota (`SPIKE/README.md:166`).
- How far the repository activity log lags. The run waited for its positive control instead (`git-scenarios.ts:423-436`).
- Whether GitHub folds case in ref names (Gotcha 11).
- The check flip from a real `pull_request_review` webhook. Only polling and the local signature check have run (`SPIKE/README.md:181`).
- A token that expires in the middle of a long push or clone (Gotcha 15).
- The proxy's address in a box, and the per-task secret (Gotchas 13 and 14).
- Submodules on other repos (refused by design as "another repo"), and a push that touches `.github/workflows/` without `workflows: write` (`SPIKE/README.md:196`).
- The LFS hosts of any code host but github.com (item 3).
- Linux and macOS: the harness has run on Windows 11 only (Gotcha 19).
