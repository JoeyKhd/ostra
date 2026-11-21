# 17: Web: app processes and attachments in the thread

Status: done
Builder: web
Blocked by: 09, 16
Features: F-121, F-140
Packages: `apps/web`, `packages/task-view`
Spec: `../spec.md`, section 13 (targets 4 and 5, and the screens that only grow)

## What to build

To the approved targets `task-attachments` and `environment-app-processes`, and the grown `environment-proposal`, `refine-draft` and `review-screen`:
- **The environment page's app processes:**
  - the list and its editor sheet, with the ready check, primary and `hostRewrite`;
  - "Screenshots after each turn" with its routes and widths;
  - a service's "has a web UI";
  - detected and proposed processes;
  - the warning when the box has no browser (`app.browser`).
- **The thread** (`packages/task-view`):
  - each attachment at its place in its turn, with its caption and its browser's line;
  - the lightbox;
  - the recording's player, which reads the frame reel and shows its steps beside it;
  - "Add to draft" on a refine task;
  - `app.process` states as quiet lines, and a failed one with its log's tail behind "Show log".
- **The grown screens:** the proposal's diff with the processes and the onboarding task's screenshot; a draft's attachment among its images; a finding's attachments on the review screen.
- **Words** through `t`. The images are drawn from the blob service's download, which the CSP's `img-src 'self' blob: data:` already allows.

## Done when

- [x] The targets' approval is recorded in ticket 09's `## Comments` before the UI is built.
- [x] Tests named for `F-121` (the browser suite's own spec file only):
  - a screenshot and a recording shown in the thread, and still shown after the box stopped and after a reload;
  - the player plays and pauses;
  - "Add to draft".
- [x] Tests named for `F-140`: the editor's rules shown as the API refuses them, and a proposal's processes accepted.
- [x] Milestone 7's keyboard walk and contrast check pass on the new parts, in both themes.
- [x] Checks for `apps/web` and `packages/task-view` pass (spec section 10).
- [x] Committed as `✨ show app processes and attachments`.

## Comments

- 2026-11-21, web: committed as `✨ add the app log route and accepting a kept process`, then `✨ show app processes and attachments`, on tickets 09 (both batches approved), 13, 15 and 16. Where things went and what was decided:
  - **The fold** (`packages/task-view`): `attachment.added` is a `data-attachments` run at its place in its turn (screenshots one after another by the same hand join one run, a recording is a run of its own, the after-turn screenshots land at the turn's end, a member's from the pane is a row of its own), and the agent's `take_screenshot`/`record_app` call is folded into it, so it isn't drawn twice; `attachment.skipped` is a line with the protocol's `attachmentSkippedWords`; `app.browser` without a browser is one line per task; `app.process` is one quiet line per start, updated in place (starting, ready with its time, exited with its code and its log's tail), and a process stopped with its box once it was ready keeps its ready line. The thread shows a picture only once `tasks.attachments` lists it, so an event core refused draws nothing.
  - **The thread** (`components/tasks/attachments/`): the strip at 110px in each capture's aspect, its captions, the browser's line, "where they are" under the turn's last run, the viewer (`?attachment={id}`; the turn's set, ← → Home End, 100% on click, "Compare with" as a before/after `slider`, Download, Copy link, the facts, the browser named), the recording's player (the reel downloaded once and decoded with the protocol's `decodeFrameReel`, its JPEG frames as `blob:` URLs, play/pause, the scrubber with step ticks, 1×/1.5×/2×, full screen, Space/J/L, the steps as buttons that seek), "Add to draft" on a refine task's latest draft (in the viewer), the properties group, the PR link's `#attachments` landing on the first picture's row, and the old runner's line under the task's header (`tasks.attachments.app`). A finding's attachments show on the review screen, and a draft image made from a screenshot shows as itself among the draft's images.
  - **The App tab** (`?tab=app`, `components/projects/environment-app.tsx` and its row, sheet, screenshot and address files): the processes in their start order with their last box, the kept and found bands, the editor sheet in its four modes (`?tab=app&process={name}` opens one), "Services with a web UI", the panel's screenshots, in-box addresses and the box's browser, the no-browser and older-runner lines. The sheet checks a process with the API's own `appProcessSchema` and `appProcessListIssues` (a new `@ostra/domain/app-processes` export): a field that doesn't read in the target's words, a rule the list breaks in the API's own words, shown on blur or on save. A kept proposal no longer says "The onboarding task proposed…" in the page's banner. The proposal's diff gains its processes, who kept it, what "Accept" waits for and onboarding's screenshot.
  - **The API added:** `GET /api/tasks/<taskId>/app-logs/<blobId>` (`serveTaskAppLog`: an `app-log` blob of the task, `text/plain`, `nosniff`, the sandbox CSP, the same 404s, read through core); `appProcesses.list` gains each last box's `logBlobId` and `olderRunner` (the newest box's runner below minor 7), and its last box skips a `stopped` state, which says nothing of how a process did; `appProcesses.acceptKept` (a project admin's Accept of a kept process as the sheet leaves it, through `decideEnvironmentProposal`, so its rules, scan and audit hold); `drafts.get`'s draft gains its `draftId` and `tasks.attachments` each `draftImageId`.
  - **Tests:** `packages/task-view/src/attachments.test.ts` (`F-121/c4` twice, `F-121/c8`, `F-121/c5`, `F-121/c9`, `F-121/c2`, `F-140/c5` three times); `apps/web/src/components/projects/environment-app-words.test.ts` (`F-140/c2` twice, `F-140/c1,c2`, `F-140/c2`, `F-140/c5`, `F-140/c6`: each refusal the sheet shows is one the API's own checks give); `attachment-words.test.ts` (`F-121/c4`); `packages/api/src/routers/environment-app.test.ts` (`F-140/c9`, Accept of a kept process) and the every-write matrix's new row; the browser spec `apps/web/e2e/24-app-and-attachments.spec.ts` on its own seeded world (`seed-app-world.ts`, real PNGs and a real frame reel the spec takes in the browser, read back through core): `F-121/c4,c5,c7` (the pictures after the box stopped and after a reload, the viewer, the player plays and pauses, "Add to draft"), `F-140/c1,c2,c3,c9` (the editor's refusals in the API's words, a kept process accepted with its command), and `F-081/c2` (the keyboard walk and the contrast check on the App tab, its sheet, the thread's pictures and the viewer, in both themes). Run alone, as the lead's rules say; no break-it pass, under the maintainer's 2026-11-21 change.
  - **Differences from the targets:** a picture's preview reads `web`, not `web :5173` (the attachment carries the process's name, not its port); the panel has no "Proxy" row (detection's proxy reading isn't in the API); "Ignore" on a found process hides it in this browser only (no API keeps it); thumbnails' and the `Route` chip's edges are `--control-line`, not `--line-2`, for the contrast check's 3:1 in the light theme; "Add to draft" is an action of the viewer rather than of a thumbnail's menu.

