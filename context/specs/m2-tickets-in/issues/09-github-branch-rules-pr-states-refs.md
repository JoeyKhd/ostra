# 09: GitHub adapter: branch rules, PR states, webhooks and refs

Status: done
Builder: adapters
Blocked by: 04
Features: F-055, F-060, F-031, F-044, F-079
Packages: `packages/adapters/adapter-github`
Spec: `../spec.md`, sections 5.2 and 3 (the checks after the run)

## What to build

The code host operations of ticket 04, on milestone 1's adapter.

- **`readBranchRules`:** `protected` from the branch itself (`GET /repos/{o}/{r}/branches/{b}`), and `requiresSignedCommits` from the rules that apply to the branch (`GET /repos/{o}/{r}/rules/branches/{b}`, rule type `required_signatures`) and from classic protection's `required_signatures` when the App may read it. When a read is refused for lack of a permission, the answer is `"unknown"` with the reason, never a guess. **No new App permission** without the maintainer's yes: if `administration: read` turns out to be needed, the ticket stops and asks.
- **`getPullRequest`:** state, `merged`, `merged_at`, `closed_at` and the head SHA, by number.
- **`parseWebhook`:** `pull_request` actions `closed` (merged or not), `reopened` and `synchronize`, read loosely, keyed by `X-GitHub-Delivery`, after milestone 1's `verifyWebhook` (`X-Hub-Signature-256`).
- **`deleteRef`:** deletes `refs/ostra/wip/<taskId>` with the installation token, idempotent: a ref already gone is success.
- Each call goes through the rate budget and retries with the shared plumbing. Every request carries a `User-Agent`.

## Decided 2026-11-19 (ticket 40)

The lead, on the maintainer's delegation, settled the open points the milestone 2 targets (`context/brand/app-targets/m2/`) and ticket 40 left. They're part of what to build:

- **No new App permission.** `administration` stays out. ADR 0040 fixes the App's seven permissions, and what follows needs none beyond them, so the ticket doesn't stop to ask. `readBranchRules` reads:
  - `protected`: `true` when `branches/{b}.protected` is true, or when `rules/branches/{b}` holds a `deletion`, `non_fast_forward`, `pull_request` or `update` rule.
  - `requiresSignedCommits`: `true` when `rules/branches/{b}` holds `required_signatures`. When `branches/{b}.protected` is `false`, classic protection can't require signatures, so it counts as `false`. When classic protection is on, its `required_signatures` needs `administration: read`, so the answer is `"unknown"` with that reason, unless a ruleset already answers `true`.
  - **A plan that has no rules:** GitHub answers 403 "Upgrade to GitHub Pro or make this repository public" for a private repo in a free org. It is `false` for both, with the reason `GitHub doesn't offer branch rules on this repo's plan, so none apply.` It is never `"unknown"`. Seen on `ostra-test/test1` and `test2` on 2026-11-19.
- Ticket 40 asks the maintainer to protect `test1` with a ruleset, so the live case can answer both checks with the App's current permissions.

## Done when

- [x] The code host suite passes against the fake.
- [x] The live cases, gated on `github.env` and `github-test.env`: `test1`'s and `test2`'s default branches read as their real protection; a PR opened and merged by the test is read as merged; a hidden ref pushed by the test is deleted, and deleting it again succeeds.
- [x] Committed as `✨ add GitHub branch rules, PR states and refs`.

## Comments
- 2026-11-19, adapters (HASH09): done in `HASH09` (`✨ add GitHub branch rules, PR states and refs`). For tickets 14, 16, 13, 31 and 39:
  - **`readBranchRules`** follows the 2026-11-19 decision exactly. `branches/{b}` gives the classic flag, `rules/branches/{b}` the rulesets (`required_signatures` signs; `deletion`, `non_fast_forward`, `pull_request` or `update` protect). It reads with `contents: read` and `metadata: read` only, and never asks for `administration`, so it never calls classic protection's `required_signatures`: a branch flagged protected that no ruleset signs reads `requiresSignedCommits: "unknown"` with the reason. A 403 "Upgrade to GitHub Pro" on the rules (the free private repo) reads `false` for both with the reason `GitHub doesn't offer branch rules on this repo's plan, so none apply.`; any other 403 (not the rate limit) reads `"unknown"` with a reason. The vendor's words never reach a reason, an error or a log line. `capabilities.branchRules` is now `true`.
  - **`getPullRequest`** adds `merged`, `headSha`, and `updatedAt`, `mergedAt`, `closedAt` as ms since the epoch.
  - **`parseWebhook`** reads `X-GitHub-Event` whatever its case; any event but `pull_request` is `other` (its body isn't read), and any `pull_request` action is read, with `closed` + `merged` as state `merged` and `changedAt` from the PR's `updated_at`. **The result has no delivery ID:** core reads `X-GitHub-Delivery` itself from the headers it already holds to key the inbox row (ticket 13), as it does for Linear.
  - **`deleteRef`** accepts only a ref under `refs/ostra/` (a branch or a tag answers `invalid-input`), mints `contents: write` for that repo, and a ref already gone (GitHub's 422 "Reference does not exist", or 404) is `{ deleted: false }`.
  - **The fake GitHub** (`createFakeGitHub`) gained: `protectedBranches`, `rulesets`, `plan: "free"`, `rulesRefused` and `refs` per repo; the branch, rules, PR-by-number and ref-delete routes; and `finishPullRequest` and `reopenPullRequest` on the server, which stamp `mergedAt`, `closedAt` and `updatedAt`. `FakePullRequest` gained `headSha`, `updatedAt`, `mergedAt` and `closedAt`, and its `merged_at` now comes from `mergedAt` (code that set only `merged` must call `finishPullRequest`).
  - **Live, on `ostra-test`** (with `github.env` and `github-test.env`): `test1` and `test2` read false/false with the plan reason (both are private on a free plan, so ticket 40's step 1 still stands: until then the live case can't see a real rule); a PR opened and squash-merged on `test2` by the test reads open, then merged with its times and the head SHA; a hidden ref created by the test is deleted, and deleting it again succeeds. Merging adds one commit to `test2`'s `main` per run (one fixed file, `live-test/merged-probe.md`).
