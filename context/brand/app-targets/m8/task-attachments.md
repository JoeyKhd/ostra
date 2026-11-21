# Target: screenshots and recordings in the task timeline (proposed 2026-11-21)

> **Committed images:** `task-attachments.png` and `task-attachments-viewer.png` (2880×1912, the render at 2×) with their `.webp` (1440×956, one image pixel per CSS pixel), rendered with Playwright from `html/task-attachments.html` (`?viewer=1` for the viewer). The thumbnails are the demo app (`html/app-fixture.js`). Sizes in this file are CSS px.

| Picture | State shown |
|---|---|
| `task-attachments.webp` | `CALC-192` is in review. The agent's turn at 14:31 holds `Captured 3 screenshots of /history` with three thumbnails (1280, 768 and 390 wide, each at its own aspect), then `Recorded Add, reload, reuse a result · 0:42 · 4 steps` with its thumbnail, then the line saying where they are: the draft PR's description, and kept with the task. Then Sam's reply. The properties panel adds a `Screenshots and recordings` group. |
| `task-attachments-viewer.webp` | The first thumbnail was clicked. The viewer shows the screenshot large, with ← and →, a filmstrip of the turn's four attachments, and the selected one's facts and actions: `Compare with 14:12`, `Download` and `Copy link`. |

- **Route:** unchanged, the task page (`components/tasks/task-view.tsx`), Activity tab. The viewer is a `Dialog` with `?attachment={id}` in the URL, so a link opens it.
- **Shell:** the double sidebar (`app-shell.md`). The project panel's live row shows `CALC-192 · In review · PR #486`.
- **Features:** F-121 (seeing the running app: screenshots and recordings). The milestone 8 spec moves it into v1 and names this screen `task-attachments` (target 4). Facts: `context/research/live-previews.md`, section 6. The maintainer approved "screenshots in the timeline" on 2026-11-21.
- **Status: a proposed target, waiting for the maintainer's approval.**

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with each picture.

## Purpose

Most cloud agents ship a picture of what they built: Copilot, Codex, Jules, Cursor and Devin (research §6). In ostra, the agent captures the running app in its box (F-121: a headless browser in the base image). A member reading the task should:
1. **See what the agent saw,** at the point in the turn where it looked, without opening a preview.
2. **Know what each picture is:** the route, the width, the preview, and when it was taken.
3. **Find them again:** in the PR, and in the task for as long as the task is kept.

## The thread (`task-attachments.webp`)

Inside an agent's turn, at its place among the tool rows:

1. **The capture row,** milestone 1's tool row grid (`28px icon | 76px verb | subject | 10px | end`): `image` 14px `--faint`, the verb `Captured`, then `3 screenshots of` (Plex Sans) and the route in mono `--text`. At the end, mono 13px `--faint` names the preview (`web :5173`). With several routes the subject is `3 screenshots` and each caption carries its route.
2. **The strip,** 32px in from the turn's text and 12px between thumbnails, aligned on their bottom edge. Each thumbnail is 110px tall at its capture's own aspect: 1280×800 is 176 wide, 768×1024 is 82, 390×844 is 51. Each has a 1px `--line-2` edge, a 6px radius, and a white ground for the app.
   - **Under each,** a caption in Plex Mono 12px `--muted`: the width, ` · ` and the route on the first one (`1280 · /history`); the width alone when the route repeats.
   - **Each is a button** that opens the viewer on it. Hover draws a `--line-3` edge, and focus the 2px `--teal` outline.
   - **More than 6** show the first 5 and a 110×110 tile, `+{n}` mono 13px `--muted` on `--surface`, which opens the viewer at the 6th.
3. **The recording row:** `clapperboard`, the verb `Recorded`, the recording's title in Plex Sans (the agent's words, as data), and mono `--faint` `0:42 · 4 steps`. Under it, its thumbnail (176×110), with a centred 34px play disc (`rgba(13,14,16,.78)` and `play` 15px filled `#F2F3F4`) and a duration chip at the bottom-right (18px, mono 11.5px on the same dark). The caption reads `1280 · recording`.
4. **Where they are,** one line 32px in: `paperclip` 14px `--faint`, then 13.5px `--muted` `In the description of draft PR #486, and kept with the task` and `--faint` `· links need a sign-in`. Without a PR yet: `Kept with the task. They go into the PR's description when it opens.` Where the project turns that off: `Kept with the task.`

**After-turn screenshots** (the environment's "Screenshots after each turn", F-121/F-139) come in as the same row at the turn's end, with the verb `Captured` and the subject `the environment's 3 routes`. A **member's screenshot** from the preview pane's `camera` comes in as a row in the member's own message: `Sam Rivera · Screenshot of /history`.

## The viewer (`task-attachments-viewer.webp`)

A `Dialog` (`radix-ui`, as `../m7/task-subagents-tree.md`'s window):
- **The window:** `w-[min(1240px,calc(100vw-32px))]` by `min(860px, 100vh-48px)`, centred; `--raise`, 1px `--line-2`, 12px radius, `--shadow-palette`, over `--scrim`.

1. **Header,** 52px, padding `0 16px 0 20px`, a 1px `--line` under it:
   - `Screenshots and recordings` 15px 600 (`Dialog.Title`);
   - 13px `--faint` `CALC-192 · OpenCode's turn at 14:31 · 1 of 4`;
   - right: `Kbd` `←` `→` `to move`, then `Kbd` `esc` and `Close`, in 12.5px `--faint`.
2. **The stage,** `minmax(0,1fr)` on `--surface`, with a 1px `--line` at its right:
   - **The picture,** centred, scaled to fit with 18px above and below and 56px at the sides, never above 100%. It has a 1px `--line-2` edge and a 6px radius.
   - **← and →,** 34px circles (`--raise`, 1px `--line-2`, `chevron-left`/`-right` `--muted`), 12px from the stage's sides.
   - **Clicking the picture** toggles 100% in a scrollable stage.
   - **The filmstrip,** 120px, `--raise`, a 1px `--line` above, centred, 14px gaps: the turn's attachments at 75px tall in their aspect, each captioned in mono 12px. The open one has the 2px `--teal` outline.
3. **The facts,** 300 wide, padding 18px:
   - **The kind** (12px 500 `--faint`: `Screenshot`, `Recording`).
   - **The route** in Plex Mono 16px `--text`.
   - **Then the property rows** (`92px 1fr`, 28px tall):
     - `Width` (`1280 × 800`);
     - `Preview` (`web :5173`);
     - `Taken` (mono time and `by OpenCode`, or a member's name);
     - `Turn` (a teal link that closes the viewer and scrolls to the turn);
     - `File` (`PNG · 212 KB`, `WebM · 3.1 MB`);
     - `In` (`PR #486 description`, teal).
   - **Actions,** full-width 28px buttons, 8px apart:
     - `Compare with {hh:mm}`, shown when an earlier capture of the same route and width exists in the task. It turns the stage into a before/after slider: a 2px `--text` handle with a 28px grip, and the two times as chips at the top corners.
     - `Download`.
     - `Copy link`: a panel link that needs a sign-in (ADR 0043).
   - **A note** (`lock` 14px, 12.5px `--faint`): `Kept in the blob store with the task. A link opens only for someone who can open calculator.`

**A recording** opens in the same viewer:
- **The stage** is a `<video>` with the browser's own controls off and ostra's bar under it (36px): play/pause, the time in mono, a scrubber with the steps as 2px `--muted` ticks, the speed (`1×`, `1.5×`, `2×`), and full screen.
- **The facts column** lists the steps (`1 Add 1,027.6 × 1.25`, `2 Reload`, `3 Reuse 1,284.50`, `4 Check the display`), each a button that seeks. The playing step has a `--sel` fill.

## Every state

| State | What shows |
|---|---|
| **Captured** (both pictures) | As above |
| **Capturing** | The row with a spinner in place of the icon, the verb `Capturing`, and gray 110px placeholders (`--surface`, a 1px `--line` edge) for each declared width. They fill in as each lands |
| **A capture failed** | The row ends in `--red` `failed`, and its tooltip names the reason in words (`The page didn't load in 30 s`, `The browser isn't in this box`). No placeholder stays |
| **The browser isn't available** (an image without it, or a `host` runner that can't find or download one; m8 spec ticket 11) | One `--faint` line in the turn: `No screenshots: the box has no browser.` and `How to add one` (docs). Once per task |
| **Still uploading** | The thumbnail shows at 50% with a 2px `--teal` progress bar at its bottom |
| **The blob is gone** (the task's retention ended) | A 110px tile on `--surface`: `image-off` 16px `--faint` and `Removed with the task's files`. The row stays |
| **A secret in a picture** | Not detectable. The note under the strip says what's kept where; the project's setting can keep screenshots out of the PR (m8 spec, ticket 16) |
| **Light theme** | `../m7/light-task.md`'s tokens. Thumbnails keep the app's own colours on a white ground |

## Keyboard

- **Each thumbnail** is a button named `Screenshot of /history at 1280 wide, 14:31, open`. Enter opens the viewer.
- **The viewer** traps focus (Radix), with first focus on the picture. ← and → move, Home and End jump to the first and last, and Escape closes and returns focus to the thumbnail.
- **On a recording:** Space plays or pauses, J and L seek 5 s, and the steps are a list of buttons.
- **The before/after slider** is a `slider` (`aria-valuetext="Before 40%"`): ← and → move it 5%.

## Narrow and phone width

- **Below 1180:** the viewer's facts column drops under the stage as a two-column grid of the properties, then the actions in a row.
- **On a phone** (390): thumbnails stay 110px tall, and the strip scrolls sideways when it outgrows the column. The viewer is full screen: the picture fits the width, a swipe moves, the facts sit in a bottom sheet (`Info`), and the filmstrip is a row of 56px tiles.

## Components (shadcn/ui names)

- **From the repo:** `Dialog`, `Button`, `Kbd`, `Slider`, and milestone 1's tool rows (`task/renderers.tsx`).
- **New:**
  - `components/tasks/attachment-strip.tsx`;
  - `attachment-thumb.tsx`;
  - `attachment-viewer.tsx`, with its stage, filmstrip, facts and compare;
  - `recording-player.tsx`.

  The kind is a union (`"screenshot" | "recording"`), with an exhaustive `switch`.
- **Icons** (Lucide, stroke 1.75): `image`, `clapperboard`, `play`, `paperclip`, `chevron-left`, `chevron-right`, `columns-2`, `download`, `link`, `lock`, `image-off`.

## Tokens

`--surface` is the stage and the placeholders, and `--raise` is the window and the filmstrip. Edges are `--line-2` for thumbnails and `--line` for hairlines. `--teal` is the selected outline, the links and the progress. `--muted` and `--faint` are the captions and facts, and `--red` is `failed`. No amber.

## WCAG AA (F-081)

| Pair | Dark | Light | Need |
|---|---|---|---|
| `--muted` on `--bg` (captions) | 9.6:1 | 8.1:1 | 4.5 |
| `--faint` on `--raise` (the viewer's header, the note) | 5.4:1 | 5.8:1 | 4.5 |
| `--muted` on `--raise` (the facts' keys) | 8.8:1 | 8.5:1 | 4.5 |
| `#F2F3F4` on `rgba(13,14,16,.78)` over a white thumbnail (the duration chip, at its lightest) | 8.9:1 | same | 4.5 |
| `--teal` outline against `--bg` (the selected thumbnail) | 8.4:1 | 6.1:1 | 3 (a focus indicator) |

## Data it needs (m8 spec, ADR 0068)

1. **An attachment per capture:** kind, blob ID, route, width × height, preview label and port, who took it (the agent, a member, or after the turn), time, size, the turn's event ID, and the PR it went into. For a recording: duration and steps (time and words).
2. **The capture's events** in the task's event stream (`attachment.captured`, `attachment.failed`), folded by `packages/task-view` at the turn's place.
3. **The project's settings:** after-turn routes and widths, and whether captures go into the PR.

## Differences from the current code

1. **No attachments** in the event stream or the thread renderers.
2. **No viewer.**
3. **The properties panel** gains the `Screenshots and recordings` group when the task has any.
4. **Messages:** new keys under `task.attachments.*`.

## Open points (recommendations; the maintainer's approval settles them)

1. **Thumbnail height:** 110px, as drawn, for three widths side by side in a 500 to 760 column. Recommended.
2. **Captures in the PR by default:** yes, as Cursor and Codex do (research §6), behind a project setting. The PR links to the panel (sign-in) rather than to a public URL.
3. **"Add to draft"** (the m8 spec's wording for a draft task): an action on the thumbnail's menu, not a button on every one. Not drawn.

## Wrong in the image (build from this file)

- **The capture row's end** reads `web :5173` without the preview's label colour. Mono `--faint`, as drawn, is right; the row has no colour.
- **The thumbnails' app** is the demo fixture scaled down. The build shows the real image, `object-fit: cover` from the top.
