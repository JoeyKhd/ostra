# 22: Core: the diff and diff comments

Status: done
Builder: core
Blocked by: 07, 09
Features: F-027, F-072
Packages: `apps/core` (`src/diff/` (new)), `packages/domain` (`saveDiffComment`, `sendDiffComments`)
Spec: `../spec.md`, section 4 ("The diff", "Diff comments"); ADR 0051

## What to build

- **`diff.fetch`:** for a task repo with a pushed head, the code host's `compare(base, head)` through the App, stored in `DiffCache` by repo, base SHA and head SHA, so many viewers cost one call. A head that hasn't changed is never fetched again. Files over `OSTRA_DIFF_MAX_FILES` or a patch over `OSTRA_DIFF_MAX_PATCH_KIB` are kept as "too large", with the code host's URL.
- **The unified-diff parser** (pure, in `packages/domain`): a patch into hunks and lines with old and new numbers, tested on GitHub's patches (renames, binary files, no newline at the end).
- **Comments:** `saveDiffComment` creates, edits or deletes a member's own draft, anchored by task repo, path, side, line and the head it was written on, after checking the line exists in that head's diff. `sendDiffComments` moves the member's drafts on the task to `sent` in one transaction, writes `diff.comments_sent` and one member message (`intent: "diff-comments"`) rendered by the domain's prompt (each comment with its path, line and the quoted lines, inside marked blocks), and sends it as the composer does: a steer for the driver on a running or idle session, a reopen with no session going. A non-driver on a task with a session going is refused with "Take over to send". At most 50 comments a send.
- **Outdated:** when a new head arrives (`session.saved`, or a push), each sent or draft comment whose line no longer matches in the new diff gets `outdatedAt`.

## Done when

- [x] Tests: one compare per head for many readers; the too-large cut; the parser's cases; drafts are private to their member until sent; a send makes one message and marks every draft sent, and a second send of the same drafts sends nothing; a comment on a line that changed is outdated and one on an untouched line isn't; another organization's comments are invisible.
- [x] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `core` and `domain`.
- [x] Committed as `✨ add the diff and diff comments`.

## Comments

- 2026-11-19: done in `68155cc` (`✨ add the diff and diff comments`), on `4987c0c`, which widens three milestone 3 contracts additively: `diff.fetch` takes `baseSha: null` (the merge base the host finds, since ostra keeps no base SHA), the reopen input takes an `intent`, and the send use cases add the reopen's refusals to their errors. A new head also queues `diff.fetch` from `session.saved` only when the task repo has comments on an older head; the push webhook (ticket 24) does the same.
