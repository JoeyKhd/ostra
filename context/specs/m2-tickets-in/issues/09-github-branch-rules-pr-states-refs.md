# 09: GitHub adapter: branch rules, PR states, webhooks and refs

Status: ready-for-agent
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

- [ ] The code host suite passes against the fake.
- [ ] The live cases, gated on `github.env` and `github-test.env`: `test1`'s and `test2`'s default branches read as their real protection; a PR opened and merged by the test is read as merged; a hidden ref pushed by the test is deleted, and deleting it again succeeds.
- [ ] Committed as `✨ add GitHub branch rules, PR states and refs`.

## Comments
