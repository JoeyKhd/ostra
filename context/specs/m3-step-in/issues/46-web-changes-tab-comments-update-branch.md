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

## Decided 2026-11-19

Decided on the maintainer's delegation while preparing the build, from the open points of the milestone 3 targets (`context/brand/app-targets/m3/`) and the spec's gaps. If the maintainer disagrees with one, it goes back to `context/open-questions.md` and this section changes.

- **Expanding unchanged lines** (`task-changes.md`, point 1): not in milestone 3. The gap shows its count only, and expanding it would need each file's contents at the head.
- **Comments on a merged or done task** (point 2): sending follows the composer's rule for a task with no session going, so it reopens the task. After a merge, that's F-066's fresh branch, and the message carries each comment's head, so the agent knows it refers to the merged work.
- **Sent comments** (point 3): every member who can open the task sees every sent comment, since the message that carried them is in the thread. Drafts stay their author's (ADR 0051; ticket 38 already returns them so).

## Comments

- 2026-11-19: the Changes tab's parts are in, `20f6c8d` (`✨ add the Changes tab's parts`), with `@tanstack/react-virtual` 3.14.26 and its lockfile: `diff-words.ts` (the rows, the files column's names, behind and the review bar's words), `diff-view.tsx` (the virtualized diff with a sticky file header, roving focus and `c` to comment, the sent, draft and outdated comments, the field with its counter and Esc rule), `task-changes.tsx` (behind line and Update branch, files column, review bar, every tab state), the shared `UnderlineTabs` (GitHub's page uses it now) and `--add-bg`/`--del-bg`. 19 tests name F-027, F-072, F-070; break-it checks on comment order, virtualization, the 50-comment cap, the driver rule and Esc each failed a test. Checked by eye against `task-changes`: the diff's code is 13px/21px (the picture's size, over the spec's 12px). **Not done yet:** the tabs in `task-view.tsx`, the thread markers, after-the-merge and the Playwright run wait on tickets 38 and 39 (`diff.*`, `tasks.updateBranch`, `behindBy`), not on `main` yet.
- 2026-11-19, integrate (ticket 50): the Activity/Changes/Checks tabs, the Changes tab over `diff.get` and `diff.comments.*`, and Update branch are wired; the thread marks a message's intent (`3af06b0`), and used live in milestone 3's demo (`../demo.md`). Not done: this ticket's Playwright cases, the by-eye check against the targets, and the differences `demo.md` lists.
