# 15: Web: files in the message box and the new-task box

Status: ready-for-agent
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

- [ ] The targets are approved, recorded under `## Comments` with the date and the maintainer's words.
- [ ] Tests named for `F-148/c1`: component tests of paste, drop and the paperclip adding items, removing one, and a send with files and no words; a Playwright spec (`apps/web/e2e/`, run once at the milestone's end) that attaches a PNG and a `.docx` by each way and sends.
- [ ] Tests named for `F-148/c2`: each limit's note, with the server's numbers.
- [ ] Tests named for `F-148/c5`: the model's note for `no` and `unknown`, and none for `yes`.
- [ ] Tests named for `F-148/c9`: the runner's note.
- [ ] Tests named for `F-150/c1`: "text extracted" on a `.docx`'s chip.
- [ ] Screenshots of the built boxes at 1440 px and 390 px, both themes, compared with the targets, under `## Comments`.
- [ ] Checks for `apps/web` pass (spec section 10).
- [ ] Committed as `✨ attach files in every message box`.

## Comments
