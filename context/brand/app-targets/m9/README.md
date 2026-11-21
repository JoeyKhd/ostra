# Milestone 9 screen targets

The design targets for milestone 9's attachments: files in the message box, in the thread, and in a ticket's context. The milestone 9 spec, written beside them, names them and gives their features IDs.

**Status: approved 2026-11-21** (the maintainer: "yes to all"). Every open point is settled as its build spec recommends; see "Approval" below. Build from these targets.

**Why these screens:** the maintainer, 2026-11-21:
- "add image support and file support to our chat text box thing, LOL no attachements?!?!?!?!"
- When a task starts from a Linear ticket (Jira later), "the full ticket should be used as context… screenshots, docx anything should be added as context."
- "during chatting we should be able to upload attachments."

## How they're made

The same way as milestone 8's (`../m8/README.md`, "How they're made"): real HTML, not image-model pictures (`../../app-design.md`, rule 5).
- **Milestone 8's parts, loaded, not copied:** each page in `html/` loads `../../m8/html/m8.css` (the panel's tokens for both themes, its fonts and its scale), `../../m8/html/shell.js` (the approved double-sidebar shell) and `../../m8/html/app-fixture.js` ("Tally", the demo app in its own colours). Icons are Lucide 0.460.
- **This milestone's parts:** `html/m9.css` (the tray, the file chip, the drop zone, the ticket's first message) and `html/m9.js` (the demo pictures inside the attachments, and the parts as HTML).
- **Built on the live task page,** not an older target. The panel running on 2026-11-21 was rendered first, signed in as the demo member, to check what the task page is now: the needs-you block at the end of the thread (`18d0e104`), the preview pane, the screenshots in the thread (`../m8/task-attachments.md`), the composer's border and hint, and the new-task box and its toolbar.
- **The render:** Playwright renders each page at 1440×956 and 2×, to `<name>.png` (2880×1912). `html/to-webp.py` then writes `<name>.webp` at 1440×956, one image pixel per CSS pixel:

  ```
  node html/render.mjs <path to playwright/index.mjs> [name ...]
  python -I html/to-webp.py [name ...]
  ```

  The renders used `playwright@1.65.1` from the repo's `node_modules`.
- **No Higgsfield credits were used.**
- **All data is demo data:** Acme Corp, its projects and people (Sam Rivera, Priya Shah, Marcus Lee, Dana), the files, their sizes and words, `CALC-170` and `CALC-192`. The model names are from milestone 8's targets and the live panel.

## Screens

| Screen | Targets | Build spec |
|---|---|---|
| 1. The message box with attachments on the task page: words, two images, two files, one uploading; the paperclip; dark and light | `composer-attachments`, `composer-attachments-light` | `composer-attachments.md` |
| 1. Files dragged over the page, the preview pane open: the chat column is the drop zone | `composer-drop` | `composer-attachments.md` |
| 1. Every state of the box: the new-task box as a drop zone, Send waiting for an upload, a file over 10 MB, the 10-file limit, the 25 MB limit, a failed upload, a model that can't see images, files with no words | `composer-states` | `composer-attachments.md` |
| 1, 2, 4. At phone width: the box docked under the chat, the sent message, a new task with files | `composer-phone` | `composer-attachments.md` |
| 2. A member's message with images and files in the thread, `text extracted` on two, dark and light | `message-attachments`, `message-attachments-light` | `message-attachments.md` |
| 2. A member's image in milestone 8's viewer | `message-attachments-viewer` | `message-attachments.md` |
| 3. A task from Linear: the thread's first message is what the agent got (the description, the attachments, the comments), dark and light | `ticket-context`, `ticket-context-light` | `ticket-context.md` |
| 3. The same with 3 of 23 attachments left out, too big or too many | `ticket-context-skipped` | `ticket-context.md` |
| 3. The same with 2 attachments that didn't load, and Retry | `ticket-context-failed` | `ticket-context.md` |
| 4. The new-task page with files attached, dark and light | `new-task-attachments`, `new-task-attachments-light` | `new-task-attachments.md` |

## Files

- **Build specs:** `composer-attachments.md`, `message-attachments.md`, `ticket-context.md`, `new-task-attachments.md`.
- **Pictures** (each a 2880×1912 `.png` and a 1440×956 `.webp`): `composer-attachments`, `composer-attachments-light`, `composer-drop`, `composer-states`, `composer-phone`, `message-attachments`, `message-attachments-light`, `message-attachments-viewer`, `ticket-context`, `ticket-context-light`, `ticket-context-skipped`, `ticket-context-failed`, `new-task-attachments`, `new-task-attachments-light`.
- **Sources** in `html/`: `task-composer.html`, `composer-states.html`, `composer-phone.html`, `message-attachments.html`, `ticket-context.html`, `new-task-attachments.html`, `m9.css`, `m9.js`, `render.mjs`, `to-webp.py`.

## Rules

The earlier milestones' rules hold (`../m1/README.md` to `../m8/README.md`):
- **The build spec wins** on copy, states, components and behaviour. Each `.md` ends with "Wrong in the image": build from the file, not the picture, where the two differ.
- **The picture wins** on size, spacing and contrast. Here a picture is HTML, so its sizes are exact CSS px, and its `.md` lists them.
- **Real data only** in the build, with the brand's fonts and logo.
- **Check each screen by eye** against its picture, at 1440×956, after the build.

These are new for milestone 9:
- **One look for a file everywhere:** the same 52px item in the box and the same chip in the thread, for a member's file and a ticket's; images in milestone 8's strip and viewer.
- **Amber stays only for "needs you".** A refused file and a failed upload are `--red`; a model that can't see images is `--muted`, since it's no error.
- **Nothing is lost silently:** a file the box won't take says why at once, and a ticket's file the agent didn't get is listed with the reason.

## The open points, in one place

The build specs give each its reasons and the alternative.

| Spec | Open point | Recommended |
|---|---|---|
| `composer-attachments.md` | 1. Where the tray sits | Under the words, next to the paperclip |
| | 2. Limits | 10 files, 10 MB each, 25 MB in all per message; no setting in v1 |
| | 3. Which types | Any file |
| | 4. Send while uploading | Waits and sends when the last file lands |
| | 5. A refused file | A red note naming it, never a chip |
| | 6. The drop zone | The chat column, not the preview pane |
| `message-attachments.md` | 1. The properties panel | One `Attachments` group for captures, members' and the ticket's files |
| | 2. Captions under a member's images | None |
| | 3. Showing a document's extracted text | Not in v1; the mark says it exists |
| `ticket-context.md` | 1. Where the ticket shows | As the thread's first message, `What the agent got`, not a row in the header |
| | 2. A ticket's limits | 20 attachments, 10 MB each, 50 MB in all |
| | 3. A failed fetch | The task starts anyway; `Retry`, and the files reach the agent with its next turn |
| | 4. Links (Figma, Sentry) | Listed with their titles and URLs, not fetched |
| | 5. Videos | Files like any other, within 10 MB |
| `new-task-attachments.md` | 1. `Takes` in the profile group | Always shown |
| | 2. A task from files alone | No: words are still needed |

Two questions for the spec more than for the pictures: where a document's text is read and with what library (a new dependency the maintainer approves), and whether OpenCode takes images through ACP (`promptCapabilities.image`), to verify.

## Approval

**Approved 2026-11-21.** The maintainer, shown every picture and every open point with its recommendation, answered "yes to all". Settled:

- **The message box:** the tray sits under the words; any file type; Send while a file uploads waits and sends when the last one lands; a refused file gets a red note and never enters the tray; the drop zone is the chat column only (not the preview pane).
- **Limits:** 10 files a message, 10 MB each, 25 MB in all; a ticket's 20 files, 10 MB each, 50 MB in all. The spec makes these settings with those defaults (ADR 0070), which the box reads from the server; the pictures' fixed numbers are those defaults.
- **The thread:** one Attachments group in the properties panel for captures, a member's files and the ticket's; no captions under a member's images; a document's extracted text isn't shown in v1 (the agent reads it).
- **A ticket's context:** the ticket shows as the thread's first message, "What the agent got"; a failed fetch doesn't stop the task (Retry, and the files reach the agent with its next turn); links are listed, not fetched; videos are files like any other.
- **The new-task box:** what the model takes ("Takes: text only") always shows; a task still needs a few words, never files alone.
- **Where files go in the box:** the spec's paths win over any path text in the pictures: `<workspace root>/.ostra/attachments/<n>/` and `.ostra/ticket/` (ADR 0070, Q333).
