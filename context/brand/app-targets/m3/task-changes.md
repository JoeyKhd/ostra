# Target: the Changes tab

> **Committed image:** `task-changes.webp`, downscaled from a 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

The target for the task page's **Changes** tab on `apps/web/src/app/(panel)/tasks/[task-id]/page.tsx`: the task's diff against each repo's base, line comments on it, and "Update branch". The page around it is `../m2/task-ticket.md` (itself `../m1/task.md` plus the ticket); this file adds the tabs and the Changes tab. Where the picture and this file disagree, this file wins.

| Picture | State shown |
|---|---|
| `task-changes.webp` | Alex Kim drives `CALC-174`, in review with the session idle on `alex-laptop`. The task changed two repos. `calculator-web` is 3 commits ahead of `main` and 2 behind, so "Update branch" shows. The viewer is writing a comment on `src/calculator/state.ts` line 40, under it sit Sam Rivera's sent comment and Alex's own draft, and further down an outdated comment from an earlier head. `pnpm-lock.yaml` is too large to show. Alex has 3 drafts on the task, and the review bar offers to send them. |

- **Generated** with Higgsfield `gpt_image_2_6` (3:2, 2k, high), in one generation. References: the approved `../m2/task-ticket` original (2048 px), `app-concepts/html/home-graphite.png` and the Hinge logo (`kit/logo/export/ostra-hinge-single-color-2048.png`). Prompt: `task-changes.prompt.txt`.
- **Features:** F-027 diff, F-072 diff comments, F-070 update branch. ADR 0051 (the diff and its comments) and ADR 0052 (update branch). Ticket 46 builds it; ticket 38 serves `diff.get` and `diff.comments.*`; ticket 39 serves `tasks.updateBranch` and `behindBy`; ticket 22 holds the core side.

## Purpose

A member reads what the task changed, repo by repo, as of the last turn, and tells the agent what to fix by commenting on lines, the way they would review a PR. The comments stay private drafts until the member sends them all as one message. When a repo's base moved on, the member asks the agent to merge it in with one press.

## Route

`/tasks/[task-id]?tab=changes`. The tab is a search param on the one task page, so a link (from a notification, a mail, the properties panel) can open it, and the header, the stream and the properties panel stay mounted across tabs. `?tab=activity` is the default and isn't written to the URL; `?tab=checks` is `task-checks.md`. An unknown value falls back to Activity.

## Layout

Unchanged from `../m2/task-ticket.md`: sidebar 232px, top bar 44px, main column `padding: 28px 40px 20px`, properties 300px. The main column is 828px wide at 1440.

### The header, on every tab

Key line, title, status line and ticket strip, as `task-ticket.md`. Then **the tabs** take the place of the header's hairline:

- Underline tabs, 36px, a full-width 1px `--line` under them, 20px gap between tabs. Each tab: 13px weight 500, `--muted`, `--text` on hover; the selected one `--text` with a 2px `--text` underline sitting on the hairline (the GitHub page's tabs, `github-view.tsx`, already draw this). `role="tablist"`, arrow keys move between tabs.
- `Activity`.
- `Changes` + 6px + the number of changed files across the task's repos, mono 12px `--faint`. No number while the diff loads or when nothing changed.
- `Checks` + the latest turn's result (`task-checks.md`).
- **The context row** ("What the agent got", `task-ticket.md`) moves into the Activity tab, above the thread: it describes the thread, not the task.
- **The composer** belongs to the Activity tab. The Changes tab pins its review bar in the same place (below), and the Checks tab pins nothing.

### The Changes tab, top to bottom

1. **Behind line** (only when a repo is behind), 36px, 12px below the tabs, no box: `git-merge` 15px `--muted`, the sentence (below) in 13px with the repo and base in mono 12.5px `--text`, then 12px gap and `Update branch` (outline button, 28px, `git-merge` icon). At the right edge, 12px `--faint`: `As of the last turn · ` + mono time of the last push.
   - Nothing behind: the line shows only the right-aligned `As of the last turn · {time}`, 28px tall.
2. **Two columns**, 12px below, filling the height down to the review bar:
   - **Files**, 220px, scrolls on its own. Per repo:
     - Repo heading, 8px top padding: mono 12.5px `--text` repo name; under it mono 12px `--faint` `{branch} → {base}` (the branch truncated in the middle, full name in `title`); under it 12px `--faint` `{a} ahead · {b} behind` or `{a} ahead · up to date with {base}`, then ` · ` + mono head SHA (7).
     - File rows, 26px, 12px mono: the status glyph in a 16px `--muted` column (`M` modified, `A` added, `D` deleted, `R` renamed, `C` copied), the file's name (the basename; when two changed files share one, the shortest parent path that tells them apart, `history/store.ts`; the full path in `title`), then right-aligned: `+{n}` `--green` and `−{n}` `--red` (U+2212), or `binary` / `too large` in `--faint`, then a `message-square` 13px `--faint` + the count of comments the viewer can see on that file (their drafts and every sent comment), when there are any.
     - The selected row: `--sel`, radius 6px. Clicking a row scrolls the diff to that file and selects it; scrolling the diff moves the selection.
     - 16px and a 1px `--line` between repos.
   - **Diff**, the rest (about 596px), a 1px `--line` on its left, one continuous list of every file in the files column's order, virtualized (`@tanstack/react-virtual`).
3. **Review bar**, pinned at the bottom where the Activity tab's composer sits, only while the viewer has drafts on the task: `--surface`, 1px `--line-2`, radius 8px, 52px, padding 10px 14px. Left: `message-square` 15px `--muted`, `{n} draft comments` 13px weight 600 `--text` + ` on {m} files` `--muted`, and under it the hint 12px `--faint`. Right: the primary button `Send {n} comments to the agent` (`arrow-up`).

### The diff view

ostra's own unified diff (ADR 0051), monospace, no syntax highlighting in milestone 3.

- **File header,** 34px, `--surface`, 1px `--line` above and below, sticky at the top of the diff while its file scrolls: `chevron-down` (open) or `chevron-right` (folded) 14px `--muted`, the path mono 12.5px `--text` (the full path), then `+{n}` `--green` and `−{n}` `--red` mono 12px. Renamed: ` ← {previous path}` mono 12px `--faint` after the path. Clicking the header folds the file.
- **Hunk header,** 24px, `--surface` at 60%, mono 12px `--faint`: the patch's `@@ -38,8 +38,14 @@ export const calculatorReducer` as GitHub sends it.
- **Lines,** 20px, mono 12px/20px: the old line number and the new line number, each a 40px right-aligned `--faint` column with 8px right padding; a 16px column with `+` or `−`; then the code with its leading whitespace kept and long lines wrapping (`white-space: pre-wrap`, `overflow-wrap: anywhere`), the wrapped part indented to the code.
  - Context: no fill, text `--text`.
  - Added: fill `rgba(79,178,134,0.10)`, numbers and `+` `--green`, text `--text`.
  - Removed: fill `rgba(229,103,92,0.10)`, numbers and `−` `--red`, text `--text`.
  - `\ No newline at end of file`: a 20px row, 12px sans `--faint`: `No newline at end of file`.
- **The gap between hunks,** 24px, 12px `--faint`, `unfold-vertical` 13px: `{n} unchanged lines`. Not a button in milestone 3 (open point 1).
- **Comment button:** hovering a line shows a 16px `message-square-plus` button over its new line number (old number for a removed line), `--teal`, on a `--surface` square with radius 4px. It's also reachable by keyboard: each line is focusable in the diff's roving focus, and `c` opens the comment field.
- **Files the diff doesn't draw**, the header only, then one 32px row, 12px `--faint`:
  - too large (over GitHub's limits, `OSTRA_DIFF_MAX_PATCH_KIB`, or past `OSTRA_DIFF_MAX_FILES`): `Too large to show here` + 12px gap + teal `Open on GitHub` with `arrow-up-right` 12px, to the file in the compare. In the picture the note sits in the header itself, which is fine when the file is folded.
  - binary: `Binary file, not shown` + `Open on GitHub`.
  - renamed without changes: `Renamed, no changes`.
  - deleted: all lines removed, as any hunk.

### Comments on a line

All three kinds sit under the line they're on, indented to the code column (left edge at the code, right edge 12px from the diff's edge), 8px above and below, in the order: sent, then the viewer's drafts, then the open field. Text is plain, never markdown or HTML: `white-space: pre-wrap`, 13px/1.5 `--text`.

- **Sent:** no box, a 2px `--line-2` left rule, 12px left padding. Header 20px: 20px avatar, author 13px weight 600, mono 12px `--faint` time, the chip `Sent` (`.chip`: 22px, 1px `--line-2`, `--muted` 12px). Then the text.
- **Draft** (only the author sees it): the same, with the chip `Draft` in `--faint`, and at the right two 24px ghost icon buttons, `pencil` (`Edit`) and `trash-2` (`Delete`), with tooltips. Edit swaps it for the field with the text in it.
- **Outdated** (a later head changed the line): it can't sit on a line any more, so it's drawn after the file's last hunk, under a 24px label 12px `--faint` `Outdated comments`. The same block in `--muted`, the chip `Outdated` in `--faint`, then mono 12px `--faint` `line {n} · {sha7}` (where it was written), the quoted line as it was in mono 12px `--faint` with its `+`/`−`, then the text in `--muted`. A sent comment and a draft can both be outdated; a draft keeps its edit and delete buttons, and sending it still sends it, quoting the line as it was.
- **The open field:** a box, `--surface`, 1px `--line-2`, radius 8px, padding 10px 12px. A textarea, 2 rows growing to 8, 13px sans, placeholder `Comment on line {n}…` `--faint`, focused on open. Bottom row: 12px `--faint` `Only you see a draft until you send it.` left; right `Cancel` (ghost) and `Save draft` (outline). `Save draft` is disabled while the text is empty. `⌘↵` / `Ctrl+↵` saves; `Esc` cancels, asking nothing if the text is empty and keeping the text in the field otherwise until a second `Esc`.

## Every state, with its copy

Copy goes in `apps/web/messages/en.json`. Everything in this section is **new**.

### The tab's body

| Condition | Shows |
|---|---|
| `diff.get` loading the first time | the behind line's place empty; the files column and the diff as 6 skeleton rows (`Skeleton`) |
| a repo's head not fetched yet (`diff.get` answers loading for it) | its repo heading, and in the diff one 32px row 12px `--faint`: `Fetching the diff from GitHub…`. The change notice replaces it |
| no repo has a pushed branch | centred in the tab, 13px `--muted`: `Nothing pushed yet. The diff shows here after the agent's first turn that changes code.` |
| a repo pushed but nothing differs from its base | its heading, and one row: `No changes against {base}.` |
| the compare is over the file limit | under the repo heading, 12px `--faint`: `GitHub sent the first {n} files.` + teal `See all on GitHub` |
| `diff.get` failed | one red 12px line: `The diff couldn't be loaded: {error}` + teal `Try again` |

### Behind and update branch

| Condition | The sentence |
|---|---|
| one repo behind | `{repo} is {n} commits behind {base}` (`is 1 commit behind`) |
| several repos behind | `{count} repos are behind their base: {repo} ({n}), {repo} ({n})` |

- **`Update branch`** sends one member message (`intent: "update-branch"`) naming every repo that's behind (ticket 24), by the composer's rule. Its title attribute: `Ask the agent to merge {base} into the task's branch and fix any conflicts.`
- **In flight:** `Updating…`, disabled.
- **Sent:** the button goes, and the sentence ends with 12px `--muted` ` · asked {agent} to merge it` until the next head clears `behindBy`.
- **The viewer can't send** (not the driver, with a session going): the button is disabled and the line adds 12px `--faint` `{name} is driving.` + teal `Take over`.
- **Refused** (nothing behind any more): the line goes after the change notice; nothing else.

### The review bar's hint and button

| Condition | Hint | Button |
|---|---|---|
| the viewer drives, the session is idle | `Sent together as one message. The session is idle, so they start the next turn.` | `Send {n} comments to the agent` |
| the viewer drives, a turn is running, the agent steers mid-turn | `Sent together as one message. {agent} reads them at its next step.` | the same |
| the viewer drives, a turn is running, the agent can't steer | `Sent together as one message, after the current turn.` | the same |
| no session going (stopped, in review with the box stopped or released) | `Sent together as one message. Sending reopens the task.` | the same |
| a session is going and the viewer isn't the driver | `{name} is driving. Take over to send your comments.` + teal `Take over` | disabled |
| merged or done (open point 2) | as no session going | the same |

- One draft: `1 draft comment`, `on 1 file`, `Send 1 comment to the agent`.
- **In flight:** `Sending…`, disabled. One `clientMessageId` per press.
- **Sent:** the drafts turn to `Sent`, the bar goes, and for 6 s a 12px `--muted` line holds its place: `Sent {n} comments as one message.` + teal `See it in Activity`.
- **Over 50 drafts:** the button is disabled, and a red 12px line: `At most 50 comments go in one message. Delete some to send the rest.`
- **Refused:** the red 12px line under the bar with the API's message (the spend cap, another active task on the ticket: `task-reopen.md`'s copy).

### A comment's field

- **Too long** (over 4,000 characters): from 3,600 a mono 12px `--faint` counter `{n} / 4,000` before `Cancel`, red past the limit, and `Save draft` disabled.
- **Saving:** `Saving…`, disabled.
- **Refused** because the line is gone from the latest diff: red 12px `This line changed since you opened it. Copy your comment and reload the diff.`
- **Delete a draft:** no dialog; the draft goes, and a 12px `--muted` line holds its place for 6 s: `Draft deleted.` + teal `Undo`.

### In the Activity tab

The message the send writes is ticket 46's thread marker (`m2/task-reopen` growing): the member's message with ` · {n} comments on the diff` `--faint` after the time, and its body as a list of `{path}:{line}`, the quoted line and the comment. Its copy lives with that growth, in ticket 46's `## Comments`.

### Properties

Unchanged from `task-ticket.md`. The Code group's rows for each repo's PR stay; the Changes group from `../m1/task.md` isn't drawn, since the tab holds it.

## Tokens and components

Tokens: `app-concepts/html/graphite.css`. Two new, for the diff only:

```css
--add-bg: rgba(79,178,134,0.10);  /* --green at 10% */
--del-bg: rgba(229,103,92,0.10);  /* --red at 10% */
```

Icons (Lucide): `git-merge`, `message-square`, `message-square-plus`, `chevron-down`, `chevron-right`, `unfold-vertical`, `arrow-up-right`, `pencil`, `trash-2`, `arrow-up`.

| Part | Component |
|---|---|
| Tabs | plain `role="tablist"` buttons, as `github-view.tsx` draws them; extract a shared `UnderlineTabs` into `components/ui/` |
| Update branch, Save draft, Send | `Button` (`outline`, `ghost`, `default`) |
| Files column | plain list; `ScrollArea` |
| Diff | new `components/tasks/task-changes/diff-view.tsx`, rows from the domain's parsed hunks, virtualized with `@tanstack/react-virtual` |
| Comment field | `Textarea` (`components/ui/field.tsx`'s style) |
| Comment avatars | `Avatar` 20px |
| Chips | `.chip` / `Badge variant="outline"` |
| Skeleton | `Skeleton` |

## Differences from the current code

1. **No tabs today.** `task-view.tsx` draws the header, a hairline and `TaskThread`. It gains the tab list in the hairline's place, `?tab=` in the URL, and a tab body; the thread and its composer move under Activity, with the context row.
2. **Everything in the Changes tab is new:** `components/tasks/task-changes/` (the files column, the diff view, the comment blocks, the review bar), on `diff.get`, `diff.comments.list`, `.save`, `.delete`, `.send` and `tasks.updateBranch`.
3. **`tasks.get`** gains `behindBy` per repo (ticket 39); the behind line reads it, so it shows on the Changes tab before the diff loads.
4. **A shared underline-tab component:** `github-view.tsx` has its own; the task page and GitHub's page should share one.

## Open points for the build

Settle each with the maintainer; don't guess in code.

1. **Expanding unchanged lines.** The compare's patch carries three lines of context, so the gap between hunks is unknown to the panel. Expanding it needs the file's contents at the head (another code host call per file). Milestone 3 shows the count only; say if it should expand.
2. **Comments on a merged or done task.** Sending reopens the task, and after a merge that means a fresh branch (F-066). Until ticket 46 meets it, the bar follows the composer's rule for that state.
3. **Who sees whose sent comments.** The picture shows Sam's sent comment to Alex. ADR 0051 makes drafts private and says nothing on sent ones; this target shows every sent comment to every member who can open the task, since the message that carried them is in the thread anyway.

## Wrong in the image

| In the image | Build |
|---|---|
| `PR #91` in the top bar with a square icon | `git-pull-request` icon, as `PR #483` |
| `is 2 commits behind` in mono | sans 13px `--muted`; only the repo, the count and `main` in mono |
| `As of the last turn · 7d41e0a` | `As of the last turn · ` + the push's time; the head SHA sits on the repo heading's third line |
| Repo heading's third line without the SHA | `3 ahead · 2 behind · 7d41e0a` |
| `Viewed` checkbox on the file header | not built: no viewed state in milestone 3 |
| The comment field's text in mono | 13px IBM Plex Sans |
| The open field drawn left of the code column | indented to the code, as the sent and draft comments |
| Sent and draft comments sharing one left rule | one rule per comment, 8px apart |
| `Show 18 unchanged lines` with a chevron | `18 unchanged lines`, `unfold-vertical` icon, not a button (open point 1) |
| The outdated comment straight under the gap row | after the file's last hunk, under `Outdated comments` |
| The outdated comment's name in `--text` | `--muted` |
| `Too large to show here` inside the header | a row under the header; the header holds only the path (inside the header is acceptable when folded) |
| The `Linear` sidebar icon as bars | the shared sidebar's icon |
| The hinge mark, redrawn | the real `kit/logo/export/ostra-hinge-single-color.svg`, 20px |
| `CALC-174`, names, paths, code, SHAs, counts, times, `alex-laptop`, `$0.84` | demo data, not copy |
