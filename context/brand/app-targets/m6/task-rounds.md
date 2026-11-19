# Target: the task page in review, with its rounds (milestone 6, screen 10)

> **Committed image:** `task-rounds.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

- **Prompt:** `task-rounds.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 1 generation, kept. References: the approved 2048 original of `app-targets/m1/task` (the screen this one starts from, spec section 12), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`.
- **Route:** unchanged, `apps/web/src/app/(panel)/tasks/[task-id]/page.tsx` → `components/tasks/task-view.tsx`, the Activity tab (`../m3/task-changes.md`, "Route"). This target adds the stage line to the header, the round cards and the cap's needs-you to the thread, and a Rounds group to the panel.
- **Features:** F-035 (fix failing CI), F-101 (the AI review's rounds and the four-turn cap), F-105 ("changes requested" reopens the task), with milestone 4's budget gate (F-037) holding a round. Spec section 4 ("CI", "A round", "Changes requested"), section 11 items 13, 15 and 16; ADR 0041 (the loops and their caps), ADR 0058, ADR 0055 (the budget gate). Ticket 18 (rounds and caps), ticket 28 (`tasks.rounds`), ticket 35 (this screen).
- **Status:** a proposed target, waiting on approval (ticket 30's `## Comments`). Ticket 35 builds its data and tests until then, not its UI.

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

Once a task's PR opens, ostra works the review loop by itself: it waits for CI, sends a failure back to the agent with its logs, runs an AI review, sends the blocking findings back, and only then asks a person. Each time ostra sends something back by itself is a **round**, and each round's turn is an **automatic turn**. The caps (2 CI rounds, 2 review rounds, 4 automatic turns, counted since a person last acted, ADR 0041) keep the loop from burning money, and the budget gate can hold a round (milestone 4).

The page has to make the loop legible at a glance: **where the task is in it** (the stage line), **how much of its allowance it has used** ("automatic turns 3 of 4"), **what each round sent the agent and why** (a card per round in the thread), and, when a cap is reached, **one clear question for the driver** with `Keep working`.

The picture shows `CALC-182` after its second CI round: CI failed again, the CI cap is reached, and the task needs Alex Kim, its driver. Its thread holds CI round 1 (fixed), findings round 1 (fixed), and CI round 2, which the budget held for 9 minutes before it ran.

## Layout (CSS px at 1440×960)

The panel's measured scale (`../m1/README.md`, "Scale"): body 14.5px, dense rows 14px, secondary 13px, small labels 12px, title 26px, buttons 30px, top bar 46px, properties 320px.

| Region | Size | Contents |
|---|---|---|
| Sidebar | 234px, the shared shell | Built from `sidebar.tsx`. The project's **Tasks** row selected |
| Top bar | 46px | Milestone 1's: crumbs `calculator › Tasks › CALC-182`; right: copy-link (ghost), `PR #512` (outline, `git-pull-request`), and new: `Review` (outline, Lucide `scan-search`), which opens `review-screen`, shown while any of the task's PRs is open. `Stop` shows only while a turn runs |
| Main column | `1fr`, padding `28px 36px 20px` | Header with the stage line, tabs, the thread, the composer |
| Properties panel | 320px | Properties, Rounds (new), Code |

### Header

1. Key line, title and status line, as `../m2/task-ticket.md`. The status line's state words follow the sub-state (table below); the amber dot only when the task needs the viewer.
2. **The stage line** (new), 10px under the status line, 32px, only while the task is `in_review` with a PR open. Five stages joined by 16px × 1px `--line-2` connectors, 13px, each a 14px glyph and a word:

| Stage | Sub-state | Words |
|---|---|---|
| 1 | `ci_running` | `CI running` |
| 2 | `fixing_ci` | `Fixing CI {n} of {limit}` |
| 3 | `ai_review` | `AI review` (`AI review round {n}` once there was more than one) |
| 4 | `fixing_findings` | `Fixing findings {n} of {limit}` |
| 5 | `waiting_for_reviewer` | `Waiting for a reviewer` |

   - **Done** (passed through in the current pass): Lucide `check` `--green`, words `--muted`.
   - **Current:** a 10px filled circle in `--text`, words `--text` weight 500. When the task needs a person at this stage (a cap, a held round), the circle is `--amber` (it's the needs-you, the same one as the status dot) or, for a hold, Lucide `pause-circle` `--muted`.
   - **Ahead:** a 10px `--faint` ring, words `--faint`.
   - **Skipped:** when the project's AI review is off, `AI review` and `Fixing findings` aren't drawn, and the line reads `CI running`, `Fixing CI`, `Waiting for a reviewer`. When CI passed at once, `Fixing CI` stays an ahead ring (`Fixing CI`, no count) and the next current stage is `AI review`: a stage is done only when it happened in this pass.
   - The loop goes round, so a "pass" restarts at `CI running` with each push; earlier passes live in the thread, not here.
   - **At the right** of the same row, 12px `--faint` `automatic turns` + Plex Mono 13px `--text` `{used} of {limit}` (`OSTRA_AUTOMATIC_TURNS`), with a `Tooltip`: `Turns ostra started by itself since a person last acted. At {limit}, the driver decides.` Hidden while it's `0 of 4`.
   - AI review off and no CI on the repo: the line reads only `Waiting for a reviewer`.
3. **Tabs** (milestone 3): `Activity` (selected), `Changes` + count, `Checks` + the latest result (here `x` `--red`: the code host's CI failed, `../m3/task-checks.md` growing).

### A round in the thread

A round is one entry in the thread, in time order with the messages around it. It's the one bordered block the thread has, because it groups what ostra sent the agent by itself, apart from what people said: 1px `--line`, radius 8px, **no fill**, padding `10px 14px`, in the content column. Its gutter icon is a 28px outlined circle with Lucide `refresh-ccw` 14px `--muted` (a person's message has their avatar; the agent its own icon). No box goes inside it: its rows are plain rows.

1. **Header,** 22px: the round's name 14px weight 600 `--text`, then Plex Mono 12px `--faint` `{time} · automatic turn {k} of {limit}` (the `changes-requested` round has no `automatic` part).

| Kind | Name |
|---|---|
| `ci` | `CI round {n} of {limit}` |
| `findings` | `Findings round {n} of {limit}` |
| `changes_requested` | `Changes requested by {member} on GitHub` |

2. **Body,** by kind:
   - **CI:** one 26px row per failing check (5 at most, `OSTRA_CI_LOG_CHECKS`): Lucide `x` 13px `--red`, the check's name Plex Mono 13px `--text`, its conclusion 13px `--faint` (`failed`, `timed out`, `cancelled`), then the log file as a teal Plex Mono link (`ci/test.log`) that opens the tail ostra gave the agent in a milestone 3 code block under the row (64 KiB, `OSTRA_CI_LOG_TAIL_KIB`). A check without a log (a commit status): `no log` `--faint`. More than 5 failing: `and {n} more, not sent` 12px `--faint`.
   - **Findings:** 13px `--muted`: `Sent {b} blocking finding(s): {title}{, title…}. {n} nit(s) listed, not required.`, the titles in `--text`, each a link to the finding on `review-screen`. More than 3 titles: the first 3 and `and {n} more`.
   - **Changes requested:** 13px `--muted`: `Sent Sam Rivera's review: its comment and {n} line comments.` + teal `Open the review on GitHub`. The body text itself is in the member message the reopen wrote (ticket 20), right under the card, as a normal message from Sam.
3. **A hold** (a round the budget gate held, ticket 18 and milestone 4): inside the card, a 12px `--faint` line with Lucide `pause-circle` 13px: while held, `Held: {scope}'s budget for {month} is reached. It starts when the budget allows.` + teal `Open spend` (members who can see spend); once released, `Held {duration}: {scope}'s budget for {month} was reached. Released when {member} raised it.` (or `…when {month} began.`). A round held by the spend cap: `Held: the task reached its spend cap of {amount}.` + the driver's teal `Raise the cap`.
4. **After the card,** one 13px `--muted` line in the thread (no gutter icon, the system-line style of `../m1/task.md`) for the round's outcome: `OpenCode pushed {sha7}. CI passed.`, `OpenCode pushed {sha7}. CI failed again: {check}.`, `OpenCode pushed {sha7}.` (while CI runs), `The turn ended without a push.` The agent's own turn (its text, tools and plan) shows as in any turn, folded under `Show the turn` (teal, 12px) so the loop reads as a list of rounds.

### The cap's needs-you

When `roundAllowed` answers `capped`, the task goes to needs you (`round_cap`) for its driver (ticket 18), and the thread ends with milestone 1's approval block: no card, a 2px `--amber` left rule, 12px left padding.

- Title, 13px weight 600 `--amber` with Lucide `hand` 14px: `Needs you · CI round limit` / `Needs you · review round limit` / `Needs you · automatic turn limit`.
- Body, 14px `--text`, by cap:
  - CI: `CI failed after {limit} rounds, so ostra stopped sending it back to {agent}. {check} still fails{ on {file}}.`
  - Review: `The AI review still found {b} blocking after {limit} rounds, so ostra stopped sending them back to {agent}.`
  - Turns: `ostra started {limit} turns by itself since anyone acted on this task, so it stopped.`
- Buttons, 30px, 8px apart: `Keep working` (amber fill, `--ink` text, weight 600): a person's action, so the counters reset and the round the cap stopped starts (ticket 18); then an outline button to the evidence: `Open the checks` (CI, the Checks tab), `Open the review` (review, `review-screen`), none for turns.
- Footnote, 12px `--faint`: `Keep working starts one more {CI round / findings round} and resets the count. You can also message {agent} below.`
- **Who answers:** the driver. Other members see the block in `--muted` without buttons, with `{driver} decides. Take over to decide.` + teal `Take over`.
- **Answered:** the block becomes one muted line: `Alex Kim pressed Keep working · 11:07`. A message from the driver also answers it (it's an action too): `Alex Kim answered with a message.`

### Properties panel

Milestone 1's groups, plus:

- **Rounds** (new, between Properties and Code), label `Rounds` 12px `--faint`, and at the label row's right 12px `--faint` `since {name} last acted`, naming the person whose action set `lastPersonActionAt` (`you` when it was the viewer, as in the picture), or `since the task started` when nobody has acted yet:
  - `CI` · Plex Mono `{n} of {limit}`
  - `Findings` · Plex Mono `{n} of {limit}` (hidden when AI review is off)
  - `Automatic turns` · Plex Mono `{n} of {limit}`
  - `Held` · `Once, 9 min` / `Now, since 10:43` (`--text`) / hidden when never held
  - A value at its limit is `--text` weight 500; nothing turns red or amber here: the status carries the need.
- **Properties › Status** follows the sub-state: `In review · CI running`, `In review · fixing CI`, `Needs you · CI round limit`, `In review · waiting for a reviewer`.
- **Code** adds `Head` (Plex Mono SHA 7) and `CI` (`check` `--green` `Passed`, `x` `--red` `Failed · {check}`, `loader-circle` `Running`, `No CI`) per repo with a PR.

## States

| State | What shows |
|---|---|
| **Capped at CI rounds, after a held round** (`task-rounds.webp`) | As above |
| CI running | Stage 1 current (`--text` dot), the status `In review · CI running`; the thread's last line `Waiting for CI on {sha7}…` 13px `--muted` with a spinning `loader-circle`. After `OSTRA_CI_WAIT_MINUTES` without a verdict: `CI timed out after 60 min.` and the task moves on as if no CI |
| No CI | `CI running` turns done with the word `No CI` in `--muted` after 2 min (`OSTRA_CI_NONE_SECONDS`); the thread says `No CI reported on {sha7} within 2 minutes.` |
| Fixing CI / fixing findings | The stage current; the round's card ends the thread, and under it the agent's running turn as any turn; `Stop` in the top bar |
| **A round held now** | The stage current with `pause-circle`; the card's hold line in its "while held" form; the status `In review · held by the budget`; no amber (the budget's owners get milestone 4's needs-you, not the driver) |
| AI review | Stage 3 current; the thread's last line `The AI review is reading {n} pull request(s) on {sha7}.` + teal `Open the review task` (the review task's page, `kind: review`, linking back) |
| Waiting for a reviewer | Stage 5 current; the thread's last line `Waiting for {reviewers}.` (names, or `the driver` when nobody matched) + teal `Open the review screen`. Amber only for a viewer who is one of those reviewers |
| Changes requested | A `changes_requested` card, then Sam's message, then the agent's turn; stage 2 or 4 doesn't apply, the stage line shows `CI running` again after the push. It resets the counters (a person's action) |
| Capped at review rounds / automatic turns | The needs-you block's other copy; the stage line's current stage `Fixing findings 2 of 2` (amber) or the stage that would have run next (amber) |
| A question in an automatic turn | The agent's question shows in the turn, then a muted line `ostra answered for you: {the fixed reply}` (spec section 4, ADR 0041); never a needs-you |
| An old runner (one minor behind) | No rounds: the stage line stops at `CI running` / `Waiting for a reviewer`, and a 12px `--faint` line under it: `build-fleet-07 is too old for automatic rounds. CI and reviews still show here.` |
| Narrow / phone | The stage line wraps into two rows; at phone width it becomes one line with the current stage and `{k} of 5`, and a `ChevronDown` that opens the five as a list. Cards full width; the needs-you buttons stack |

## Components (shadcn/ui names)

- **From the repo:** `PageFrame`, `PropGroup`, `PropRow`, `Button`, `Tooltip`, `Avatar`, milestone 1's thread renderers (`task/renderers.tsx`) and approval block.
- **New:** `components/tasks/stage-line.tsx`, `task/round-card.tsx` (one renderer per round kind, with an exhaustive `switch` on the kind, `satisfies never`), `task/round-cap.tsx` (the needs-you block's copy), `task/ci-log-block.tsx`.
- **Icons** (Lucide 15px, stroke 1.75): `refresh-ccw`, `check`, `x`, `pause-circle`, `hand`, `scan-search`, `loader-circle`, `git-pull-request`, `arrow-up`, `info`.

## Tokens

The measured tokens (`apps/web/src/app/globals.css`), as `review-screen.md`. Amber only on: the sidebar's count and project dot, the status dot, the current stage's circle when the task needs the viewer, the needs-you block and `Keep working`, the panel's status dot. Red only on a failing check's `x`. A held round is never amber or red: it waits on money, not on the driver.

## Data this screen needs beyond ticket 28

- **`tasks.rounds`** per round: `kind`, `number`, `limit`, `automatic`, `automaticIndex` (k of limit at the time), `createdAt`, `state`, the failing checks with their log names and whether a log exists, the findings' ids and titles, the review's author, URL and line-comment count, and the hold: `heldAt`, `releasedAt`, `reason` (`budget`, `spend_cap`), the scope and month, `releasedBy`.
- **The outcome line** per round: the push's SHA after the round's turn and the next `CiRun`'s state.
- **`tasks.get`** gains `subState`, the counters with their limits and `lastPersonActionAt`, `capReason`, and per repo the latest `CiRun`.
- **The fixed reply's text** for a question in an automatic turn comes from `@ostra/protocol`; the thread renders it from the event, never re-typed.

## Differences from the current code

1. **No stage line, no rounds.** `task-view.tsx` draws milestone 1's header; the thread has no round renderer; `TaskSubState`'s review values exist in the schema and nothing sets them.
2. **The `Review` button** in the top bar is new (it opens `review-screen`).
3. **The Rounds group** is new in the panel; `Code` gains `Head` and `CI`.
4. **Thread events** `round.started`, `round.capped`, `ci.updated`, `review.submitted` (spec section 5.1) need renderers; the `switch` over event kinds in `renderers.tsx` gains them and stays exhaustive.
5. **Messages.** New keys under `task.rounds.*`, `task.stages.*` and `task.roundCap.*`.

## Open points (recommendations; ticket 35 records the answer)

1. **Where the stage line lives on a task with several PRs.** Recommended: one line for the task, following the combined verdict (spec: "the task's sub-state follows the combined result over its open PRs' heads"); the per-PR detail is on `review-screen` and the Checks tab.
2. **Folding the agent's turn under a round.** Recommended: folded by default (`Show the turn`), unfolded while it runs.
3. **`Keep working` for a non-driver.** Recommended: no; the driver decides, others take over first, as with approvals in milestone 3.

## Wrong in the image (build from this file)

- **`Idle on`** in the status line is drawn in Plex Mono. Build sans `--muted`; only `build-fleet-07` is mono.
- **The top bar's `Review` button** has a square icon. Build Lucide `scan-search`.
- **`billing-platform` and `web-storefront`** have orange squares close to amber. Project squares are the projects' own colours (violet-grey, ochre), and amber stays for needs you. The sidebar is built from `sidebar.tsx` anyway.
- **The panel's Rounds and Code values** sit right-aligned. Build them in the panel's value column (84px key column), left-aligned like the Properties group.
- **The `since you last acted` note** sits on the label row's right; that's right, keep it 12px `--faint`.
- **No `Show the turn` links** under the outcome lines. Build them (the agent's turn folded under each round).
- **The `changes_requested` card isn't in the picture** (this state has none). Build it from "A round in the thread".
- **The round cards' gutter icon** has no outlined circle. Build milestone 1's 28px outlined circle around `refresh-ccw`.

Right as drawn: the stage line with a green check, the amber current stage and three faint rings, `automatic turns 3 of 4` at its right, three round cards without fill, the failing checks with red `x` and teal log files, the hold line inside CI round 2, the muted outcome lines between cards, the amber needs-you block with `Keep working` and `Open the checks`, and the composer.
