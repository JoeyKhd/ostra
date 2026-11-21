# Target: the new-task page with files attached (waits for the maintainer's approval)

> **Committed images:** `new-task-attachments.png` and `new-task-attachments-light.png` (2880×1912, the render at 2×), each with its `.webp` (1440×956, one image pixel per CSS pixel). Rendered with Playwright from `html/new-task-attachments.html` (`?theme=light`). The phone version is the third screen of `composer-phone.webp`, and the box as a drop zone is state 1 of `composer-states.webp` (both in `composer-attachments.md`). Sizes in this file are CSS px.

| Picture | State shown |
|---|---|
| `new-task-attachments.webp` | A new task in `calculator`: the words, then two screenshots, `rounding-rules.docx` and `percent-cases.csv` in the tray, and the note that the chosen profile's model, DeepSeek V4.1 Flash, can't see images. The paperclip starts the toolbar. `What happens next` gains a row for the files, and the properties panel an `Attachments` group and a `Takes` row. |
| `new-task-attachments-light.webp` | The same, in the light theme. |

- **Route:** unchanged, `/tasks/new` (`components/tasks/new-task-view.tsx`).
- **Shell:** the double sidebar (`../m8/app-shell.md`); the page as it is on 2026-11-21: the box, its toolbar (`Code` and `Refine`, the project, the profile, the runner), `What happens next`, the properties panel at 380.
- **Features:** the milestone 9 spec's attachment features; F-114.
- **Status: waits for the maintainer's approval.**

> Build it in real HTML/React (`../../app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with each picture.

## Purpose

A task often starts from something to look at: a screenshot of the bug, a spec, a sample of the data. The new-task box takes them the way the task's composer does (`composer-attachments.md`), so the agent's first turn has them, and it says before the start what the chosen profile's model can do with them.

## The box (`new-task-attachments.webp`)

The new-task box is unchanged where this file doesn't say otherwise: 24px under the lede, at least 250 tall, 1px `--control-line`, 10px radius, `--surface`, padding `14px 16px 10px`, the words at 15.5px/1.6, the focus ring on the box.

Top to bottom:
1. **The words,** as now; the box grows with them (`field-sizing: content`, at most half the window).
2. **The tray,** 12px under the words, as `composer-attachments.md` draws it: 52px images, 52-tall file chips on `--bg`, 8px gaps, wrapping, each with its `x`, its upload bar and its states.
3. **The note line,** 10px under the tray, as the composer's: here most often `{model} can't see images; the agent gets them as files.`, since the profile is picked in this box.
4. **The toolbar,** 10px under: the **paperclip** first (the composer's 28px ghost button), 4px, then the toolbar as now: `Code`/`Refine`, the project, the profile, the runner; at its end `Ctrl ↵` and `Start task`.

**Start task** creates the task with the words and the files. As in the composer, it waits for uploads in flight (`Uploading 1 of 2…` on the button), and a failed upload disables it until it's retried or removed. Files with no words don't start a task: the button stays off until there are words, as now.

**Changing the profile** updates the note at once: picking a profile whose model takes images removes it.

**A refine task** takes files the same way (milestone 6's drafts take images already); its agent reads them and can't push.

## Dropping files

Dragging files over the page makes **the box** the drop zone (`composer-states.webp`, state 1): its edge turns 1.5px dashed `--teal`, and its inside shows a 32px tile (`paperclip` 16px `--teal`), `Drop to attach` (15px 600) and Plex Mono 12.5px `--faint` `Up to 10 files · 10 MB each · 25 MB in all`. A drop anywhere on the page attaches. The words come back when the drag ends.

## What happens next

One row joins the list, second, while the tray holds files: `paperclip` 15px `--muted`, `The {n} files go into the box under` + mono `.ostra/attachments/1/`, and, when the tray holds documents, `, and the text of the docx beside it` (or `of the documents`). One file: `The file goes into the box under …`.

## The properties panel

- **`Attachments`,** a new group between `This task` and `Agent profile`, while the tray holds files: `Files` (`2 images · 2 files`), `Size` (mono `2.3 MB` + `--muted` ` of 25 MB`).
- **`Takes`,** a new row at the end of `Agent profile`, always: `text and images`, or `text only` when the model has no image input. It tells the member before they attach anything.

## Every state

The tray's states are the composer's (`composer-attachments.md`, "Every state"). Here also:

| State | What shows |
|---|---|
| **Empty** | The page as now, with the paperclip at the toolbar's start, and `Takes` in the panel |
| **Files and no words** | `Start task` stays off, as with no words now |
| **The project changes** | The tray stays; the files belong to the draft, not the project |
| **The page is left with files in the tray** | They're lost with the words, as the words are today; the server deletes unsent uploads after a day |
| **Starting** | `Start task` shows its spinner as now; the task page opens with the first message carrying the files (`message-attachments.md`) |
| **Light theme** (`new-task-attachments-light.webp`) | `../m7/light-task.md`'s tokens |

## Keyboard

- **Tab order:** the words, the tray's items, the paperclip, then the toolbar as now. Delete on an item removes it, as in the composer.
- **Ctrl+Enter** (⌘Enter) starts the task as now, waiting for uploads.
- **Paste** an image into the words to attach it.

## Narrow and phone width (`composer-phone.webp`, screen 3)

- **The tray** scrolls sideways in one row, items 56px tall.
- **The toolbar** wraps as it does today, with the paperclip (36px) first on its first row; `Start task` (40px) sits alone at the end.
- **The `What happens next` row** follows under the box as a `--faint` line with `info`, as the host help does today.

## Components (shadcn/ui names)

From `composer-attachments.md`: `attach-button.tsx`, `composer-tray.tsx`, `drop-zone.tsx`, `use-attachments.ts`. The new-task page passes the draft's ID where the task page passes the task's.

## Tokens and WCAG AA

As `composer-attachments.md`. The `Takes` row is `--text` on `--bg`.

## Data it needs (for the milestone 9 spec)

1. **Uploads before the task exists:** a draft upload the server keeps for a day, then `tasks.create` takes the attachment IDs with the words and moves them to the task.
2. **The profile's model's image input,** for the note and `Takes` (`composer-attachments.md`, data item 3).

## Differences from the current code

1. **The box** (`new-task-view.tsx`) has no paperclip, tray, paste or drop, and `tasks.create` takes words only.
2. **`What happens next`** has no row for files.
3. **The properties panel** has no `Attachments` group and no `Takes` row.

## Open points (recommendations; the maintainer's approval settles them)

1. **`Takes`, always in the panel,** as drawn: the member sees what the model can read before choosing a profile. Recommended.
2. **No task from files alone:** words are still required to start one, as drawn. A screenshot with no words gives the agent nothing to do. Recommended.

## Wrong in the image (build from this file)

- **The tray's images** are the demo app shrunk. The build shows the real images, `object-fit: cover`, centred.
- **The repo, the runner and the profile** are demo data (`acme/calculator-web`, `build-fleet`, `Fast fixes`); `What happens next` keeps today's words (`newTask.next*`) and adds only the files' row.
