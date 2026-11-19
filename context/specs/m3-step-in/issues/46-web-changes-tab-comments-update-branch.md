# 46: Web: the Changes tab, diff comments, update branch and after the merge

Status: ready-for-agent
Builder: web
Blocked by: 38, 39, 41
Features: F-027, F-072, F-070, F-066
Packages: `apps/web` (`components/tasks/task-changes/` (new), `components/tasks/task-view.tsx`)
Spec: `../spec.md`, section 12 (`task-changes`; and `m2/task-reopen` growing); ADR 0051

## What to build

- **Tabs** on the task page: Activity, Changes, Checks (Checks is ticket 47's).
- **The Changes tab** (`task-changes`): per repo, its branch and base, ahead and behind, "Update branch" when behind; the files list with counts; ostra's own unified-diff view (monospace, line numbers on both sides, added and removed in the palette's diff colours, a hunk's header, collapsed unchanged context), with list virtualization for long diffs (`@tanstack/react-virtual`, already approved); "Too large to show here" with the code host's link; "as of the last turn".
- **Comments:** click a line's gutter to write one; drafts listed with "Send N comments to the agent"; sent comments inline with their author; outdated ones marked and still readable. Text is plain, never HTML.
- **After the merge** (`m2/task-reopen` grows): the thread's marker for the fresh branch, and the properties' list of every PR per repo.
- **Thread markers** for a message's intent: from diff comments, update branch, a PR comment, fix checks, keep working.

## Done when

- [ ] The screens match their targets, checked by eye, with the differences recorded here.
- [ ] Playwright, on the fake code host: a diff renders with a rename and a binary file; two comments sent as one message; an outdated mark after a new head; "Update branch" appears when behind and sends one message.
- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `web`.
- [ ] Committed as `✨ add the Changes tab and diff comments`.

## Comments
