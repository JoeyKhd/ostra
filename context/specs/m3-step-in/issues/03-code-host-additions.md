# 03: Adapter SDK: code host additions

Status: ready-for-agent
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

- [ ] Tests: the suite passes against the fake code host and the tiny adapter.
- [ ] Every caller compiles; no existing operation changed shape.
- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `adapter-sdk` and its dependents.
- [ ] Committed as `✨ add code host compare, drafts, comments`.

## Comments
