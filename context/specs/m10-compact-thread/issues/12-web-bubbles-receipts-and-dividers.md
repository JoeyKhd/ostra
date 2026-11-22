# 12: Web: bubbles, receipts and dividers

Status: ready-for-agent
Builder: web
Blocked by: 09
Features: F-151
Packages: `apps/web` (`src/task/thread/bubble.tsx`, `receipt.tsx`, `divider.tsx`; `src/task/agent-message-view.tsx`, `src/task/diff-comments-message.tsx`, the PR comment row out of `src/task/renderers.tsx`, `src/task/effort-marks.tsx`'s marker, `src/task/marker-words.ts`; milestone 9's "What the agent got" in `src/components/tasks/attachments/` for its frame only), new `apps/web/e2e/27-thread-messages.spec.ts`
Spec: `../spec.md`, section 13
Targets: `context/brand/app-targets/m10-thread/parts.md` parts 2 and 12, `states-messages.md` (cells 1 to 5), `s3.md` (ostra's first bubble), `s5.md` ("What the agent got" and the plan's receipt), `s2.md` (the receipt `Sam Rivera answered Replace the display`)

## What to build

Built to the approved targets, at their sizes, in both themes.

- **A member's message** (part 2): the right-aligned bubble (`--sel`, 82%, radius 16px), the line over it with the name, the time mono and any tag (`queued`, `after an interrupt`, `sending…`, `reopened the task`, `replayed`, `asked for changes`, `{n} comments on the diff`, `asked to fix {n} checks`, `from a comment on {key}`, `held` in red); names over every bubble (choice 11); milestone 9's files above it, right-aligned, thumbnails 84px and chips 48px.
- **Outlined** (choice 6): what ostra sent by itself and what came from GitHub or Linear, the same bubble with no fill and a `--line-2` edge, named and tagged as part 2's table says, for every `AgentMessage` kind (`ai-review`, `fix-ci` with a row per failing job, `fix-findings`, a held round inside its bubble, `closing-turn`, `refine`, `pr-comment` with `Open on GitHub` and `Remember this`, `changes-requested`); a `linear-follow-up` stays filled under the member's name. Quoted items (a diff comment, a PR comment, a check) with their 2px left line; never a box inside the bubble.
- **"What the agent got"** as the first bubble of a ticket task (`.bubble.got`), its states (skipped, failed with Retry) as milestone 9 built them.
- **Answers become receipts** (content fix 10): a message whose `AgentMessage` is `question-answer`, `plan-approved` or `approval-answer` (a late answer, sent as a reopen) isn't drawn as a bubble; its receipt stands in its place. `receipt.tsx` (part 12) draws every receipt for ticket 13's blocks too: `check` icon, the words with the chosen value in `--text-2` (a free-text answer quoted), the time, and `Show the plan ›` where there's more, opening the approved plan with milestone 1's progress marks and `edited` marks.
- **Dividers** (part 12): the day; how a session came back (`Restored from the session archive on {runner}`, `Resumed in the same box`, `Rebuilt from the template · {reason}`); the plan and build turns' markers; a new driver; a level change; a stop. Never a runner connecting, a box idling out, a release or a save.

## Done when

- [ ] Tests named for `F-151/c1`: a member's message is a filled bubble with its name; an `ai-review`, a `fix-ci` and a `pr-comment` message are outlined and named `ostra` or `{login} on GitHub` with their tags; a `linear-follow-up` is filled; every tag of part 2 renders; no divider for `runner.connected` or `session.saved`.
- [ ] Tests named for `F-151/c5`: a late `question-answer`, `plan-approved` and `approval-answer` message renders as its receipt, never a bubble; a free-text answer's receipt quotes the words; `Show the plan ›` opens the approved plan with its marks.
- [ ] `apps/web/e2e/27-thread-messages.spec.ts` (run once at the milestone's end) over the seeded S3, S5 and the messages sheet's cells.
- [ ] Screenshots at 1440 px, both themes, compared with `states-messages`, `s3` and `s5-approved`, under `## Comments`.
- [ ] Checks for `apps/web` pass; the keyboard walk and contrast check stay green.
- [ ] Committed as `✨ draw messages as bubbles and answers as receipts`.

## Comments
