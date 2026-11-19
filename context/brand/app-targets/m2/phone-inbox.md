# Target: the Inbox at phone width (`/projects/[project-id]/inbox`, under 640px)

> **Committed image:** `phone-inbox.webp`, 390×756: the left screen of one 2048×1360 picture, cropped and downscaled to its CSS width, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

- **Image:** Higgsfield `gpt_image_2_6` (3:2, 2k, high), 1 generation. The picture has two phone screens side by side: this one, and `phone-task.webp`. References: the approved milestone 1 originals `task.png` and `project.png`, `app-concepts/html/home-graphite.png`, and the Hinge logo. Prompt: `phone-inbox.prompt.txt` (the same prompt is saved as `phone-task.prompt.txt`). The list behind the sheet was dimmed afterwards by a script (×0.45 above the sheet's edge): the generation drew the sheet but no overlay.
- **Status:** a candidate target for milestone 2, not yet approved by the maintainer (ticket 32).
- **Starts from:** `app-concepts/05-phone.png` (its one-column phone flow, with the action in reach of the thumb), restyled to the graphite targets. The concept's bottom tab bar is not taken: the panel's phone navigation is the sidebar drawer that exists today (`components/shell/app-shell.tsx`).
- **Features:** F-075 (responsive panel), F-010. Desktop spec: `inbox.md`. Everything there holds, including data, copy, states and tokens; this file only says what changes under 640px. Builder: ticket 35.

## Purpose

The same Inbox, thumb-first. On a phone a member mostly checks what came in and starts one ticket. So the list shows only what's needed to recognise a ticket. The selected ticket and its Start task form come up as a bottom sheet, with the button where the thumb is.

## Layout (CSS px at 390 wide)

| Region | Size | Contents |
|---|---|---|
| Top bar | 44px, hairline under, padding `0 12px` (`PageFrame` today) | The `menu` button (opens the sidebar `Sheet`, as today), then the last crumb `Inbox` (13px, weight 500, `--text`). On the right, a 32px ghost icon button, `search`, that shows the text filter (below) |
| Page | padding `24px 16px` (`PageFrame`'s `px-4 pt-6`) | Title, lede, filter row, list |
| Bottom sheet | full width, up to `85dvh` | The selected ticket and Start task |

### Page

1. **Title** `Inbox`, 24px as on desktop (`PageHeading`).
2. **Lede**, 13px `--muted`, wrapping to two lines: `Open tickets from Calculator on Linear · updated 8s ago`.
3. **Text filter:** hidden until the top bar's `search` button is pressed. Then it's a full-width `Input`, 40px, autofocused, 12px under the lede. It hides again when cleared and blurred. While it holds text, the search button shows a 6px `--muted` dot.
4. **Filter row**, 14px under the lede: the four triggers (`Status: Open, started`, `Label`, `Priority`, `Assignee`), **32px** tall for touch, in one row that **scrolls sideways inside itself**: `overflow-x: auto`, no visible scrollbar, `scroll-padding` 16px, and the page itself never scrolls sideways. Each opens its `Command` list in a bottom `Sheet`, not a `Popover`. The `{n} tickets` count moves to the end of the row.
5. **The list:** rows **56px**, a hairline under each, padding `8px 0`, two lines:
   - **Line 1** (12.5px): the priority icon (14px, `--muted`), the key in mono `--faint`. Then, when the ticket has a task, its mark and state word (`Running` with a green dot), 8px after the key. On the right, the age in mono 12px `--faint`.
   - **Line 2:** the title, 14px `--text`, one line, ellipsis, aligned with the key (22px indent).
   - Labels, status and board don't show in the row. They're in the sheet.
   - The selected row (the open sheet's ticket) has the `--sel` fill, radius 6px.
   - Tapping a row opens its sheet. The task mark is not a separate tap target on a phone: the sheet's `Open task` is.

### Bottom sheet

`SheetContent side="bottom"`, a new side for `components/ui/sheet.tsx`:
- `--side` fill, a 1px `--line-2` top border, `14px 14px 0 0` radius
- the overlay `bg-black/60` (as today)
- a 36×4px `--line-2` grab handle, radius 2px, centred 8px from the top. It's a real `button` labelled "Close" (`common.close`). Tapping it or the overlay closes the sheet, and so does Esc. The top-right `X` that `SheetContent` draws is hidden on this side.
- Its height follows its content, up to `85dvh`, and scrolls inside. The button row is sticky at the bottom with `padding-bottom: max(16px, env(safe-area-inset-bottom))`.
- The selection stays in the URL (`?ticket=CALC-174`), so the browser's back button closes the sheet.

Inside, padding `16px`, top to bottom (the copy is `inbox.md`'s):

1. **Head line:** mono 12px `--faint` key; on the right, teal `Open in Linear` + `arrow-up-right`.
2. **Title:** 17px, 600, `--text`, wrapping, margin `6px 0 8px`.
3. **Meta line**, 12.5px `--muted`, wrapping, gap 6px, separated by ` · `:
   - the status icon + name
   - the priority icon + word
   - the label chips
   - an 18px avatar + the assignee
   - These replace desktop's key/value rows.
4. **Description:** 13px/1.55 `--muted`, untrusted markdown as on desktop, clamped to **3** lines, with `Show more` inline in teal at the end of the clamp.
5. A hairline, 16px above and below. Then `Start a task` (12px, 500, `--faint`).
6. **Three selects**, full width, **40px**, gap 8px, `--surface`, `--line-2` border, radius 7px. Each holds its label inside on the left (12.5px `--muted`, 96px), then the value (13px `--text`, with its icon), then `chevron-down` on the right: `Kind` `Code`; `Agent profile` `bot` + `OpenCode · Claude Sonnet 5.5`; `Run on` `laptop` + mono `alex-mbp` + `· yours`. Each opens its options as a list in the same sheet (a native `select` is acceptable here if the shadcn `Select` misbehaves on iOS).
7. **Context line**, 12px `--faint` with `info`: as on desktop. Then the repo check line when it applies.
8. **The button:** full width, **44px**, `--shell` fill, `--ink` text, 600, `arrow-up` + `Start task`.

## States (what differs from `inbox.md`)

| State | At phone width |
|---|---|
| Ready, sheet open (the image) | As above |
| Sheet closed | The list only, nothing selected. The URL has no `?ticket` |
| Active task | The sheet's last group is `Task` (State, Task, Driver as stacked rows), and the 44px button becomes an outline `Open task` → `/tasks/{id}` |
| Starting / refused | In the sheet, as on desktop. The refusal line sits above the sticky button |
| Started | The sheet stays open on the active-task state, and the row behind it updates |
| No connection / no boards / nothing open | The illustration at `width: 100%` (max 560px, 3:2), then the copy centred, wrapping. The button is auto width, 44px tall |
| No match | As on desktop |
| Loading | 6 skeleton rows of two lines |

## Components

As `inbox.md`, plus `Sheet` with a new `side="bottom"` (with the grab handle as its close button). Below `xl` and above 640px, the same selection opens a right `Sheet` at 340px instead (`inbox.md`, "Differences", item 4).

## Tokens

> **Scale.** The sizes and colours below are `graphite.css`'s. The panel is built at the approved pictures' scale, which wins on size, spacing and contrast: body 14.5px, dense rows 14px, secondary 13px, small 12px, title 26px, `--muted` `#B4B7BB`, `--faint` `#8B8E93`, buttons 30px, a 46px top bar and a 320px properties panel (380px with a form). The measured values are in `../m1/README.md`, "Scale".

As `inbox.md`. Phone sizes: body 13–14px, controls 32px (filters) and 40px (selects), the primary button 44px, rows 56px, 16px gutters.

## Differences from the current code

- `PageFrame` already does the phone top bar (the `menu` button, the last crumb only) and the 16px gutters. It needs an optional icon action for the `search` button.
- `components/ui/sheet.tsx` has only `left` and `right`. Add `bottom`, with the handle, the rounded top and the safe-area padding, and with the close `X` hidden for it.
- Everything else is new with the Inbox (`inbox.md`).

## Wrong in the image (build from this file)

- **The screen is 390×756, not 844.** The model drew a wider-than-asked phone, so the crop is shorter. Positions from the top hold; the sheet's height follows its content, up to `85dvh`.
- **The top bar's right button** is a `sliders-horizontal` icon in a bordered box. Build a ghost `search` button (the filters already have their own row).
- **The title** is about 22px. Build 24px, `PageHeading`'s size.
- **The filter row** is about 30px tall. Build 32px.
- **The overlay** was added by script, not drawn: build `bg-black/60`, as the drawer has today.
- **The list rows** lose their labels and status at this width, which is intended. The image shows no status icon on line 1, which is also right.
- **Demo data:** the tickets, Sam Rivera and the runner name are fixtures.
