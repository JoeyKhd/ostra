# Target: approvals and questions on the task page

> **Committed images:** `task-approval.webp` and `task-approval-question.webp`, each downscaled from a 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

The targets for answering on `apps/web/src/app/(panel)/tasks/[task-id]/page.tsx`: the approval card that replaces milestone 1's read-only note, its receipts, several open at once, and the question's form. The page is `../m1/task.md` (a prompt task) or `../m2/task-ticket.md` (a ticket task), with milestone 3's growth (the tabs, the usage rows, the watcher's bar); this file only adds what answering needs. Where a picture and this file disagree, this file wins.

| Picture | State shown |
|---|---|
| `task-approval.webp` | `CALC-188`, a prompt task on the `Careful` profile. OpenCode asked twice at once: an edit a profile rule watches (`Writing a migration`) and a command (`Commands outside an allowlist`). Above them, two earlier receipts: a "for this task" answer and a request the task rule then answered. The viewer, Alex Kim, isn't the driver (Sam Rivera is), and answers anyway: approvals are any member's. He pressed Deny on the second card and is typing a reason. |
| `task-approval-question.webp` | Twelve minutes later. Sam approved the edit once; Alex denied the command with his reason, which ended the turn and cancelled a third request; OpenCode carried on and now asks a question. Questions are the driver's, so Alex sees the form read-only and "Take over to answer". |

- **Generated** with Higgsfield `gpt_image_2_6` (3:2, 2k, high). `task-approval`: 2 generations. The first used the approved `../m1/task` original, `app-concepts/html/home-graphite.png` and the Hinge logo (`kit/logo/export/ostra-hinge-single-color-2048.png`); the second, the one kept, was an edit of the first (attached first, with the `m1/task` original and the logo) that fixed a typo in the path chip. `task-approval-question`: 1 generation, referencing the first `task-approval` generation, the `m1/task` original and the logo. Prompts: `task-approval.prompt.txt` (the edit, then the full first prompt), `task-approval-question.prompt.txt`.
- **Features:** F-026 approvals (the card, the three answers, the receipts, the deny's re-prompt), F-024 (the watcher's bar, "Take over to answer"), F-021 (the profile row and its rules), F-084 (the usage rows). Ticket 43 builds it; ticket 35 serves `approvals.answer`, `approvals.preview`, `questions.answer` and the capabilities; ADR 0049 and ADR 0036 hold the rules.

## Purpose

When the agent wants to do something the profile's rules hold back, any member of the project can see exactly what it wants, which rule asked, and what each answer will allow, and answer it in one press, without leaving the task. A member who answers "for this task" reads the pattern before pressing. A member who denies can tell the agent why. When the agent asks a question, the driver answers it with a form; everyone else sees it and how to take over.

## Layout

Unchanged from `../m1/task.md`: sidebar 232px, top bar 44px, thread column `padding: 28px 40px 20px`, properties 300px. Milestone 3's growth that shows in these pictures (ticket 43's list against `m1/task`):

1. **Tabs** under the status line: `Activity`, `Changes` + `--faint` count of changed files, `Checks`. 36px row, 13px weight 500, `--muted`; the selected tab `--text` with a 2px `--shell` underline sitting on the header's hairline. The tabs are the same component on every task target (`task-changes`, `task-checks`).
2. **The watcher's bar** in the composer's place (below).
3. **Properties:** `Profile`, the usage rows (`Tokens`, `Cache`, `Spend`, `Agent time`) and a new `Approval rules` group (below).

### The approval card (pending)

No card: milestone 1's block. A 2px `--amber` left rule, 12px left padding, indented to the content column (the tool rows' left edge), 10px above and below. It follows the tool row that asked, which shows the amber `needs approval` word (milestone 1). Inside, top to bottom:

1. **Title:** `hand` 14px + `Needs you · approval`, `--amber` 13px 600.
2. **What asks:** 13px `--text`: the rule's name in 600, then the sentence for the tool (below). 4px under the title.
3. **Subject chip:** the subject's value, mono 12.5px, `--surface`, 1px `--line`, radius 6px, padding 6px 10px, `break-all`. 8px above.
4. **Buttons,** 28px, 8px apart, 10px above: `Deny` (outline), `Approve once` (amber: `--amber` fill, `--ink` text, 600), `Approve for this task` (outline).
5. **Pattern line,** 12px `--muted`, 8px above: what "for this task" adds, from `approvals.preview` (below).
6. **Footnote,** 12px `--faint`: milestone 1's `Any member of {project} can answer. The first answer wins.`

Several open at once: each tool row has its own card under it, in the thread's order. The header's status counts them.

### The deny state

`Deny` doesn't answer at once: it opens the reason in the card, replacing rows 4 to 6.

- Label, 12px `--faint`: `Reason for {agent} (optional)`.
- `Textarea`, 2 rows growing to 6, full width of the block, `--surface`, 1px `--line-2`, radius 8px, 13px; focused on open. At most 2,000 characters (spec 5.1); the counter shows from 1,800 (`{n} of 2,000`, 12px `--faint`, right-aligned).
- Buttons: `Deny and send the reason` (outline) or `Deny` when the field is empty, and `Cancel` (ghost, `--muted`), which closes the field and keeps the text until the card closes. `Escape` cancels; `⌘↵` / `Ctrl+↵` denies.
- Warning, 12px `--faint`: `Denying ends {agent}'s turn.` and, when the session has other open approvals, ` The other open approval closes as cancelled.` / ` The {n} other open approvals close as cancelled.`

### Receipts (answered and closed)

One line under the tool row, 12px `--muted`, aligned with the path column (`ml-[104px]` today), no rule, no amber. The tool row's own status word follows the outcome: `✓ exit 0` / `+n` when it ran, red `denied`, `--faint` `cancelled` or `expired`.

### The question (pending)

The same block: 2px `--amber` rule, `message-circle-question` 14px + `Needs you · question` in amber 600.

- **The question:** the agent's message, 13px `--text` weight 500 (not a heading font), rendered as `.agent-md` with no raw HTML.
- **The form,** from the elicitation's schema (ACP `elicitation.form`), one field per property, in order, 8px apart:
  - an enum: a `RadioGroup`, 26px rows, 13px labels; the schema's default selected;
  - a boolean: a `Checkbox` with its label;
  - a string: label 12px `--faint` (with ` (optional)` when not required) and an `Input` 32px, or a `Textarea` for a multi-line format;
  - a number: an `Input` with `inputMode="decimal"` and the schema's bounds.
- **The driver** sees `Send answer` (amber, `--ink` text, 600), disabled until the required fields hold a value; in flight `Sending…`.
- **A watcher** sees the fields disabled (50% opacity, `aria-disabled`), and in the button's place `Take over to answer` (outline) + 12px `--faint` `{driver} answers questions while driving.` With no driver: `Nobody is driving. Take over to answer.`
- Footnote for the driver, 12px `--faint`: `{agent} waits for your answer. Only the driver answers questions.`

### The watcher's bar

When `capabilities.send` is false, the composer's box holds one row instead of a textarea: 48px, `--surface`, 1px `--line-2`, radius 8px, padding 0 14px. Left: the driver's 18px avatar, then `{driver} is driving.` 13px `--text` weight 500, then 12px `--faint` ` Any member can answer approvals. Take over to send messages.` Right: `Take over` (outline, 28px). With no driver: `Nobody is driving.` and the same hint. This replaces milestone 1's one faint line (`task.composer.notDriver`).

### Properties: what this screen adds

| Row | Value |
|---|---|
| Status | amber dot + `Needs you · approval`, `Needs you · {n} approvals`, `Needs you · question` |
| Profile **new** | the profile the task started with, plain text; `--faint` `None` for a task from before milestone 3 |
| Tokens, Cache, Spend, Agent time | F-084's rows (ticket 43's list against `m1/task`): mono `182k in · 31k out`, `1.4M read · 52k write`, `$1.82` + `--muted` ` of $25.00`, `9 min`; `≈` before an estimate |

**`Approval rules` group (new),** after Properties, a hairline above. Rows 26px: the rule's name left (12.5px `--text`; a task rule's pattern in mono), the source right-aligned 12px `--faint`: `profile` for the profile's rules, `this task · {name}` for a task rule with the member who added it. Profile rules first, in the profile's order, then task rules, oldest first. With no rules at all, the group isn't shown. Hovering a profile rule shows a `Tooltip` with what it matches (`Edits of **/migrations/**, **/*.sql`).

## Every state, with its copy

Copy goes in `apps/web/messages/en.json` under `task.approval.*` and `task.question.*`. **New** and **changed** strings are marked; unmarked ones are milestone 1's.

### What asks (**new**)

`{rule}` is the rule's name in 600. `{agent}` is the agent's name.

| Tool | With a rule | No rule (the agent's own settings asked) |
|---|---|---|
| `edit` | `{rule} asks before {agent} edits this file:` | `{agent} wants to edit this file:` |
| `execute` | `{rule} asks before {agent} runs this command:` | `{agent} wants to run this command:` |
| `fetch` | `{rule} asks before {agent} reaches this address:` | `{agent} wants to reach this address:` |
| `mcp` | `{rule} asks before {agent} calls this tool:` | `{agent} wants to call this tool:` |

The chip holds `subject.value`: the path, the command line, the URL, or `{server} · {tool}` for MCP. A request from a minor-1 runner (no `subject`) falls back to milestone 1's descriptor summary and command.

### The pattern line (**new**, from `approvals.preview`)

| Subject | Pattern (ADR 0049) | Line |
|---|---|---|
| a file | the exact path | `Approve for this task also approves later edits of this file.` |
| a command | the program and its first argument | `Approve for this task also approves commands that start with ` + mono `{pattern}` + `.` |
| a URL | the host | `Approve for this task also approves requests to ` + mono `{host}` + `.` |
| an MCP call | the tool's name | `Approve for this task also approves calls to ` + mono `{tool}` + `.` |

While the preview loads, the line is a 12px skeleton bar; if it fails, `Approve for this task` is disabled with the `Tooltip` `Couldn't read what this would approve.`

### Pressing an answer

- **In flight:** the pressed button shows `Approving…` or `Denying…`, all three are disabled, the block stays.
- **Won:** the block becomes its receipt at once (the committed event replaces it, the fold de-duplicates).
- **Lost the race** (`CONFLICT`): the block becomes the winner's receipt, and a 12px `--muted` line under it for this member only: **new** `Someone answered this first.` (ticket 43's Playwright check).
- **Closed while open** (the turn was cancelled, the request expired): the block becomes the closed receipt; the buttons go.
- **Other error:** a red 12px line under the buttons, the block kept.

### Receipts

| Outcome | Line (12px `--muted`) | Tool row's word |
|---|---|---|
| Approved once | `Approved once by {name}` | the tool's result |
| Approved for this task | **changed** `Approved for this task by {name}` + `--faint` ` · rule {rule}` (the rule that asked; omitted when none did) | the tool's result |
| Answered by a task rule | **changed** `Approved by this task's rule` + mono `--faint` ` {pattern}` (today `Approved by rule {rule}` with the rule's ID) | the tool's result |
| Answered by an old runner (`peer-too-old`) | **new** `Approved by the runner, which predates approval rules` | the tool's result |
| Denied, no reason | `Denied by {name}` | red `denied` |
| Denied with a reason | **new** `Denied by {name}, with a reason:` and under it the reason, 12px `--muted`, `whitespace-pre-wrap`, 10px left padding with a 1px `--line-2` left line. Shown to every member of the project; never in a log line or the audit entry (ADR 0049) | red `denied` |
| Cancelled by a deny | **new** `Cancelled: {name} denied another request in this turn` | `--faint` `cancelled` |
| Cancelled otherwise (a stop, an interrupt) | `The approval was cancelled` | `--faint` `cancelled` |
| Expired | **changed** `Nobody answered in 15 minutes, so the turn was cancelled.` + teal ` Answer anyway` while the needs-you item is open, which reopens the block (its answer reopens the task, ADR 0039) | `--faint` `expired` |

### After a deny

A message-level row (`m2/task-reopen.md`'s rows between turns: 14px icon in the gutter, no circle, 13px `--muted`): `corner-down-right` + **new** `The turn ended on the deny. {agent} got {name}'s reason and carries on.`, or with no reason `The turn ended on the deny. {agent} was told and carries on.` The re-prompt itself isn't drawn as a member message: its text is the reason already shown in the receipt.

### Questions

| State | Shows |
|---|---|
| open, driver | the form and `Send answer` |
| open, watcher | the form disabled, `Take over to answer`, `{driver} answers questions while driving.` |
| answered | the question's text in `--muted`, then one 12px `--muted` line: `Answered by {name}` and, **new**, the answer in `--faint`: each field as `{label}: {value}`, one per line |
| closed by the turn's end, item open | the form stays answerable by the driver, with 12px `--faint` **new** `The turn ended. Your answer reopens the task.` |
| closed | `Closed: {reason}` |

`Take over to answer` calls `tasks.takeOver`, then focuses the form's first field; the thread shows milestone 1's driver line (`Alex Kim is driving now`).

### Header status

| Open items | Status text |
|---|---|
| one approval | `Needs you · approval` |
| several approvals | **new** `Needs you · {n} approvals` |
| a question (with or without approvals) | `Needs you · question` |

The dot is amber; the words stay `--text` (milestone 1's rule).

## Tokens and components

Tokens: `app-concepts/html/graphite.css`; nothing new. Icons (Lucide, 14px in the thread): `hand`, `message-circle-question`, `corner-down-right`, `terminal`, `pencil`.

| Part | Component |
|---|---|
| Approval card | `ApprovalNote` grown: the shared `NeedsYou` block, `Button` `outline` and the amber variant, assistant-ui's approval plumbing where it fits (ADR 0036) |
| Deny reason | `Label` + `Textarea` |
| Pattern line | plain `p`, `Skeleton` while `approvals.preview` loads |
| Question form | `RadioGroup` + `RadioGroupItem`, `Checkbox`, `Input`, `Textarea`, `Label`, built from the elicitation schema |
| Watcher's bar | plain markup in the composer's place, `Avatar` 18px, `Button` `outline` |
| Approval rules group | the existing `PropGroup`, `Tooltip` for what a rule matches |

## Differences from the current code

1. **`ApprovalNote`** (`renderers.tsx`) renders the pending block read-only with the descriptor's summary and `task.approval.readOnly`. It gains the rule sentence, the subject chip from `subject`, the three buttons behind `capabilities.answerApprovals`, the pattern line from `approvals.preview`, the deny state, and the race line.
2. **Receipts:** `task.approval.auto` shows the rule's ID (`Approved by rule {rule}`); it becomes the task rule's pattern. `task.approval.task` gains the rule that asked; the deny's reason, the cancelled-by-deny and the expired lines are new. Today `closed` reads `The approval expired` / `The approval was cancelled`.
3. **`data-question`** renders the message and `task.question.readOnly`. It gains the form, `Send answer`, the watcher's state and the answer in the receipt.
4. **The not-driver line** (`task-thread.tsx`, `data-part="not-driver"`) becomes the watcher's bar.
5. **Header status** (`taskState.needsYouApproval`) gains the count for several approvals.
6. **Properties:** `Profile`, the usage rows and the `Approval rules` group are new.
7. **The fold** (`packages/task-view`): the approval part carries `rule`, `subject` and the deny's `reason` from `approval.requested` / `.answered`; a `data-system` part for the deny's re-prompt row.

## Open points for the build

Settle each with the maintainer; don't guess in code.

1. **Who sees a deny's reason.** This file shows it to every member of the project in the receipt; ADR 0049 keeps it out of the audit entry only. If it should be the denier's and the driver's alone, the receipt shows `with a reason` and no text.
2. **Several approvals and one "Approve for this task".** Two open requests can match one pattern (two `pnpm add` at once). The first answer writes the rule; the runner then answers the second by it, and its block becomes a receipt. Ticket 30 should confirm the runner re-checks held requests when a task rule arrives; otherwise the second stays open until answered.
3. **"Answer anyway" on an expired approval** needs `approvals.answer` to accept an expired approval whose item is open (ticket 17 says it reopens the task). If the API refuses it, the receipt shows no action and the item is answered from Home.
4. **A question's answer by a watcher.** ADR 0049 makes questions the driver's. The picture's `Take over to answer` takes the wheel for the whole task, not only for the question; the bar under it says so.

## Wrong in the image

| In the image | Build |
|---|---|
| `task-approval`: the reason field has a stray short line inside its bottom-left corner | a clean `Textarea` |
| Tool rows: the paths start a few px apart from row to row (`Ran` rows vs `Editing`) | milestone 1's fixed 72px verb column, so every path starts at the same x |
| `task-approval-question`: the question `Where should the history file live?` in a condensed bold face | IBM Plex Sans 13px weight 500, `--text` |
| `task-approval-question`: the agent message's header is missing above the first tool rows (they look orphaned) | the thread scrolls; rows always sit under their message, and a scrolled view simply starts mid-turn |
| The deny state's `Cancel` in `--muted` 13px with no button frame | `Button variant="ghost"`, 28px |
| `SR` avatar in the bar drawn 28px | 18px, as the properties' driver avatar |
| Sidebar rows that don't exist yet (Automations, Memory, Insights, Members, Audit log, Background work, Runner pools) | the shared sidebar's real routes |
| The hinge mark, redrawn | the real `kit/logo/export/ostra-hinge-single-color.svg`, 20px |
| `CALC-188`, `build-fleet-07`, the paths and commands, `$1.82`, the token counts, names and times | demo data, not copy |
