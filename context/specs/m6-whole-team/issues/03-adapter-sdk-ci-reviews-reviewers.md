# 03: Adapter SDK: CI, comment-type reviews, reviewers and CODEOWNERS

Status: done
Builder: adapters
Blocked by: none (milestone 4's ticket 03, reviews and check runs, lands first)
Features: F-035, F-100, F-102, F-105
Packages: `packages/adapter-sdk` (`src/code-host/`, `src/testing/code-host-suite.ts`, the fake code host, `src/test-adapters/tiny-adapters.ts`)
Spec: `../spec.md`, section 5.2 (`CodeHostAdapter`)

## What to build

- `listCiResults`, `getCiLog`, `createReview`, `diffLines`, `listRequestedReviewers`, `readCodeOwners` and `listReviewComments`, with the shapes of spec section 5.2.
- **`createReview` takes the event `"COMMENT"` and nothing else,** by its type: no caller can pass `APPROVE` or `REQUEST_CHANGES` through the interface (ADR 0028). A test compiles a call with another event under `@ts-expect-error` to show it, and the fake refuses one at runtime too.
- **`getCiLog`** returns at most the caller's byte cap, from the end, with `truncated` and the size before the cut; never a log line in an error message.
- **`parseWebhook`** gains the `check_run`, `check_suite`, `status`, `review_requested` and `review_request_removed` hints.
- **Capabilities, new:** `ciResults`, `ciLogs`, `reviewComments`, `requestedReviewers`, `codeOwners`. The tiny adapter declares them all false, so core's paths for a host without them are tested.
- **The fake code host** gains everything spec section 5.2 lists, including GitHub's refusal of a line comment outside the diff (422), a check run from another app that stays `queued`, and a status that never completes.
- **The code host contract suite** gains a case per operation, the refusal outside the diff, the log cap and the webhook hints.

## Done when

- [x] The suite passes on the fake and the tiny adapter, and on GitHub's adapter once ticket 08 lands.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add CI, reviews and reviewers to code hosts`.

## Comments

- 2026-11-20: built in `✨ add CI, reviews and reviewers to code hosts`. Each operation is a method on `CodeHostAdapter` answering `unsupported` until an adapter overrides it, behind the five new capabilities. `createReview` returns `CreateReviewError`, which adds `{ code: "line-outside-diff", commentIndex }` to the shared errors; `getCiLog(access, ref, maxBytes)` answers `{ found: true, text, truncated, totalBytes }` or `{ found: false, reason: "expired" | "no-log" }`, cut by the shared `logTail`. The webhook hints are two new union members, `ci` (with the event, the head and the app's slug) and `pull_request_reviewers`; core's PR handler ignores both until its tickets 16 and 19. "The fake code host" is the tiny host given a `FakeCiHost` (`testing/fake-ci-host.ts`): it declares and serves all five; the plain tiny host declares none. The suite runs on both, and on GitHub's adapter, which declares them false until ticket 08 (its absence paths pass now). `@ts-expect-error` shows another event doesn't compile, in the suite and in `code-host/comment-review.test.ts`.
