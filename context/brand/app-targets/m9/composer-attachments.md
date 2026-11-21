# Target: the message box with attachments (waits for the maintainer's approval)

> **Committed images:** `composer-attachments.png`, `composer-attachments-light.png`, `composer-drop.png`, `composer-states.png` and `composer-phone.png` (2880×1912, the render at 2×), each with its `.webp` (1440×956, one image pixel per CSS pixel). Rendered with Playwright from `html/task-composer.html` (`?theme=light`, `?view=drop`), `html/composer-states.html` and `html/composer-phone.html`. Sizes in this file are CSS px.

| Picture | State shown |
|---|---|
| `composer-attachments.webp` | `CALC-192` needs Sam: OpenCode asked for a design in its message, and the needs-you block at the end of the thread says so. Sam's reply is in the box: his words, then the tray with a pasted screenshot, Dana's mock, `history-panel-spec.docx`, and `results-sample.csv` still uploading at 62%. The box has the focus. The paperclip starts the controls row. |
| `composer-attachments-light.webp` | The same, in the light theme. |
| `composer-drop.webp` | Two files dragged over the page while the preview pane is open. The chat column is the drop zone; the preview pane isn't. |
| `composer-states.webp` | A board of eight boxes at real size: the new-task box as a drop zone, an upload that Send waits for, a file over 10 MB, the 10-file limit, the 25 MB limit, a failed upload, a model that can't see images, and files with no words with the focus on one. |
| `composer-phone.webp` | Three 390×844 screens: the box docked under the chat with files above the field, the sent message (`message-attachments.md`), and a new task with files (`new-task-attachments.md`). |

- **Route:** unchanged. The task page (`components/tasks/task-view.tsx`) and its composer (`task/task-thread.tsx`, `Composer`); the new-task page has its own box (`new-task-attachments.md`).
- **Shell:** the double sidebar (`../m8/app-shell.md`). The page is the task page as it is on 2026-11-21: the needs-you block at the end of the thread (`18d0e104`), the preview pane (`../m8/task-preview.md`) and the screenshots in the thread (`../m8/task-attachments.md`).
- **Features:** the milestone 9 spec, written beside these targets (`context/specs/` once it lands), gives attachments their feature IDs. F-114 (blob storage) keeps the files.
- **Why:** the maintainer, 2026-11-21: "add image support and file support to our chat text box thing, LOL no attachements?!?!?!?!", and "during chatting we should be able to upload attachments."
- **Status: waits for the maintainer's approval.** Its open points are at the end.

> Build it in real HTML/React (`../../app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with each picture.

## Purpose

A member steering a task should hand the agent what they're looking at as easily as typing:
1. **Attach** a screenshot, a mock, a spec, a log or a spreadsheet, by the paperclip, by pasting, or by dropping files on the page.
2. **See what goes,** before it goes: each file, its size, and its upload.
3. **Know what the agent can do with it:** a model that can't see images gets them as files, and the box says so before sending.
4. **Never lose a file silently:** a file the box won't take says why, at once, and a failed upload blocks Send until it's retried or removed.

## The box (`composer-attachments.webp`)

The composer is unchanged where this file doesn't say otherwise: 1px `--control-line`, 8px radius, `--surface`, padding `12px 14px`, the text at 14.5px/22px, the focus ring on the box (`.focus-box`, a 2px `--teal` outline 1px out).

Top to bottom:
1. **The text,** as now.
2. **The tray,** 12px under the text, only while the box holds files. One wrapping row, 8px gaps, in the order the files came. It sits under the text, next to the paperclip that filled it (open point 1).
   - **An image** (PNG, JPEG, GIF, WebP; a HEIC is a file) is a 52×52 square: 1px `--line-2` edge, 6px radius, a white ground, the image `object-fit: cover`, centred.
   - **Any other file** is a chip 52 tall and at most 244 wide: padding `0 14px 0 8px`, 1px `--line-2` edge, 8px radius, `--bg` fill.
     - A 34×34 tile, `--sel`, 6px radius, with the type's icon at 16px in `--muted`: `file-text` (docx, doc, pdf, md, txt, rtf, odt), `file-spreadsheet` (csv, xlsx, xls, ods, tsv), `file-code` (log, json, har, yaml, sql, source files), `file-archive` (zip, gz, 7z), `file-video` (mp4, mov, webm), `file` for the rest.
     - Then the name, 13.5px/18px 500 `--text`, cut in the middle so the extension stays (`history-pan…-spec.docx`), and under it Plex Mono 12px/17px `--faint`: the type and the size (`DOCX · 48 KB`, `MB` from 1 MB with one decimal).
   - **Remove,** on every item, always shown (touch has no hover): a 20px circle 7px outside the top-right corner, `--raise`, 1px `--line-2`, `x` 12px at stroke 2 in `--muted`, with a 28px hit area (44px on touch). It's a button named `Remove {name}`.
   - **Uploading:** an image shows at 50%; both get a 2px `--teal` bar on a `--line-2` track, 5px in from the sides and 4px up from the bottom. A file's second line reads `Uploading · 62%` in `--muted`. A file starts uploading the moment it joins the tray.
3. **The note line,** 10px under the tray, 13px, a 14px icon, one at a time, newest wins:
   - **The model can't see images** (`--muted`, `image-off` `--faint`): `{model} can't see images; the agent gets them as files.` It shows while the tray holds an image and the task's model has no image input.
   - **A file wasn't added** (`--red`, `circle-alert`, and an `x` 14px `--faint` at the end that dismisses it). The copy is under "Every state".
4. **The controls row,** 8px under: the **paperclip** first, a 28×28 ghost button pulled 6px left so its glyph lines up with the text (`paperclip` 16px `--muted`; hover `--sel` and `--text`), then the hint as now, then `Interrupt and send` and `Send` as now.

**Send** sends the words and the files. Files with no words are a message too (state 8). While a file is still uploading, Send stays enabled: pressing it turns it into a 13px spinner and `Uploading 1 of 2…`, locks the box, and sends the moment the last file lands; pressing it again, or Escape, goes back to editing (state 2). A file that failed to upload disables Send (state 6). The message appears in the thread at once with its attachments (`message-attachments.md`), the tray empties, and the words go as now.

## Adding files

- **The paperclip** opens the system's file picker, several files at once, any type (open point 3).
- **Paste** (Ctrl+V or ⌘V) in the box adds each image or file on the clipboard. A pasted screenshot has no name, so it's named `Pasted image {HH.MM.SS}.png` (`14.51.08`). Pasted text still pastes as text.
- **Drop** (`composer-drop.webp`): as soon as files are dragged over the window (`dragenter` with `Files` among the types), the chat column turns into the drop zone:
  - **Where:** the chat column, the task page's left column (beside the properties panel, or beside the preview pane), inset 10px. Not the preview pane: its frame is the app's, and it keeps its own drags. Dropping anywhere on the page but the preview attaches.
  - **How it looks:** a 1.5px dashed `--teal` edge, 10px radius, `--bg` at 96% with a 3px backdrop blur. Centred: a 40px tile (1px `--line-2`, 10px radius, `--surface`, `paperclip` 18px `--teal`), 14px under it `Drop to attach` (16px 600), `They go in your reply to OpenCode.` (14px `--muted`; when no question waits, `They go with your next message to {agent}.`), and 10px under, Plex Mono 12.5px `--faint` `Up to 10 files · 10 MB each · 25 MB in all`.
  - It hides on drop, when the drag leaves the window, or on Escape. A drag of text or a link from the page shows no zone.
- **Where the files go:** into the tray, after the ones already there, and each is checked before it uploads (the limits below).
- **Who:** whoever the composer lets send or reopen. A viewer who can't send sees no paperclip and gets no drop zone.

## Limits

10 files, 10 MB each, and 25 MB in all, per message (open point 2). The box checks them as files arrive and the server checks them again. A file over a limit never enters the tray: the note line says why, naming it.

## Every state (`composer-states.webp`)

| # | State | What shows |
|---|---|---|
| 1 | **Dragging over the new-task page** | The box is the drop zone there (`new-task-attachments.md`): its edge turns 1.5px dashed `--teal`, and its inside shows the 32px tile, `Drop to attach` 15px 600 and the limits line |
| 2 | **Uploading, Send pressed** | The pasted image at 50% with its bar at 40%; `Send` reads `Uploading 1 of 2…` with the spinner |
| 3 | **A file over 10 MB** | Red note: `design-review.mov wasn't added: it's 48 MB, and a file can be up to 10 MB.` The rest of what was picked still joins |
| 4 | **The 11th file** | Red note: `3 more weren't added: a message holds up to 10 files.` (`1 more wasn't added…`). The paperclip turns off at 40% with a tooltip `A message holds up to 10 files`, and the hint reads `10 of 10 files` |
| 5 | **Past 25 MB in all** | Red note: `orders-2026-11.csv wasn't added: the message would hold 27.4 MB, over 25 MB.` Once the tray passes 20 MB, the hint reads `hard-drive` and mono `18.9 MB of 25 MB` |
| 6 | **An upload failed** | The chip's edge turns `--red`, its tile becomes 1px `--line-2` with `circle-alert` `--red`, its second line reads `Didn't upload` (12.5px `--red`) and a teal `Retry`. `Send` at 40%, and the hint says `Retry or remove history-panel-spec.docx to send.` with a red `circle-alert` |
| 7 | **The model can't see images** | The muted note: `DeepSeek V4.1 Flash can't see images; the agent gets them as files.` Nothing is refused: the images go into the box as files |
| 8 | **Files and no words** | The placeholder stays, `Send` is enabled. The focus is on a file: a 2px `--teal` outline 2px out on the item, and the box's ring |
| | **An empty file, a folder** | Red note: `{name} wasn't added: it's empty.` / `{name} wasn't added: folders can't be attached.` |
| | **The upload is refused by the server** (the blob store is full, or the member lost the right to send) | As state 6, with the server's reason in the chip's `title` |
| | **The task stopped while uploading** | The composer turns into Reopen as now; the tray and its files stay, and Reopen sends them |
| | **The page reloads** | The tray is lost, like the unsent words today. Uploaded but unsent files are deleted by the server after a day (the data section) |
| | **Light theme** | `../m7/light-task.md`'s tokens (`composer-attachments-light.webp`). Images keep their own colours on a white ground |

## Keyboard and screen readers

- **Tab order:** the text, each tray item, the paperclip, then the buttons. The paperclip is `Attach files`, its tooltip `Attach files · or paste or drop them`.
- **A tray item** is focusable, named `{name}, {type}, {size}` (`uploading, 62 percent` while it uploads, `didn't upload` when it failed). Delete or Backspace removes it and moves the focus to the next item, or back to the text when none is left. Enter on an image opens it in milestone 8's viewer (`../m8/task-attachments.md`), titled `Not sent yet`. The `x` buttons are in the tab order only on touch screens.
- **Retry** is a button on the failed item.
- **The tray** is a `list` named `Attachments, {n}`. A polite live region says `{name} added`, `{name} uploaded`, `{name} didn't upload` and each refusal's line, once.
- **Enter** sends as now; Shift+Enter is a new line. Escape leaves the box as now, and while a drop zone shows it hides it first.

## Narrow and phone width (`composer-phone.webp`)

- **Below 768:** the chat and the preview are one at a time (`../m8/task-preview.md`, "Phone"), and the box docks under the chat: padding `10px 10px 14px`, a 1px `--line` above.
  - **The tray** is above the field row, one row that scrolls sideways (no wrap), items 56px tall, 2px in so the first `x` isn't cut. The last item is cut by the screen's edge, which shows it scrolls.
  - **The note line** sits under the tray, 13px.
  - **The row:** a 44×44 paperclip button (1px `--line-2`, 10px radius, `--surface`, `paperclip` 19px `--muted`), the field (1px `--control-line`, 10px radius, `--surface`, 15px/21px, from 44px tall up to 4 lines, then it scrolls), and the 44×44 `--primary` send button.
  - **The paperclip** opens the system's picker, which on iOS and Android offers the photo library, the camera and files on its own. No `accept` filter, no `capture`.
  - **Each `x`** keeps its 20px look with a 44px hit area.
- **There's no drag** on a phone; paste works.
- **Between 768 and 1180,** the tray wraps as on a desktop. The chat column with the preview open is 500 wide: two images and two files fill a row, and the third file wraps.

## Components (shadcn/ui names)

- **From the repo:** `Button`, `Tooltip`, milestone 8's `attachment-viewer.tsx` (for Enter on a tray image), and the draft's upload path (`components/tasks/draft/draft-images.tsx`), whose 10 MiB cap and size words (`draft.sizeKb`, `draft.sizeMb`) this follows.
- **New:**
  - `components/tasks/composer/attach-button.tsx`, with the hidden `<input type="file" multiple>`;
  - `composer-tray.tsx` and `tray-item.tsx`, the item's kind a union (`"image" | "file"`) and its state another (`"uploading" | "ready" | "failed"`), each `switch` exhaustive;
  - `drop-zone.tsx`, one per page, which the task page and the new-task page both use;
  - `use-attachments.ts`: the tray's state, the limits, paste and drop, and the uploads.
- **Icons** (Lucide, stroke 1.75): `paperclip`, `x`, `image-off`, `circle-alert`, `hard-drive`, `file-text`, `file-spreadsheet`, `file-code`, `file-archive`, `file-video`, `file`.

## Tokens

`--surface` is the box and `--bg` the file chips inside it. `--line-2` edges the items, `--sel` fills the type tile. `--teal` is the upload bar, the drop zone's edge and icon, `Retry` and the focus. `--red` is a refusal, a failed upload and its edge. `--muted` and `--faint` are the note, the meta and the hint. No amber: the needs-you block above the box keeps the only amber on the page.

## WCAG AA (F-081)

| Pair | Dark | Light | Need |
|---|---|---|---|
| `--red` on `--surface` (a refusal, `Didn't upload`) | 5.6:1 | 5.3:1 | 4.5 |
| `--muted` on `--surface` (the model's note) | 9.2:1 | 7.6:1 | 4.5 |
| `--faint` on `--surface` (the hint) and on `--bg` (a chip's meta) | 5.6:1, 5.9:1 | 5.3:1, 5.6:1 | 4.5 |
| `--teal` on `--surface` (`Retry`) | 8.0:1 | 5.7:1 | 4.5 |
| `--teal` on `--bg` (the drop zone's edge) | 8.4:1 | 6.1:1 | 3 (a graphic) |
| `--muted` on `--sel` (the type icon) | 8.6:1 | 7.0:1 | 3 (a graphic) |
| `--control-line` on `--surface` (the box's edge) | 3.4:1 | 3.4:1 | 3 |

## Data it needs (for the milestone 9 spec)

These are what the screen needs, not decisions; the spec settles them.
1. **An upload** that streams one file into the blob store (F-114, ADR 0043) for a task (or a draft new task), checks the limits again, and returns an attachment ID, its kind and size. Unsent uploads are deleted after a day.
2. **`tasks.send`, `tasks.reopen` and `tasks.create`** take attachment IDs beside the words.
3. **The model's image input,** from the models.dev catalog ostra already fetches (ADR 0033), to verify there (its `modalities.input`), and whether the agent takes images at all (ACP's `promptCapabilities.image`, to verify for OpenCode). The note shows when either is missing.
4. **The box:** the runner writes the files under `.ostra/attachments/{n}/` (`n` the message's number in the task) before the turn, as it writes a ticket's files under `.ostra/ticket/` today, and the agent's prompt names their paths. Images go as image input too where both the agent and the model take it.

## Differences from the current code

1. **The composer** (`task-thread.tsx`, `Composer`) has no paperclip, tray, paste or drop, and sends text only.
2. **`tasks.send` and `tasks.reopen`** take text only.
3. **The draft's images** (`draft-images.tsx`) upload images only, one list per draft; the tray reuses their upload and size words, not their layout.
4. **Messages:** new keys under `task.composer.attach.*`.

## Open points (recommendations; the maintainer's approval settles them)

1. **The tray under the text,** next to the paperclip, as drawn. ChatGPT and Claude put files above the text instead; under keeps them by the button that added them, and the new-task box's tall text doesn't push them away. Recommended.
2. **Limits:** 10 files, 10 MB each, 25 MB in all, per message, fixed in v1 with no setting. The blob store takes 64 MiB a blob (F-114), and the draft's images take 10 MiB. Recommended.
3. **Any file type.** A file is bytes in the box, and the agent can open a zip itself. Recommended, rather than a list of types.
4. **Send while uploading waits** and sends when the last file lands, as drawn, rather than staying disabled. Recommended.
5. **A refused file never enters the tray:** the red note names it, as drawn. The alternative, a red chip that Send drops, leaves the member wondering whether it went.
6. **The drop zone is the chat column,** not the preview pane, as drawn.

## Wrong in the image (build from this file)

- **The tray's images** are the demo app shrunk into the square. The build shows the real image, `object-fit: cover`, centred.
- **The drag image and the pointer** in `composer-drop.webp` are the system's: the build draws neither.
- **`composer-states.webp` is a board,** not a page: each box sits in its page as `composer-attachments.webp` shows. State 4's tooltip is drawn under the box to keep the board clear; the build's `Tooltip` opens above the paperclip.
- **State 4's ten images** repeat the demo pictures.
- **`composer-phone.webp`'s first screen** shows the dock's last chip cut at the screen's edge on purpose; the build's row scrolls.
