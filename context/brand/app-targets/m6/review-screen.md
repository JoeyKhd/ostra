# Target: the review screen (milestone 6, screen 9)

> **Committed image:** `review-screen.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

- **Prompt:** `review-screen.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 1 generation, kept. References: the approved 2048 original of `app-targets/m3/task-changes` (the screen this one starts from, spec section 12), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`.
- **Route (new):** `apps/web/src/app/(panel)/tasks/[task-id]/review/page.tsx` → `components/tasks/review/review-screen.tsx`. The PR's tab lives in the URL (`?pr={taskRepoId}`), the selected file too (`&file={path}`). Ticket 35 names the file `src/routes/tasks/$taskId/review.tsx`; the panel is a Next.js app router, so it's this path (see "Differences").
- **Features:** F-102 (the review screen and reviewers), F-100 (the AI review's findings), F-111 ("Remember this" on an AI finding). Spec section 4 ("The AI review", "Reviewers"), section 11 items 14 and 17; ADR 0058, ADR 0051 (the diff and its comments), ADR 0044 (memory proposals). Ticket 28 (`review.screen`, `review.fixThis`, `review.rememberFinding`), ticket 19 (reviewers), ticket 35 (this screen).
- **Status:** a proposed target, waiting on approval (ticket 30's `## Comments`). Ticket 35 builds its data and tests until then, not its UI.

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

Where a person reviews a task's pull requests before approving them on GitHub. By the time a PR reaches its reviewer, ostra has already run CI and an AI review and sent the blocking findings back to the agent (ADR 0058), so the reviewer reads a diff that has been through that loop, with **what the AI found still on the lines it found it on**: open nits, the blocking findings the agent fixed (resolved), and findings a later push moved past (outdated).

The screen answers three questions side by side: what changed (the diff, per PR), what it was meant to do (the ticket's acceptance criteria), and who still has to look (the reviewers). The reviewer then does one of three things:

1. **Comments on lines** and sends them all to the agent as one prompt (`Send to agent`, milestone 3's diff comments, ADR 0051).
2. **Turns a finding into a comment** with `Fix this` (it joins their drafts, sent with the rest), or into a memory proposal with `Remember this` (F-111).
3. **Approves on GitHub.** ostra never approves or merges (ADR 0040, ADR 0058): `Open on GitHub to approve` takes them to the PR's "Files changed" with the review form.

The picture shows `CALC-182` in `calculator`, driven by Sam Rivera, waiting for Alex Kim's review (CODEOWNERS named `@acme/frontend`; Alex is the matched member). The task has two PRs; `calculator-web #512` is open. The AI review's second round found one nit (open); its first round's blocking finding was fixed in round 2 (resolved). Alex has two draft comments.

## Layout (CSS px at 1440×960)

The panel's measured scale (`../m1/README.md`, "Scale") holds: body 14.5px (`text-body`), dense rows 14px (`text-ui`), secondary 13px (`text-sm`), small labels 12px (`text-xs`), title 26px (`text-title`). Diff rows keep milestone 3's 20px, mono 12px.

| Region | Size | Contents |
|---|---|---|
| Sidebar | 234px, the shared shell | Built from `sidebar.tsx`, never from the picture. The project's **Tasks** row selected |
| Top bar | 46px, hairline under | Crumbs `calculator › Tasks › CALC-182 › Review` (`CALC-182` links to the task page; `Review` `--text` 500). Right: one outline `Button`, the GitHub mark 15px, `Open on GitHub to approve`, `arrow-up-right` 13px. No primary in the bar |
| Main column | `1fr`, padding `28px 36px 20px` | Header, PR tabs, files column and diff, the review bar (pinned) |
| Properties panel | 320px, 1px `--line` on its left, padding `20px 18px` | Ticket and its acceptance criteria, Reviewers, This pull request |

### Header

1. **Key line,** Plex Mono 12px `--faint`: `CALC-182 · from Linear` (`· from a prompt` for a prompt task).
2. **Title,** the task's title (`PageHeading`).
3. **The round line,** 13px, one line, the parts joined by ` · ` in `--faint`: the sub-state's dot and words, then the latest CI verdict, the latest review run, and the automatic turns.
   - The dot: amber + `Waiting for your review` (`--text` 500) when the viewer is one of the task's matched reviewers who hasn't approved; `--muted` dot + `Waiting for a reviewer` for anyone else. Amber here is the viewer's needs-you (`waiting_for_reviewer`, F-036), the same item Home lists.
   - CI: `CI passed`, `CI running`, `CI failed`, `No CI`, `CI timed out` (`--muted`).
   - Review: `AI review round {n}: nothing blocking`, `AI review round {n}: {b} blocking`, `AI review off` (the project's switch), `AI review running`.
   - `automatic turns` + Plex Mono `{used} of {limit}` (`OSTRA_AUTOMATIC_TURNS`).
4. **PR tabs,** 16px under the round line, milestone 3's underline tabs (36px, a full-width 1px `--line`, 20px gap). One tab per task repo with a PR, in the project's repo order: the repo name in Plex Mono 13px, 6px, `#{pr}` Plex Mono 12px `--faint`, 6px, the changed-file count Plex Mono 12px `--faint`. A merged or closed PR's tab adds a `--faint` `merged` / `closed`. One PR only: the row still shows, with one tab, so the page never jumps.

### Files column and diff

Milestone 3's Changes tab (`../m3/task-changes.md`), reused, not copied: the same `diff-view.tsx`, file rows, hunk headers, line rows, sticky file headers, comment button, drafts, sent and outdated comments. What changes here:

- **The files column is a tree,** 210px: folders as 26px rows (`chevron-down`/`chevron-right` 13px `--faint`, the folder path in Plex Mono 12px `--faint`, collapsed to the shortest path that has files: `src/settings`), files indented 14px under them. A file row adds, after milestone 3's counts and comment count, nothing else: findings count as comments (`message-square` + the open findings plus the viewer's drafts plus sent comments).
- **No behind line** and no `Update branch` here: that stays on the task's Changes tab. The diff's top shows only, right-aligned, 12px `--faint`: `As of ` + Plex Mono head SHA (7) + ` · pushed {age}`.
- **Findings sit on their lines** (below), between the line and milestone 3's comments on that line, in the order: findings (newest round first), sent comments, drafts, the open field.
- **Findings off the diff** (`postedAs: review_body`, a line the PR's diff doesn't show): drawn at the top of their file, before the first hunk, under a 24px label 12px `--faint` `Not on a changed line`, with `line {n}` Plex Mono `--faint` in the header. A finding on a file not in the diff goes under a last pseudo-file `Other files` with its path.

### A finding

No box. A 2px `--line-2` left rule, 12px left padding, indented to the code column as milestone 3's comments, 8px above and below.

1. **Header,** 22px: Lucide `scan-search` 14px `--muted`; `AI review` 13px weight 600 `--text`; Plex Mono 12px `--faint` `round {n}`; the severity chip; the state chip. Chips are milestone 3's `.chip` (22px, 1px `--line-2`, 12px).
   - Severity: `Blocking`, text `--red`, with Lucide `octagon-alert` 12px `--red` before it. `Nit`, text `--muted`, no icon. Blocking is red because it's a defect the agent must fix, the one place red means something other than a failed run; the icon and the word carry it too.
   - State: `Open` (`--muted`); `Resolved in round {n}` (Lucide `check` 12px `--green`, text `--muted`); `Outdated` (`--faint`).
2. **Title,** 14px weight 500 `--text`.
3. **Body,** 13px/1.5 `--muted`, plain text (`white-space: pre-wrap`), never markdown or HTML. Backtick spans in Plex Mono. A `suggestion` shows under it as a milestone 3 code block (`--surface`, 1px `--line`, radius 8px, mono 12px), labelled 12px `--faint` `Suggested`.
4. **Actions,** 8px under, 26px buttons (`size="sm"`), 8px apart, only on an `Open` finding:
   - `Fix this` (outline, Lucide `wrench` 13px): `review.fixThis` adds the finding to the viewer's draft comments on its line, as milestone 3's draft, text prefilled `{title}\n\n{body}` and editable. The finding then shows `Added to your drafts` (12px `--faint`, `check`) in place of its buttons, and the draft sits under it. Pressing it twice does nothing more (the API's key is the finding and the member).
   - `Remember this` (ghost, Lucide `book-marked` 13px, `--muted`): `review.rememberFinding` makes a memory proposal with the finding as its source (`ai_finding`). Then `Proposed to calculator's memory` 12px `--faint` + teal `See it`, linking to `../m4/memory-proposals` with `?proposal={id}`. Shown on resolved findings too: a fixed blocking finding is often the best thing to remember.
   - Both disabled with a `Tooltip` for a viewer who can't open the project's memory or comment (a project viewer): `Members of calculator can do this.`
- **Resolved** findings draw the header and title in `--muted`, the body in `--faint`, and no `Fix this`. **Outdated** ones go after the file's last hunk under milestone 3's `Outdated comments` label, with `line {n} · {sha7}` and the quoted line, like an outdated comment.

### The review bar

Milestone 3's bar, pinned where the Changes tab pins it, shown only while the viewer has drafts on the task: `--surface`, 1px `--line-2`, radius 8px, 52px, padding `10px 14px`. Left: `message-square` 15px `--muted`, `{n} draft comments` 14px weight 600 `--text` + ` on {m} files` `--muted`; under it the hint 12px `--faint`. Right: the page's one primary button, `Send to agent` (`arrow-up`).

Its states are milestone 3's (`task-changes.md`, "The review bar's hint and button") with these hints, since the reviewer usually isn't the driver:

| Condition | Hint | Button |
|---|---|---|
| the viewer isn't the driver (the picture) | `Sent to {driver}'s agent together as one message. Approve on GitHub; ostra never approves.` | `Send to agent` |
| the viewer drives | `Sent together as one message. Approve on GitHub; ostra never approves.` | the same |
| a turn is running | `Sent together as one message, after the current turn.` | the same |
| merged or closed | `This pull request is {merged/closed}. Sending reopens the task on a new branch.` | the same |

- Sending is a person's action: it resets the round counters (ticket 18) and starts the loop again (CI, review, waiting for a reviewer).
- A reviewer who isn't the driver **can** send: milestone 3's rule ("the driver sends") doesn't apply to review comments, since a reviewer steers through comments the way GitHub's "Request changes" does. The message is theirs, in the thread as `{name} · {n} comments on the diff`. It adds no co-author trailer for them (ADR 0040 amended, independence), and the panel says so (open point 1).
- In flight `Sending…`; sent: `Sent {n} comments as one message.` + teal `See it in Activity` for 6 s.

### Properties panel

`PropGroup`/`PropRow` (84px key column, 30px rows, 14px; keys `--muted`, values `--text`), groups apart by a hairline.

1. **Ticket.** The key, a teal Plex Mono link to the tracker; under it the ticket's title, 14px `--text`, two lines at most. Then 12px `--faint`: `Acceptance criteria, from the accepted draft` (when a refine draft was applied, F-099), `Acceptance criteria, from the ticket` (parsed from a `## Acceptance criteria` section of the description), and nothing more when there are none. Then the criteria as an `ol`: Plex Mono 12px `--faint` numbers in a 20px column, 14px `--text`, wrapping, 6px apart. More than 8: the first 8 and a ghost `Show {n} more`. A prompt task: `Ticket` · `None`, and in place of the list 13px `--faint` `No ticket, so no acceptance criteria. The prompt is in the thread.`
2. **Reviewers.** One 30px row per `TaskReviewer` of the selected PR: a 20px avatar (a member's initials; a team gets Lucide `users` 15px `--faint`), the member's name (`--text`) or the GitHub login / `@org/team` (Plex Mono), ` you` in `--faint` for the viewer; at the right the state, 13px:

| `lastReviewState` | Shows |
|---|---|
| none, requested | `Requested` `--muted` |
| `commented` | `Commented` `--muted` |
| `changes_requested` | `Changes requested` `--text` |
| `approved` | `check` 13px `--green` + `Approved` `--text` |
| a team | `Team · CODEOWNERS` or `Team · requested` `--faint` (teams aren't expanded, spec item 17) |
| a GitHub user matched to no member | the login, and `Not in ostra` `--faint` (`title`: `No member has linked this GitHub account.`) |

   The source (`requested`, `codeowners`) shows in the row's `title`. Under the rows, 12px `--faint`: `Approving and merging happen on GitHub.` No reviewer: 13px `--faint` `Nobody is requested. The driver is asked to review.` (spec section 4, "Reviewers").
3. **This pull request:** `Driver` (avatar and name); `Branch` (Plex Mono, middle-truncated, full name in `title`); `Head` (Plex Mono SHA 7); `CI` (`check` `--green` + `Passed · 3 checks`, `x` `--red` + `Failed · e2e`, `No CI` `--faint`, a spinning `loader-circle` + `Running`); `AI review` (`1 nit open · 1 resolved`, `Nothing found`, `Off for calculator`); `PR` (teal `#512` + ` · open`, a link to GitHub).

## States

| State | What shows |
|---|---|
| **Waiting for your review, findings and drafts** (`review-screen.webp`) | As above |
| Loading | The header's key and title at once; the round line and tabs as `Skeleton` lines; milestone 3's diff skeleton; the panel's values `–` |
| No PR yet (the task never pushed) | No tabs, no diff. 14px `--muted`, centred in the column: `No pull request yet. The review screen fills in once the agent's first push opens one.` + teal `Back to the task` |
| AI review off | No findings anywhere; the round line reads `AI review off`; the panel's `AI review` · `Off for calculator` |
| AI review running | The round line `AI review running`; the findings of the last finished run stay, a 12px `--faint` line above the diff: `A new review is running on {sha7}. These findings are from round {n}.` |
| Viewer isn't a reviewer | The round line's dot `--muted`, `Waiting for a reviewer`; everything else the same, they can still comment and send |
| Viewer approved on GitHub | The dot `--green` + `You approved on GitHub`; the top bar's button reads `Open on GitHub` |
| Merged or closed PR | The tab marked; the diff as of the last head; `Fix this` hidden; `Remember this` stays |
| A finding's action fails | 12px `--red` under its buttons: `errorText(error)` |
| Error loading | `role="alert"`, `--red`, `errorText(error)` where the diff would be, teal `Try again` |
| Narrow (below 1280px) | The panel drops under the main column (Ticket first, so the criteria stay near the diff); the files column folds to a `Files` `Select` above the diff |
| Phone (F-075) | One column: round line, PR `Select`, `Files` `Select`, the diff with findings inline; the panel's groups under it as sections; the review bar full width, pinned |

**Keyboard:** milestone 3's (`j`/`k` between files, `c` to comment on the focused line); `f` on a focused finding presses `Fix this`; `[`/`]` move between PR tabs.

## Components (shadcn/ui names)

- **From the repo:** `PageFrame` (with `properties`), `PageHeading`, `PropGroup`, `PropRow`, `Button`, `Tooltip`, `Skeleton`, `Avatar`.
- **From milestone 3:** `UnderlineTabs`, `components/tasks/task-changes/diff-view.tsx` and its comment blocks and review bar. Ticket 35 extends them with a `findings` slot per line, not a fork.
- **New:** `components/tasks/review/review-screen.tsx`, `file-tree.tsx`, `finding-block.tsx`, `criteria-list.tsx`, `reviewer-rows.tsx`. `Badge` (outline) for the chips.
- **Icons** (Lucide 15px, stroke 1.75): `scan-search`, `octagon-alert`, `check`, `wrench`, `book-marked`, `message-square`, `users`, `chevron-down`, `chevron-right`, `arrow-up-right`, `arrow-up`, `loader-circle`, `x`; the GitHub mark from the shell's icon set.

## Tokens (`apps/web/src/app/globals.css`, the measured values)

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | page, panel |
| `--side` | `#0A0B0C` | sidebar |
| `--surface` | `#131416` | file headers, hunk headers, the review bar, suggestions |
| `--sel` | `#1A1B1E` | the selected file row, the sidebar item |
| `--line` / `--line-2` | `#1F2023` / `#2A2C30` | hairlines / chips, finding and comment rules, the bar's border |
| `--text` | `#F2F3F4` | code, titles, values |
| `--muted` | `#B4B7BB` | finding bodies, resolved findings, states |
| `--faint` | `#8B8E93` | line numbers, rounds, labels, keys |
| `--teal` | `#6FB8AA` | ticket key, PR links, `See it` |
| `--green` / `--add-bg` | `#4FB286` / `rgba(79,178,134,0.10)` | additions, `Resolved`, `Approved`, CI passed |
| `--red` / `--del-bg` | `#E5675C` / `rgba(229,103,92,0.10)` | deletions, `Blocking`, CI failed |
| `--amber` | `#FFB224` | **only** the round line's dot when the viewer is a reviewer still to review, and the sidebar's Needs you count |
| `--shell` / `--ink` | `#F3F0E8` / `#0C1D21` | `Send to agent` |

## Data this screen needs beyond ticket 28

- **Per finding:** `severity`, `state`, `round` (from its `ReviewRun`), `resolvedInRound`, `postedAs`, `line`, `side`, `suggestion`, and the viewer's own state for it (`fixedAsDraftId`, `proposalId`), so the buttons show their done state after a reload.
- **Per PR:** `headSha`, `pushedAt`, the latest `CiRun` (state and check count), the reviewers with `isViewer`, and `merged` / `closed`.
- **The criteria's source** (`draft` or `ticket` or `none`), for the panel's label.
- **The viewer's reviewer state** for the round line's dot: is the viewer a matched reviewer of any open PR of the task who hasn't approved.
- **The GitHub URL** of each PR's "Files changed" (`/pull/{n}/files`), for `Open on GitHub to approve`; with several PRs, the selected tab's.

## Differences from the current code

Checked against `apps/web` and `packages/api` on `main` (2026-11-19):

1. **Everything is new.** No review route, no `review` router, no `Finding` or `TaskReviewer` tables (ticket 05).
2. **Milestone 3's Changes tab** may not be on `main` yet (ticket 46 of milestone 3). The review screen reuses its diff view; if it isn't there, ticket 35 waits for it rather than building a second diff.
3. **Ticket 35's path** is written for a file-based router (`src/routes/tasks/$taskId/review.tsx`). The panel is Next.js's app router: build `app/(panel)/tasks/[task-id]/review/page.tsx`.
4. **Entry points:** the task page's top bar gains an outline `Review` button (Lucide `scan-search`) while any PR is open (`task-rounds`), the Needs you row `Waiting for your review` links here, and so does the reviewer mail.
5. **Messages.** New keys under `review.*` in `messages/en.json`: the round line's parts, the chips, both buttons and their done lines, the panel's labels, the reviewer states, every state above.

## Open points (recommendations; ticket 35 records the answer)

1. **Who may press `Send to agent`.** Recommended: any member who can open the task, as with the Changes tab's comments, without taking over. The message comes from them; it never makes them the driver or a co-author.
2. **`Fix this` as a draft or at once.** Recommended: a draft (ticket 28's wording), so a reviewer gathers several fixes and their own comments into one prompt, which is one automatic-free turn instead of many.
3. **Nits in `Fix this`.** Recommended: allowed on both severities. A reviewer who wants a nit fixed says so by pressing it.

## Wrong in the image (build from this file)

- **`process,env`** in the resolved finding's body has a comma, in the sans face. Build the agent's text as stored: `process.env`, a backtick span in Plex Mono.
- **The files tree draws a file icon** before each file name. Build milestone 3's status glyph column (`M`, `A`, `D`, `R`) instead, so the tree and the Changes tab read the same.
- **The selected PR tab's counts** run together (`#512 4`). Build the PR number and the file count 6px apart, both `--faint` Plex Mono, the count with a `title` (`4 files changed`).
- **The resolved finding's `Blocking` chip** fills its border red. Build an outline chip with `--red` text and the `octagon-alert` icon; the border stays `--line-2`.
- **The findings' header icon** is a plain magnifier. Build Lucide `scan-search`.
- **The round line's `3 of 4`** is in the sans face. Build Plex Mono.
- **No `As of {sha} · pushed {age}`** line above the diff. Build it.
- **The panel's ticket title** is larger than the panel's text. Build 14px `--text`.
- **The sidebar** shows rows from other milestones (Automations with a branch icon, no Insights). Build it from `sidebar.tsx`; Automations takes its own icon (`automations` target).

Right as drawn: the PR tabs, the file tree with the selected row, the diff with one finding open with `Fix this` and `Remember this`, the resolved blocking finding in muted text with its green check chip, the draft comment under it, the review bar with the one primary `Send to agent`, the top bar's outline `Open on GitHub to approve`, and amber only on the sidebar's count and the round line's dot.
