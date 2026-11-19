# 38: API: the diff and diff comments

Status: done
Builder: api
Blocked by: 22
Features: F-027, F-072
Packages: `packages/api` (`routers/diff.ts` (new))
Spec: `../spec.md`, section 4 ("The diff", "Diff comments"); ADR 0051

## What to build

- **`diff.get(taskId)`:** per task repo, its base, head, ahead and behind, and its files (path, previous path, status, counts, hunks parsed by the domain, or "too large" with the code host's URL); a head not fetched yet enqueues `diff.fetch` and answers "loading", and the change notice tells the page when it's in.
- **`diff.comments.list(taskId)`:** the member's own drafts and every sent comment, with outdated marks; **`.save`**, **`.delete`** (own drafts only); **`.send(taskId)`**, which sends the member's drafts as ticket 22 says and returns the message's sequence.
- Any member who can open the project reads the diff and writes drafts; sending follows the composer's rule (ticket 22).

## Done when

- [x] Tests: a member reads another's sent comments and not their drafts; save checks the line exists in that head; send is idempotent per set of drafts; a non-driver's send on a running task is refused with "Take over to send"; another organization's task is invisible.
- [x] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `api`.
- [x] Committed as `✨ add the diff and comments API`.

## Comments

- 2026-11-19: done in `1f4f1aa`. `routers/diff.ts`: `diff.get` (per task repo: branch, base, head, ahead, behind from the webhook's figure or the compare's, files with their parsed hunks and a `kind` of `text`, `too-large`, `binary` or `renamed-unchanged`, the code host's URL, `asOf` the last push), and `diff.comments.list`, `.save`, `.delete`, `.send` over ticket 22's domain functions. `.list` adds the author's name, times and, for an outdated comment, the line as it was; `.send` returns the message's `seq` (`sendDiffComments` gained `seq`, additive). A comment id or task repo of another task is `NOT_FOUND`; a send with no drafts is `PRECONDITION_FAILED`, and a non-driver's send on a running task `FORBIDDEN` with "Take over to send". Proof rows added to F-027 and F-072; 6 break-it checks, all caught (`context/proof/F-072.md`).
