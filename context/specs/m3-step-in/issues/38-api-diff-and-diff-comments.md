# 38: API: the diff and diff comments

Status: ready-for-agent
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

- [ ] Tests: a member reads another's sent comments and not their drafts; save checks the line exists in that head; send is idempotent per set of drafts; a non-driver's send on a running task is refused with "Take over to send"; another organization's task is invisible.
- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `api`.
- [ ] Committed as `✨ add the diff and comments API`.

## Comments
