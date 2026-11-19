# 09: GitHub adapter: compare, drafts, comments, push and the user link

Status: done
Builder: adapters
Blocked by: 03
Features: F-027, F-054, F-070, F-053, F-119
Packages: `packages/adapters/adapter-github`
Spec: `../spec.md`, section 5.2 ("`CodeHostAdapter`"); ADR 0052

## What to build

- **`compare`** over `GET /repos/{owner}/{repo}/compare/{base}...{head}`, paged, with GitHub's own limits (300 files, a patch over its size left out) reported as `truncated`, and the status mapped (`added`, `removed`, `modified`, `renamed`, `copied`, `changed`). The installation token is minted per call, as milestone 1's calls do.
- **`setPullRequestDraft`** through GraphQL's `convertPullRequestToDraft` and `markPullRequestReadyForReview`, idempotent: a PR already in the asked state is a success.
- **Webhooks:** the loose parses of `issue_comment` (only on a pull request: `issue.pull_request` present), `pull_request_review_comment` and `push`, behind the existing `X-Hub-Signature-256` check.
- **`addReaction`** on an issue comment or a review comment, treating GitHub's "already reacted" answer as a success.
- **The user link:** `userAuthorizeUrl` (the App's client ID, `state`, the redirect URI) and `exchangeUserCode` (the code for a user token, `GET /user` for the ID and login, then `DELETE /applications/{client_id}/token` with the App's client ID and secret). A revocation that fails returns an error, and the caller stores nothing (ADR 0052). No `email_addresses` permission is asked (ADR 0040).
- **The manifest** (`appManifest`) gains the link's callback URL in `callback_urls`, so a new App has it. An existing App needs it added once (ticket 51).
- Port the PR comment shapes from `spikes/github-app-and-git-proxy/src/github/pr-flow.ts`, with the provenance comment.
- The code host contract suite (ticket 03) runs against the adapter on the fake GitHub, and its live cases against `ostra-test/test1`.

## Done when

- [x] Tests: the suite passes on the fake GitHub; live, gated on the test App's credentials: compare of a branch in `test1`, a draft and back on a PR the test opens, a reaction on its comment, and both comment webhooks parsed from deliveries the test triggers. The user link's live case is ticket 51's manual run. *(Done 2026-11-19: the deliveries case is written and skips, saying why, until the test App has its webhook: ticket 51, step 9.)*
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add GitHub compare, drafts and the user link`.

## Comments

- 2026-11-19: done in `✨ add GitHub compare, drafts and the user link`. `compare` reads GitHub's compare (files on the first page, up to 300; a patch over 500 KB left out reads as `truncated`; an unknown status reads as `changed`), with a read-only token for the one repo. `setPullRequestDraft` uses GraphQL's two mutations and is idempotent; the first live run found that GitHub refuses them (FORBIDDEN, "Resource not accessible by integration") to a token with only `pull_requests: write`, so the adapter mints `contents: write` too, and the fake GitHub now refuses as GitHub does; a FORBIDDEN answer reads as `forbidden`. The `issue_comment`, `pull_request_review_comment` and `push` webhooks are parsed loosely behind the signature check; `addReaction` treats GitHub's 200 (already reacted) as `created: false`. The user link builds the sign-in URL with no scope, trades the code, reads `GET /user`, and revokes the token before it answers; a failed revocation links nothing. The manifest's `callback_urls` gained `/api/github/link/callback`. Live on `ostra-test/test1` (`packages/adapters/adapter-github/evidence/m3-compare-drafts-reactions-live.txt`): compare, a draft and back, and a reaction on each kind of comment passed. The comment-webhook deliveries case skips: the test App has no webhook and no events (`GET /app` answers `events: []`), so it waits for ticket 51, step 9. This machine's clock is an hour behind GitHub's, which makes GitHub refuse the App's JWT as "Bad credentials"; the live test runs on GitHub's clock. Proofs: `context/proof/F-027.md`, `F-053.md`, `F-054.md`, `F-070.md`, `F-119.md` (the adapter's halves, `partial`).
