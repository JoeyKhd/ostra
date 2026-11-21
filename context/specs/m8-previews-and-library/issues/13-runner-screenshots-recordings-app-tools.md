# 13: Runner: screenshots, recordings and the app tools

Status: ready-for-agent
Builder: runner
Blocked by: 11, 12
Features: F-121, F-140
Packages: `apps/runner` (`sidecar/mcp-tools.ts`, `task-host/`, `browser/`)
Spec: `../spec.md`, sections 4 ("A screenshot", "After a turn") and 5.1; ADR 0068 ("Screenshots and recordings")

## What to build

- **The four tools** on ostra's MCP server in the sidecar, for a task whose spec has `"app"`, with the schemas and result texts of ticket 01:
  - `start_app`: ticket 12's start, which returns each process's state, address and log path.
  - `show_preview`: ticket 12's announce.
  - `take_screenshot`: a page of its own in the box's browser at the size asked; `http://localhost:<port><path>` (or a service's address); a wait for the network to go quiet, at most 15 s; a PNG within the limits, full page when asked and capped at 10,000 px; uploaded on the bulk path with the purpose `app-screenshot`; then `attachment.added` with the source `agent`. The result names the attachment's number in the task.
  - `record_app`: its steps in a page of its own, each step with a deadline, under a screencast at 10 frames a second; the frames, their times and the steps in one frame-reel blob (`app-recording`) within the limits; then `attachment.added`. A step that fails ends the recording there, keeps what it has, and says which step failed.
- **The frame reel** is written in ticket 01's format (`packages/protocol`, `src/task/frame-reel.ts`), which the panel's player reads (ticket 17).
- **After a turn.** After the commit, the push and the hidden ref (ADR 0039), if the turn changed a repo, the environment has a primary and `screenshots.afterTurn` is on: start what isn't running, wait for the primary, and take each route at each width, with the source `after-turn`. A primary that doesn't get ready sends `app.process failed` and takes nothing. The turn's end is never held past the ready check's 120 s.
- **A member's screenshot.** `screenshot.take` from the pane takes one of the preview's current path, with the source `member` and the member's ID.
- **Limits.** 20 attachments a turn; past that, the tool's result says so, and the after-turn screenshots are skipped with a note in the thread.
- **What's recorded.** Each attachment's event names the browser's name and version. The caption and the steps go in the event and the blob, never in a log line.

## Done when

- [ ] Tests named for `F-121`, on `host` live with the fixture app and against the fake browser:
  - each tool's success and its refusals;
  - a screenshot's blob and event;
  - a recording as a frame reel within its limits, and one cut short by a failing step;
  - the after-turn screenshots for each route and width, and none when the turn changed nothing or the environment has no primary;
  - a member's screenshot;
  - the 21st attachment refused (break-it: lift the limit, and the case fails);
  - the browser named on each.
- [ ] A test feeds a caption and steps holding shell syntax and prompt-like text, and finds none in a log line.
- [ ] The whole-repo checks pass (spec section 10).
- [ ] Committed as `✨ add screenshots, recordings and the app tools`.

## Comments
