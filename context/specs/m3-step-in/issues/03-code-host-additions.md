# 03: Adapter SDK: code host additions

Status: done
Builder: adapters (contracts, first)
Blocked by: none
Features: F-027, F-054, F-070, F-053, F-119
Packages: `packages/adapter-sdk` (`src/code-host/`, `src/test-adapters/`, `src/testing/`)
Spec: `../spec.md`, section 5.2 ("`CodeHostAdapter`")

## What to build

- **`compare(access, base, head)`** with the result shape of section 5.2. The code host's limits (files, patch size) are reported per file as `truncated` and in the result, never hidden.
- **`setPullRequestDraft(access, number, draft)`.**
- **`parseWebhook`** gains three hints: `issue_comment` (the PR's number, the comment's ID, its author's ID and login, its body), `pull_request_review_comment` (the same, plus path, side and line) and `push` (the ref, the before and after SHAs, the changed paths when the payload has them). Loose parses: unknown fields are tolerated (`AGENTS.md`).
- **`addReaction(access, commentRef, "eyes")`,** idempotent by the comment.
- **`userAuthorizeUrl` and `exchangeUserCode`** for the verified link: the second returns `{ userId, login }` and revokes the token before it returns; a revocation that fails is an error, never a silent success.
- **Capabilities:** `compare`, `draftPullRequests`, `prComments`, `userLink`, declared by GitHub and the tiny adapter in the same commit.
- **The fake code host** (`src/testing/`) gains compare with configurable limits, drafts, the three webhooks (signed), reactions, and the user OAuth endpoints, with a counter of tokens issued and revoked.
- **The code host contract suite** gains: compare of an ahead, a behind and a diverged branch; a truncated file; a draft and back; each webhook's parse, and a bad signature refused; a reaction twice is one reaction; the user link's token is revoked.

## Done when

- [x] Tests: the suite passes against the fake code host and the tiny adapter.
- [x] Every caller compiles; no existing operation changed shape.
- [x] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `adapter-sdk` and its dependents.
- [x] Committed as `✨ add code host compare, drafts, comments`.

## Comments
- 2026-11-19, adapters (contracts): done in `✨ add code host compare, drafts, comments` (ce5d65e). **Capabilities:** `compare`, `draftPullRequests`, `prComments`, `userLink`; the tiny host declares all four, GitHub and the test fakes in `packages/api` and `apps/core` declare them false until ticket 09 builds GitHub's, and each answers `unsupported` from the base class meanwhile. **Base class** (all additive, defaulting to `unsupported`): `compare(access, base, head)` -> `CompareResult` (`aheadBy`, `behindBy`, `mergeBase`, `files` with `previousPath`, `status`, counts, `patch` and `truncated`, plus `filesTruncated` and the host's `limits`); `setPullRequestDraft(access, number, draft)` -> the PR; `addReaction(access, { kind: "issue" | "review", commentId }, "eyes")` -> `{ created }`; `userAuthorizeUrl(client, state, redirectUri)` and `exchangeUserCode(client, code, redirectUri)` -> `{ userId, login }` with the App's OAuth client (`CodeHostOAuthClient`); `PullRequest` gains optional `draft`; `CodeHostWebhookEvent` gains `issue_comment` (`onPullRequest` and a `PullRequestComment`: ID, author ID and login, body, URL), `pull_request_review_comment` (plus `path`, `side` `old`/`new`, `line`) and `push` (`ref`, `before`, `after`, `changedPaths` or `null`). **The fake** is the tiny host (`src/test-adapters/tiny-adapters.ts`, the memory host world): compares by `"<base>...<head>"` with configurable `compareLimits`, drafts, the three webhooks read loosely in GitHub's shape, reactions with `reactionCount`, and the OAuth exchange with `userTokens` counters and `failNextRevocation`. GitHub's own fake server grows with ticket 09. **The suite** gains six cases: compare's counts for ahead, behind and diverged; the limits (a file over the patch limit truncated, the list cut and said so); a draft and back; the three webhooks' parse with a bad signature refused and a body that isn't its event refused; a reaction twice is one; the link's token revoked, a failed revocation an error. The existing pull_request case's "other" event is now `star`, since `push` is read. Break-it checks: eleven (the patch limit, the cut list, ahead and behind swapped, the draft, the reaction, the line comment's side, the push's paths, the revocation, a failed revocation, the state, the base class's `unsupported`), each failing its case.
