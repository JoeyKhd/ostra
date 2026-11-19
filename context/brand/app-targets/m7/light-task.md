# Target: the task page in the light theme (milestone 7, screen 12)

> **Committed image:** `light-task.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

- **Prompt:** `light-task.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 1 generation, kept. References: the approved 2048 original of `app-targets/m1/task` (the screen this one starts from, spec section 13), `app-concepts/html/home-graphite.png` and the Abyss Hinge logo `kit/logo/export/ostra-hinge-2048.png`.
- **Route:** unchanged, `apps/web/src/app/(panel)/tasks/[task-id]/page.tsx` → `components/tasks/task-view.tsx` and the thread renderers (`apps/web/src/task/renderers.tsx`). Nothing changes but colours, plus an opened diff in the picture to settle the diff's light colours.
- **Features:** F-082 (the theme). Spec section 4 ("The theme"), section 13 row 12. Ticket 18, ticket 17 (contrast in both themes).
- **Status:** a proposed target, waiting on approval (ticket 12's `## Comments`). Ticket 18 builds its tokens and tests until then, not its UI.

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 with `data-theme="light"` and compare it with the picture.

## Purpose

`light-home` sets the light tokens and the rules for surfaces, rows, the sidebar and amber. This target settles **the rest of what a light screen needs**: the thread (messages, plan, tool rows), code and diffs, the approval block, the composer and the properties panel's markers. With the two, every screen of milestones 1 to 7 has its light rendering decided (spec section 13, last line); ticket 18 adds a target only for a screen these two don't settle.

The picture is milestone 1's task page (`../m1/task.webp`) in light: `CALC-161` waiting on Sam Rivera's approval for `pnpm db:migrate`, with the `state.ts` edit's diff opened under its row.

## Tokens

`light-home.md`'s table, unchanged. This page uses `--bg`, `--side`, `--surface`, `--raise`, `--sel`, `--line`, `--line-2`, `--text`, `--text-2`, `--muted`, `--faint`, `--teal`, `--green`, `--red`, `--amber`, `--amber-text`, `--primary`, `--on-primary`, `--track`, `--meter`, `--diff-add`, `--diff-del`.

## Rules this page adds

### The thread

1. **Message rows:** the 28px gutter circle is 1px `--line-2` with a `--faint` icon, on `--bg` (no fill), as dark. Author 13px weight 600 `--text`; time and model mono 12px `--faint`; the status word `working` `--teal`, `the turn failed` `--red`, `stopped` `--faint`.
2. **Markdown text** (`.agent-md`): body `--text`; inline code `--surface` with a 1px `--line` border, `--text`; links `--teal`; blockquotes a 2px `--line-2` rule and `--muted` text.
3. **The plan:** done is a `--green` check with `--muted` text; in progress a `--teal` `circle-dot` with `--text`; pending a `--faint` ring with `--muted` text.
4. **Tool rows:** icons `--faint`, verbs `--muted`, mono paths `--text`, `+n` `--green` and `−n` `--red` mono, `exit 0` `--green` with `check`, `exit 1` / `killed` `--red`. Disclosures (`Show the diff`, `Hide the diff`, `Show the output`) `--teal`.
5. **System lines** `--muted` with `info` `--faint`; problems `--red` with `triangle-alert` `--red`.

### Code and diffs

1. **A code block** (output, logs, setup log): `--surface` (Shell) with a 1px `--line` border, radius 8px, mono 12px/1.6 `--text`. No syntax colours in milestone 7, as in dark.
2. **The diff** (in the thread and on the Changes tab, `../m3/task-changes.md`):
   - Header line: mono 12px, path `--muted`, the hunk `@@ … @@` `--faint`.
   - Line numbers: `--faint` (on the line fills `--faint` is 4.8:1 and 4.7:1).
   - Added: fill `--diff-add` `#E6F2EA`, the `+` and the numbers `--green`, the code `--text`.
   - Removed: fill `--diff-del` `#FBE9E6`, the `−` and the numbers `--red`, the code `--text`.
   - Context: no fill, `--text`.
   - Colour is never the only cue: the `+` / `−` column stays (`app-design.md`, rule 4).
   - In dark the fills stay `rgba(79,178,134,0.10)` and `rgba(229,103,92,0.10)` (`../m3/task-changes.md`); they're tokens now so the values swap.
3. **Line comments and the comment button** (`../m3/task-changes.md`): the comment's box `--raise` (white) with a 1px `--line-2` border; the hover button `--teal` on `--surface`.

### The approval block (and every needs-you block: questions, plans, round caps, take it local)

1. No card, no fill: a **3px** `--amber` rule on the left in light (2px in dark: at 2px the 1.7:1 rule disappears on paper; the extra pixel keeps it a line, and the title says the same in words).
2. Title: `hand` 14px and `Needs you · approval` 13px weight 600, both `--amber-text` (`#8A5300`, 6.1:1).
3. Body `--text`; the command chip `--surface` with a 1px `--line` border, mono `--text`.
4. Buttons: `Deny` and `Approve for this task` outline (`--surface`, 1px `--line-2`, `--text`); `Approve once` `--amber` fill with `--ink` text weight 600 (9.6:1).
5. Footnote 12px `--faint`.
6. Answered: the muted line, `--muted`, no rule, as dark.
7. The same rule applies to `../m3/task-approval.md`'s question, `../m3/task-plan.md`'s plan approval, `../m6/task-rounds.md`'s cap and every other block with an amber rule.

### The header and the panel

1. The status dot follows `light-home`'s rule 2 (amber with a 1px `--amber-text` inner ring at 55%); its words stay `--text` weight 500, never amber, as dark.
2. Properties: keys `--muted`, values `--text`, mono where dark is mono. The driver's avatar: `--sel` fill, initials `--text` 10px weight 600. `Take over` `--teal`.
3. Chips (`Pool`, `docker`): `--surface`, 1px `--line-2`, `--text` 12px.
4. The context meter: 4px `--track` with a `--meter` fill.
5. Changes: file names mono `--text`, `+n` `--green`, `−n` `--red`.

### The composer

`--surface` with a 1px `--line-2` border, radius 8px; placeholder `--faint`; the hint `--faint` with `info`; `Interrupt and send` outline; `Send` the page's one primary, `--primary` (Abyss) with `--on-primary` text. Disabled buttons: their colours at 45% opacity, as dark.

## Layout (CSS px at 1440×960)

Unchanged from `../m1/task.md`, `../m2/task-ticket.md` and `../m3/task-changes.md`. The picture's diff block is 706px wide (the content column) and opens directly under its tool row, aligned with the path column's left edge minus the gutter; build it at the content column's width, starting at the path column (as `Show the output` does in `../m1/task.md`).

## States

| State | What shows in light |
|---|---|
| **Waiting on an approval, a diff open** (`light-task.webp`) | As above |
| Running, nothing waiting | The status dot `--teal`; no amber on the page but the sidebar's pill if another task waits |
| A question (`../m3/task-approval`) | The question block follows the approval rules; its answer field `--surface` with a 1px `--line-2` border and a `--teal` focus ring |
| Failed turn | `the turn failed` `--red`; the system line `--red` with `triangle-alert` |
| The Checks tab | Pass `--green` `check`, fail `--red` `x`, running `--faint` `loader-circle`; the log viewer a code block |
| Ended, PR open | `git-pull-request` `--green` for open, `--faint` for draft, merged `git-merge` `--green` |
| Hover on a row | `--raise` would be invisible on `--bg`, so hover is `--sel` at 60% |
| Narrow / phone | As dark (`../m2/phone-task.md`) with these tokens |

## Components (shadcn/ui names)

No new component. `PageFrame`, `PropGroup`, `PropRow`, `Button` (`primary`, `amber`, `outline`, `ghost`), `Tooltip`, `Avatar`, the thread renderers and the approval block (`task/renderers.tsx`), the diff view from milestone 3. What changes is which tokens they read (`light-home.md`, "Differences from the current code", item 3) and the approval rule's width per theme (a `--rule-needs-you` length: `2px` dark, `3px` light).

## Data this screen needs

None beyond the task page's.

## Differences from the current code

1. **The diff fills** are `rgba` literals in milestone 3's spec; they become `--diff-add` and `--diff-del`.
2. **The approval rule** is a fixed `2px`; it becomes `--rule-needs-you`.
3. **The approval title** reads `--amber` as text; it becomes `--amber-text`, which equals `--amber` in dark, so dark doesn't change.
4. **Row hover** uses `--raise` in places; on light it must be `--sel` at 60%. One `--hover` token (dark `--raise`, light `rgb(232 228 217 / 0.6)`).

## WCAG AA check (F-081)

`--text` on `--bg` 16.6:1, `--muted` 9.2:1, `--faint` 5.7:1 (4.7:1 on `--sel`, 4.8:1 and 4.7:1 on the diff fills), `--teal` 6.1:1, `--green` 5.5:1 (5.0:1 on `--diff-add`), `--red` 5.7:1 (5.1:1 on `--diff-del`), `--amber-text` 6.1:1, `--ink` on `--amber` 9.6:1, `--on-primary` on `--primary` 15.2:1. All pass 4.5:1. The 3px amber rule and the dots are 1.7:1 but never the only cue: each has its words.

## Open points (recommendations; ticket 18 records the answer)

1. **A 3px rule in light.** Recommended, as drawn. The alternative (2px plus a faint amber wash behind the block) brings back a box, which `app-design.md` rule 3 rules out.
2. **Syntax colours in code and diffs.** Not in milestone 7, in either theme.

## Wrong in the image (build from this file)

- **`Approve once`** has dark-brown text. Build `--ink` `#0C1D21`, weight 600.
- **The diff's `+` signs** are dark; only the `−` is coloured. Build both the sign and the numbers in `--green` / `--red`.
- **The diff's line numbers** show one column. Build `../m3/task-changes.md`'s two columns (old and new), 40px each.
- **The diff block** starts at the verb column, about 30px left of the paths. Build it starting at the path column.
- **The status dots** (header and panel) have a heavy amber-on-amber outline. Build `light-home`'s 1px inner ring at 55%.
- **The sidebar's project dots** have a dark ring that reads as a second colour. Same rule: a 1px inner ring at 55%.
- **The sidebar's org mark** isn't the Hinge. Build the Abyss Hinge SVG.

Right as drawn: the paper page with the Shell sidebar and Shell code block, the pale green and red line fills with dark code on them, `Hide the diff` in teal, the plan's green check and teal circle, the amber rule with the darker amber title and hand, the amber `Approve once` as the page's one amber button, the Abyss `Send` as the one primary, outline buttons on Shell, the Kelp context meter, and the green and red counts in the Changes group.
