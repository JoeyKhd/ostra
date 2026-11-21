# Target: a member's message with attachments in the thread (waits for the maintainer's approval)

> **Committed images:** `message-attachments.png`, `message-attachments-light.png` and `message-attachments-viewer.png` (2880×1912, the render at 2×), each with its `.webp` (1440×956, one image pixel per CSS pixel). Rendered with Playwright from `html/message-attachments.html` (`?theme=light`, `?viewer=1`). The phone version is the second screen of `composer-phone.webp` (`composer-attachments.md`). Sizes in this file are CSS px.

| Picture | State shown |
|---|---|
| `message-attachments.webp` | Sam's reply at 14:52 on `CALC-192`: his words, Dana's mock and a pasted screenshot as thumbnails, and three files: a docx and a PDF with their text extracted, and a csv. The pointer rests on the PDF: it shows `download`, and the `text extracted` mark's tooltip says what that means. Then OpenCode's turn reads the files. The properties panel's `Screenshots and recordings` group is now `Attachments`. |
| `message-attachments-light.webp` | The same, in the light theme. |
| `message-attachments-viewer.webp` | The mock opened in milestone 8's viewer: titled `Attachments`, the two images in the filmstrip, and the image's facts. |
| `composer-phone.webp`, screen 2 | The same kind of message at phone width, to a model that can't see images. |

- **Route:** unchanged, the task page, Activity tab. The viewer is milestone 8's `Dialog` with `?attachment={id}` in the URL (`../m8/task-attachments.md`, "The viewer").
- **Shell:** the double sidebar (`../m8/app-shell.md`).
- **Features:** the milestone 9 spec's attachment features; F-121's viewer and strip (`../m8/task-attachments.md`); F-114 for where the files are kept.
- **Status: waits for the maintainer's approval.**

> Build it in real HTML/React (`../../app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with each picture.

## Purpose

What a member sent is part of what happened, so it stays in the thread with the words it came with. Anyone reading the task should:
1. **See the pictures** the member sent, and open them large, in the same viewer as the agent's screenshots.
2. **Get the files back:** each one downloads.
3. **Know what the agent got:** that ostra read a document's text for it, and when an image went to the agent as a file.

## The message (`message-attachments.webp`)

A member's message as now (`task/task-thread.tsx`, `MessageView`): the 28px avatar, the name and the time, the words. Under the words, in the text column:
1. **The images,** 10px under the words: milestone 8's strip (`attachment-strip.tsx`), aligned on the bottom edge, 12px apart. Each thumbnail is 110px tall at its image's own aspect (1440×900 is 176 wide, 390×844 is 51), with a 1px `--line-2` edge, a 6px radius and a white ground.
   - **No captions,** unlike the agent's captures: a member's image has a file name, not a route and a width, and the name is in the button's name and the viewer.
   - **Each is a button** that opens the viewer on it. Hover draws a `--line-3` edge, focus the 2px `--teal` outline.
   - **More than 6:** the first 5 and the `+{n}` tile, as milestone 8 draws it.
2. **The files,** 10px under the images: one wrapping row, 8px gaps. Each is a chip 52 tall and at most 320 wide, drawn as in the tray (`composer-attachments.md`) but on the page: no fill, 1px `--line-2` edge, 8px radius, padding `0 14px 0 8px`, the 34px `--sel` type tile, the name in 13.5px 500 `--text` and Plex Mono 12px `--faint` `PDF · 1.2 MB`.
   - **Each chip is a link** that downloads the file under its own name (`Content-Disposition: attachment`). Hover fills it `--hover`, edges it `--line-3`, and shows `download` 15px `--faint` at its end. Focus is the 2px `--teal` outline.
   - **`text extracted`:** after the size, ` · `, `scan-text` 12px `--faint` and 12px Plex Sans `--muted` `text extracted`, on a document ostra read the text out of (docx, pdf, and the other kinds the spec names). Its tooltip: `ostra took the text out of this file, {n} words, so the agent can read it. {agent} got the {TYPE} and its text.`
3. **When the model can't see images,** a line 10px under the files: `image-off` 14px `--faint`, 13.5px `--muted` `{model} can't see images: {agent} got them as files.` (`composer-phone.webp`, screen 2). Nothing on the thumbnails themselves.

**While sending,** the message shows at once with its attachments drawn from the files in the browser, and the header's `sending…` as now. Once sent, they're read from the blob store.

## The agent's turn

Nothing new: the agent's tool rows show what it read (`Read .ostra/attachments/4/history-panel-spec.docx.md`). The paths are the box's, so they read as the agent's own.

## The properties panel

Milestone 8's `Screenshots and recordings` group becomes **`Attachments`** (open point 1), shown when the task has any:
- `From people`: `2 images · 3 files` (a member's uploads, and the ticket's in `ticket-context.md`);
- `Captured`: milestone 8's screenshots and recordings (`1 screenshot`);
- `Size`: all of them, mono;
- `Where`: `The blob store, with the task`;
- `In the box`: mono `.ostra/attachments/`;
- `In the PR` stays as milestone 8 has it, for captures only.

## The viewer (`message-attachments-viewer.webp`)

Milestone 8's viewer, unchanged but for what it shows of a member's image:
- **Header:** `Attachments` (15px 600), then 13px `--faint` `CALC-192 · Sam Rivera's message at 14:52 · 1 of 2`. The agent's captures keep `Screenshots and recordings`.
- **The stage and the filmstrip:** the message's images only. The files aren't in it: they download.
- **The facts:**
  - the kind, `Image`, then the file's name in Plex Mono 15px `--text` where a capture shows its route;
  - `Size` (`1440 × 900`), `File` (`PNG · 412 KB`), `From` (the avatar and the name), `Message` (a teal link that closes the viewer and scrolls to the message), `Agent got` (`the image`, or `a file: the model can't see images`), `In the box` (mono `.ostra/attachments/4/`).
- **Actions:** `Download` and `Copy link` (a panel link that needs a sign-in, ADR 0043). No `Compare with`: that's for captures of one route.
- **The note** as milestone 8 words it: `Kept in the blob store with the task. A link opens only for someone who can open calculator.`

## Every state

| State | What shows |
|---|---|
| **Sent, read** (the pictures) | As above |
| **Sending** | The message with `sending…`; thumbnails from the browser's copy. If the send fails, the message shows the failure as now, and its files stay in the tray to try again |
| **A document whose text couldn't be read** (a scanned PDF, a locked docx) | No mark. The chip's tooltip says `ostra couldn't read the text of this file; {agent} got the file.` |
| **A document still being read** | `text extracted` shows once the text is ready; until then nothing. The agent's turn waits for it (data section) |
| **The model can't see images** | The line under the files, as above |
| **The files are gone** (the task's retention ended) | An image's thumbnail becomes milestone 8's 110px `image-off` tile, `Removed with the task's files`; a chip keeps its name, loses its link, and its second line reads `removed with the task's files` |
| **More than 6 images** | 5 and `+{n}`, as milestone 8 draws it |
| **Light theme** | `../m7/light-task.md`'s tokens. Images keep their own colours |

## Keyboard

- **Each thumbnail** is a button named `Image history-panel-mock.png from Sam Rivera, open`; Enter opens the viewer. The viewer works as milestone 8's: ← and → move, Home and End jump, Escape closes and puts the focus back.
- **Each chip** is a link named `Download history-panel-spec.docx, DOCX, 48 KB, text extracted`.
- **The `text extracted` mark** is part of the link; its words reach a screen reader through the name, and the tooltip opens on focus as on hover.

## Narrow and phone width

- **Phone** (`composer-phone.webp`, screen 2): thumbnails stay 110px tall and the strip scrolls sideways when it outgrows the column. Chips take the column's width, one under the other. The model's line wraps.
- **The viewer** is full screen on a phone, as milestone 8's.

## Components (shadcn/ui names)

- **From the repo:** milestone 8's `attachment-strip.tsx`, `attachment-thumb.tsx`, `attachment-viewer.tsx` and `attachments-group.tsx`; `Tooltip`.
- **New:** `components/tasks/attachments/file-chip.tsx` (the tray's item and this chip share its inside), and the viewer's facts for a member's image. The attachment's source is a union (`"capture" | "message" | "ticket"`), with an exhaustive `switch` where the viewer's title and facts differ.
- **Icons** (Lucide, stroke 1.75): `scan-text`, `download`, `image-off`, and the type icons in `composer-attachments.md`.

## Tokens

The chips have no fill on the page: `--line-2` edges, `--sel` type tiles, `--hover` and `--line-3` on hover. `--muted` is `text extracted` and the model's line; `--faint` the meta and icons. `--teal` is focus and the viewer's links. No amber.

## WCAG AA (F-081)

| Pair | Dark | Light | Need |
|---|---|---|---|
| `--text` on `--bg` (a file's name) | 17.4:1 | 17.5:1 | 4.5 |
| `--faint` on `--bg` (a file's type and size) | 5.9:1 | 5.6:1 | 4.5 |
| `--muted` on `--bg` (`text extracted`, the model's line) | 9.6:1 | 8.1:1 | 4.5 |
| `--muted` on `--sel` (the type icon) | 8.6:1 | 7.0:1 | 3 (a graphic) |

## Data it needs (for the milestone 9 spec)

1. **An attachment per file:** its source (a member's message, a ticket, a capture), the message's event, kind, name, type, size, blob ID, the box path, and for an image its pixel size.
2. **The extracted text,** per document: whether it was read, its word count, and its blob. Where the text is read (the server or the runner) and with what is the spec's call, and a library for it is a new dependency for the maintainer to approve.
3. **What the agent got** per image: as an image, or as a file because the model or the agent can't take images.
4. **The task's event stream:** the member's message event carries its attachment IDs, so `packages/task-view` folds them into the message.

## Differences from the current code

1. **A member's message** carries only text (and, from milestone 8, a screenshot from the preview pane's camera).
2. **The viewer** titles everything `Screenshots and recordings` and shows a capture's facts only.
3. **The properties panel's group** is `Screenshots and recordings` (`attachments-group.tsx`).

## Open points (recommendations; the maintainer's approval settles them)

1. **One `Attachments` group** in the properties panel for captures, members' files and the ticket's, as drawn, rather than a second group beside milestone 8's. Recommended.
2. **No captions** under a member's images, as drawn: the name is in the viewer. The alternative is the name cut to the thumbnail's width, which says little on a phone screenshot 51 wide.
3. **A document's extracted text isn't shown** in the panel: the mark says it exists, and the agent reads it. Showing it (a `Show the text` on the chip's menu) can come later.

## Wrong in the image (build from this file)

- **The thumbnails** are the demo app and a drawn mock, scaled. The build shows the real images.
- **The tooltip and the hover** are drawn on the PDF at once for the picture; the build shows the tooltip only while the pointer or the focus is on the mark.
- **The viewer's mock** has its notes in a design tool's purple: that's the image's own colour, not ostra's.
