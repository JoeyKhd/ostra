# Target: the ticket's context on a task started from Linear (waits for the maintainer's approval)

> **Committed images:** `ticket-context.png`, `ticket-context-light.png`, `ticket-context-skipped.png` and `ticket-context-failed.png` (2880×1912, the render at 2×), each with its `.webp` (1440×956, one image pixel per CSS pixel). Rendered with Playwright from `html/ticket-context.html` (`?theme=light`, `?state=skipped`, `?state=failed`). Sizes in this file are CSS px.

| Picture | State shown |
|---|---|
| `ticket-context.webp` | `CALC-170`, from Linear, a minute in. The header keeps the ticket strip. The thread's first message is **What the agent got**: the description (three lines, `Show all`), the ticket's 7 attachments (three screenshots; a docx and a PDF with their text extracted; a csv; a Sentry link, not fetched), two of its three comments, and the line saying where it all is in the box, with `Show the prompt`. OpenCode's turn starts under it. The Ticket group gains a `Context` row. |
| `ticket-context-light.webp` | The same, in the light theme. |
| `ticket-context-skipped.webp` | A ticket with 23 attachments: 20 given (16 images, 4 documents), and 3 left out with the reason for each: two over 10 MB, one past the 20-attachment limit. |
| `ticket-context-failed.webp` | Two attachments didn't load from Linear: their places are dashed, a red-ruled block names them and the reason, and `Retry` fetches them. The agent started without them. |

- **Route:** unchanged, the task page for a ticket task (`source: "ticket"`), Activity tab.
- **Shell:** the double sidebar (`../m8/app-shell.md`).
- **Builds on:** milestone 2's ticket task page (`../m2/task-ticket.md`): the key line, the ticket strip, `What the agent got`, the Ticket and On Linear groups. This file moves `What the agent got` from the header into the thread and fills it.
- **Features:** F-064 (ticket context: "The agent receives the ticket's title, description, comments, labels and images…"), which this widens to every attachment; the milestone 9 spec's attachment features; F-114.
- **Why:** the maintainer, 2026-11-21: when a task starts from a Linear ticket (Jira later), "the full ticket should be used as context… screenshots, docx anything should be added as context."
- **Status: waits for the maintainer's approval.**

> Build it in real HTML/React (`../../app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with each picture.

## Purpose

A member opening a task that came from a ticket should see exactly what the agent started from, without going to Linear:
1. **The ticket as the agent got it:** its words, every file, its comments.
2. **What didn't make it,** and why: a file too big, too many files, a fetch that failed, and a way to fetch again.
3. **Where it is in the box,** so the agent's `Read .ostra/ticket/…` rows make sense, and the rendered prompt one click away.

## The header

Milestone 2's, less one row: the key line (`CALC-170 · from Linear`), the title, the status line, and the ticket strip (status chip, labels, priority, `Open in Linear`). **The `What the agent got` row under the strip goes** (`task-ticket.tsx`, `AgentGot`): it's now the thread's first message.

## The first message: What the agent got (`ticket-context.webp`)

The thread starts with it, before the agent's first turn, at message level:
- **The avatar:** the 28px circle with `ticket` 14px `--muted`.
- **The header:** `What the agent got` (600), then Plex Mono 13px `--faint` `14:02 · CALC-170 from Linear` (the time ostra put the context together; the tracker's name as the key line has it).

Then three sections, each under a 12px 500 `--faint` label 12px below the last, in the order Linear shows them:

1. **Description.** The ticket's Markdown, drawn as the thread draws Markdown (text, never HTML), 14.5px `--text`, clamped to 3 lines. Under it a teal `Show all` + `chevron-down` (13.5px), which opens the rest in place and turns into `Show less`. An image inside the description shows as its name in teal (it opens the viewer) where it sits, and its thumbnail is with the attachments.
2. **Attachments** with its count (`7`; `20 of 23` when some were left out; mono 12px):
   - **Images** in milestone 8's strip: 110px tall at their own aspect, 12px apart, no captions, each opening the viewer (titled `The ticket's attachments`). More than 6: five and the `+{n}` tile.
   - **Files** as the thread's chips (`message-attachments.md`): the type tile, the name, `DOCX · 212 KB`, `text extracted` on a document ostra read. Each downloads.
   - **A link** (Linear's URL attachments: a Sentry issue, a Figma frame, a GitHub issue) as a chip with `link-2` on an outlined tile (no fill), its title, and Plex Mono `Link · not fetched`. It opens the URL in a new tab. ostra gives the agent its title and URL and fetches nothing behind it.
   - Images and files come from the description, from the ticket's uploads and from its comments, ostra's own progress comment left out. The viewer's facts say where each came from (`From: Marcus Lee's comment`).
3. **Comments** with their count. One row each, 28 tall: the 20px avatar, the name 500 and Plex Mono 12.5px `--faint` age (`1 d`, `20 h`), then the text on one line, cut with an ellipsis, in `--text-2`. The newest two show; `Show {n} more` opens the rest, each comment then wrapping in full.

**The last line,** 12px under: `paperclip` 14px `--faint`, 13.5px `--muted` `In the box under` + mono `.ostra/ticket/` + `, with the title, the labels and the profile's instructions`, ` · `, and a teal `Show the prompt` + `chevron-down`, which opens milestone 2's code block of the rendered first prompt under the line (`../m2/task-ticket.md`, "Context row": `--surface`, 1px `--line`, 8px radius, Plex Mono 12px/1.6, at most 320 tall, scrolling; text, never HTML).

**The thread's `Ticket files ready` row** (`data-ticket-files`) goes: this line says it.

## The properties panel

Milestone 2's groups. **Ticket** gains one row after `Synced`:
- `Context`: `7 attachments · 3 comments`; `20 of 23 attachments` when some were left out; `--red` `2 attachments didn't load` when a fetch failed.
Clicking it scrolls the thread to the first message.

## Every state

| State | What shows |
|---|---|
| **Fetching** (the task is starting) | The first message with its header and a `--faint` line with the 11px spinner: `Fetching the ticket's attachments and comments…`. The agent's first turn starts once it's done, or once the fetch gives up |
| **All fetched** (`ticket-context.webp`) | As above |
| **Some left out** (`ticket-context-skipped.webp`) | The count reads `20 of 23`. Under the files, 10px down, 13.5px `--muted`: `circle-minus` 14px `--faint` and `3 left out, and the agent was told which`, then one 24px row each, 22px in: the name in mono `--text` and the reason: `84 MB, over the 10 MB a file can be`, `past the 20 attachments a ticket can give`. The agent's prompt lists the same names and reasons |
| **A fetch failed** (`ticket-context-failed.webp`) | Each attachment that didn't load keeps its place: an image as a 110px dashed tile (1px dashed `--control-line`, `image-off` 16px `--red`, its name and `didn't load` in 12px `--faint`), a file as a dashed chip with `file-x` `--red` and `didn't load`. Under the files, a 2px `--red` rule with 12px in: `circle-alert` and `2 attachments didn't load from Linear` (14px 500 `--red`); the names in mono and the reason (`Linear answered 503 three times, the last at 14:02.`, 13.5px `--muted`); then `Retry` (`rotate-ccw`, a small outline button) and 13px `--faint` `The agent started without them. Once they load, it gets them with its next turn.` |
| **Retrying** | `Retry` reads `Retrying…`, disabled |
| **Retried, loaded** | The tiles fill in, the block goes, and ostra sends the agent a message of its own (F-072's automatic message, `ostra` as the author): `The ticket's attachments that didn't load are in .ostra/ticket/: wrong-total.png, IEEE-754-note.pdf.` It's queued like any message: it goes with the next turn, or starts one when the session is idle |
| **The whole ticket couldn't be read** (Linear down, the token revoked) | Not this screen: the task doesn't start, as milestone 2's intake handles it |
| **No attachments, no comments** | The sections with nothing are left out; a ticket with only a title shows only the last line |
| **The ticket changed on Linear after the task started** | The first message stays what the agent got. A new comment comes in as milestone 2's Linear follow-up message; the strip shows the ticket's status now |
| **The agent's model can't see images** | The images went as files: the last line adds ` · images as files: {model} can't see them` |
| **Light theme** (`ticket-context-light.webp`) | `../m7/light-task.md`'s tokens. Images keep their own colours |

## Keyboard

- **`Show all`, `Show {n} more` and `Show the prompt`** are buttons with `aria-expanded`.
- **Thumbnails, chips and links** as `message-attachments.md`. A link chip is named `Sentry · ACME-WEB-4F2, link, opens in a new tab`.
- **`Retry`** is a button; when it's done, a polite live region says `2 attachments loaded` or the new failure.
- **The `Context` row** is a button named `Context: 7 attachments, 3 comments. Show what the agent got`.

## Narrow and phone width

- **Below 1180:** the properties panel folds as the task page's does today; the first message keeps its sections.
- **Phone** (390): the description clamps to 4 lines; the image strip scrolls sideways; the chips take the column's width, one under the other; each comment wraps to two lines before its ellipsis; the last line wraps.

## Components (shadcn/ui names)

- **From the repo:** `task-ticket.tsx` (`TicketLine`, `TicketProperties`, the prompt's code block from `AgentGot`), milestone 8's strip, thumbnail and viewer, the thread's Markdown, `Collapsible`, `Button`.
- **New:** `components/tasks/ticket-context-message.tsx` (the first message and its three sections), with the file chip from `message-attachments.md`. A fetched attachment's state is a union (`"ready" | "left-out" | "failed"`), and a left-out one's reason another (`"too-big" | "too-many" | "too-much"`), each `switch` exhaustive.
- **Icons** (Lucide, stroke 1.75): `ticket`, `link-2`, `circle-minus`, `circle-alert`, `file-x`, `image-off`, `rotate-ccw`, `chevron-down`, `paperclip`.

## Tokens

As `message-attachments.md`, plus: `--red` for a failed fetch's rule, icon and title; `--control-line` for the dashed places of what didn't load; `--text-2` for a comment's text. No amber: the ticket's context never needs a person by itself (open point 3).

## WCAG AA (F-081)

| Pair | Dark | Light | Need |
|---|---|---|---|
| `--red` on `--bg` (the failure's title) | 5.9:1 | 5.7:1 | 4.5 |
| `--muted` on `--bg` (the left-out reasons, the failure's words) | 9.6:1 | 8.1:1 | 4.5 |
| `--faint` on `--bg` (labels, ages, `didn't load`) | 5.9:1 | 5.6:1 | 4.5 |
| `--teal` on `--bg` (`Show all`, `Show the prompt`) | 8.4:1 | 6.1:1 | 4.5 |

## Data it needs (for the milestone 9 spec)

1. **The tracker adapter's ticket context** (`TicketContext` in `packages/adapter-sdk/src/tracker/base.ts`): the description, every comment (with its author and time), and every attachment. Today the Linear adapter lists only images: those inline in the description and comments, then image attachments, each once and only from `https://uploads.linear.app`, which `downloadFile` fetches with the app's token under a 10 MiB cap (`packages/adapters/adapter-linear/src/linear-adapter.ts`, `#imagesOf`, `DEFAULT_FILE_ORIGINS`, `MAX_ATTACHMENT_BYTES`). It widens to every file on that origin, a docx linked from the description as much as a screenshot, plus the URL attachments (title, subtitle, URL) it already reads. Jira later returns the same shape; an adapter that can't fetch files declares it, and the screen then shows the links alone (AGENTS.md, adapter parity).
2. **Per attachment:** its source (description, upload, a comment and whose), kind, name, type, size, and its state: fetched (with its blob ID and box path), left out (with the reason), or failed (with the reason words and the tries).
3. **The limits for a ticket:** 20 attachments, 10 MB each, 50 MB in all *(working values, open point 2)*.
4. **The extracted text** of each document, as `message-attachments.md` says, written beside it in the box (`rounding-rules.docx.md`).
5. **Retry:** one call that fetches the failed attachments again and, on success, queues ostra's message to the agent.

## Differences from the current code

1. **`AgentGot`** (`task-ticket.tsx`) is a collapsed row in the header, summarised as `title, description and labels`, and lists only the image files under `.ostra/ticket/`. It moves into the thread as the first message.
2. **Comments** aren't shown on the task page; the agent's prompt holds them (milestone 2's demo).
3. **The `Ticket files ready` row** (`data-ticket-files` in `renderers.tsx`) goes.
4. **Only images** are fetched from a ticket today (`contextFiles`); documents, other files and links aren't.
5. **The Ticket group** has no `Context` row.

## Open points (recommendations; the maintainer's approval settles them)

1. **The ticket as the thread's first message,** as drawn, rather than milestone 2's collapsed row in the header. It reads in order (the agent got this, then did that), and it isn't hidden. The cost: on a long task it scrolls away; the `Context` row brings it back. Recommended.
2. **A ticket's limits:** 20 attachments, 10 MB each, 50 MB in all, more than a message's 10 and 25 MB, since a ticket gathers files over its life. Recommended as working values for the spec.
3. **A failed fetch doesn't stop the task:** the agent starts with what loaded, the block offers `Retry`, and a retry's files reach the agent with its next turn, as drawn. The alternative is a needs-you block (`Start without them`, `Retry`) that holds the task until a person answers, which costs a night's run on an automation. Recommended: don't stop.
4. **Links aren't fetched** (a Figma frame, a Sentry issue): the agent gets their titles and URLs. Fetching what's behind them needs each service's sign-in. Recommended.
5. **Videos** (an `.mp4` of the bug) are attachments like any file, within the 10 MB a file can be, and the agent gets the file. Recommended; frames from a video are a later idea.

## Wrong in the image (build from this file)

- **The thumbnails** are the demo app with a reviewer's rings, scaled. The build shows the ticket's real images.
- **The comments' and the description's words** are demo data; the description's 3-line clamp is the build's, wherever the words break.
- **The agent's turn** is cut by the composer in `ticket-context.webp` because the thread scrolls; nothing is hidden on purpose.
- **`ticket-context-skipped.webp`'s `+11` tile** stands for eleven more demo screenshots.
