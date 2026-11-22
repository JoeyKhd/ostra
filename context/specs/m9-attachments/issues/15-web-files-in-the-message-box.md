# 15: Web: files in the message box and the new-task box

Status: done
Builder: web
Blocked by: 14; the targets in `context/brand/app-targets/m9/` approved by the maintainer (being made now by a design agent, in the `m9-targets` worktree)
Features: F-148, F-150
Packages: `apps/web` (`src/task/task-thread.tsx`'s `Composer`, `src/components/projects/project-composer.tsx`, `src/components/tasks/new-task-view.tsx`, new `src/components/tasks/composer/`), `apps/web/messages/`
Spec: `../spec.md`, sections 1, 4 and 13; ADR 0070
Targets: `context/brand/app-targets/m9/composer-attachments.md` (with `composer-drop`, `composer-states` and `composer-phone`) and `new-task-attachments.md`

## What to build

Built to the approved targets, at their sizes, in both themes and at the phone width (`context/brand/app-design.md`). Their build specs hold the layout, every state's words and the components; this ticket holds what the targets can't.

- **The tray, the paperclip, paste and the drop zone,** in the task page's composer (a message, a reply, interrupt and send, and Reopen), the project page's composer and the new-task page's box. One `use-attachments` hook holds the tray's state, the limits from `files.limits`, paste, drop and the uploads to `POST /api/projects/<projectId>/files` (one at a time per file, several in flight), and the kind and state of each item as unions with exhaustive `switch`es. assistant-ui's `ComposerPrimitive.AddAttachment` and `ComposerPrimitive.Attachments` may carry it if they fit the target; the upload is ostra's either way.
- **Preview before sending** draws an image from the browser's own `blob:` URL (allowed by `img-src`), never from the server.
- **The limits' notes** as the target words them, with the numbers from `files.limits`, not fixed in the code.
- **Removing** an uploaded file calls `files.discard`.
- **Sending** passes the files' IDs to `tasks.create`, `tasks.send` or `tasks.reopen`; files with no words send. Send while an upload runs waits and sends when the last lands, as the target draws.
- **The model's note** ("{model} can't see images; the agent gets them as files.") from `tasks.get`'s or the new-task page's `model.imageInput`, also for `unknown` with its own words; **the runner's note** for `runner-needs-upgrade`.
- **"text extracted"** on a document's chip once its upload answers `ready`.
- **Who:** only a member the composer lets send or reopen gets the paperclip and the drop zone.
- **Messages:** every word in `apps/web/messages/` under `task.composer.attach.*` and `newTask.attach.*`.
- **The keyboard and screen readers** as the target says; milestone 7's keyboard walk and contrast check stay green on the task page and the new-task page.

## Done when

- [x] The targets are approved, recorded under `## Comments` with the date and the maintainer's words.
- [x] Tests named for `F-148/c1`: component tests of paste, drop and the paperclip adding items, removing one, and a send with files and no words; a Playwright spec (`apps/web/e2e/`, run once at the milestone's end) that attaches a PNG and a `.docx` by each way and sends.
- [x] Tests named for `F-148/c2`: each limit's note, with the server's numbers.
- [x] Tests named for `F-148/c5`: the model's note for `no` and `unknown`, and none for `yes`.
- [x] Tests named for `F-148/c9`: the runner's note.
- [x] Tests named for `F-150/c1`: "text extracted" on a `.docx`'s chip.
- [x] Screenshots of the built boxes at 1440 px and 390 px, both themes, compared with the targets, under `## Comments`.
- [x] Checks for `apps/web` pass (spec section 10).
- [x] Committed as `✨ attach files in every message box`.

## Comments
- 2026-11-21, lead: the maintainer approved the m9 targets ("yes to all"), recorded in `context/brand/app-targets/m9/README.md`. This ticket waits only for ticket 14 now.
- 2026-11-22, web (phase A, `9af3caa7`): the components, presentational, built to the targets and compared in a scratch harness (`_lead/ui-check/m9/phase-a.md`, "Phase A").
- 2026-11-22, web (phase B): wired to ticket 14's API. The task composer, the project composer and the new-task page take files by the paperclip, paste and a drop (the chat column on the task page, the box on the new-task page; never the preview pane, `data-drop-excluded`), upload them one request a file through `XMLHttpRequest` with progress (`composer/upload-file.ts`), check the server's `files.limits` as they arrive (the domain's own `checkMessageFiles`, `@ostra/domain/file-limits`), discard a removed upload (`files.discard`), and send `fileIds` with create, send and reopen; Send waits for uploads in flight. A message's words may be empty with files; a new task's may not (the maintainer's choice 4.2). The model's note comes from `tasks.get`'s `messageFiles` and `tasks.runnerChoices` (`no`, `unknown` with its own words, and the agent's when it takes no images); the runner's note from `messageFiles.oldRunner`, which holds Send while the tray has files. The new task's words take 80px while the tray holds files, so the tray fits the 250px box; `What happens next` gains its files' row (a `--faint` line on a phone), the panel its `Attachments` group and `Takes`.
- 2026-11-22, web: the tests. `F-148/c1`, `c2`, `c5`, `c9` and `F-150/c1` are `apps/web/e2e/26-attachments.spec.ts` through the real panel and core (paperclip, paste and drop of a PNG and a `.docx`, remove, a send with files and no words; the new-task box starting a task with files and refusing files alone; each limit's note with the server's numbers; the model's note for `yes`, `no` and `unknown`, an admin's "Reads images" changing it; the old runner's note; `text extracted` on the `.docx`'s chip once core read it). The pure parts have unit tests under `src/components/tasks/composer/` with plain names. The keyboard walk and the contrast check of the box with files pass in both themes (`F-081/c2` in the same spec).
- 2026-11-22, web: the screenshots at 1440 and 390 px, both themes, beside the targets: `_lead/ui-check/m9/composer-*.png` and `new-task-attachments*.png`, raw shots in `_lead/ui-check/m9/live/`; every remaining difference with its reason in `_lead/ui-check/m9/phase-a.md`, "Phase B". Phase B went as one commit for tickets 15 and 16, `✨ attach files and show what the agent got`: the task's thread (`apps/web/src/task/task-thread.tsx`) holds both the box and the files it draws.
