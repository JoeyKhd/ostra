# 21: Web: the preview pane, sharing and the viewer page

Status: ready-for-agent
Builder: web
Blocked by: 09, 20
Features: F-141, F-142
Packages: `apps/web`, `packages/task-view`
Spec: `../spec.md`, section 13 (targets 1, 2, 3, 6 and 7)

## What to build

To the approved targets `task-preview-pane`, `task-preview-expanded`, `task-preview-stopped`, `preview-share` and `preview-viewer`:
- **The pane** beside the thread:
  - the previews, primary first, with their labels and sources;
  - the path field, reload, the width preset, "Take a screenshot" and "Share";
  - the watchers' count, and the view's line;
  - "Keep it" on an announced preview.
- **The frames:** the pane reads `/api/previews/:viewId/stream` with `fetch`'s body reader, and draws each JPEG frame into a canvas from a `blob:` URL, revoked after use.
- **Input:** the member's mouse, wheel, keys and pasted text, batched, through `/api/previews/:viewId/input`. While the pane has focus, its keys go to the app and not to the panel's shortcuts, and Escape leaves the pane, so milestone 7's keyboard rules hold.
- **The heartbeat** every 30 s while the pane is open and the tab visible.
- **"Expand"** widens the same element to the page's width without a reload, and hides the thread behind a floating steer bar (`task-preview-expanded`). *Changed 2026-11-21: the maintainer approved the steer bar over the thread folded to a strip.*
- **The stopped pane:** the last screenshot, "Start the app" with its progress (the setup, the processes, ready), and the states for a runner below minor 7 and on the HTTP carrier.
- **The share dialog:** the levels, the named-people picker, a link's expiry and "Allow input", public greyed with why, the existing links with their first use and "Revoke".
- **The viewer page** at `/p/<token>`, for a signed-out person: the stream alone, the label, the organization's name, "watch only" or input, the expiry, and the expired and revoked states. It loads none of the panel's shell, and its route reaches no tRPC procedure but the link's own.
- **Words** through `t`, and the CSP unchanged (frames are `blob:` images).

## Done when

- [ ] The targets' approval is recorded in ticket 09's `## Comments` before the UI is built.
- [ ] Tests named for `F-141` (this ticket's own browser spec file only):
  - the pane streams the fixture app;
  - a click counts the counter;
  - "Expand" keeps the same element (no reload: the counter's count survives);
  - the box stays warm while the pane is open, with the clock moved;
  - "Start the app" brings the pane live.
- [ ] Tests named for `F-142`:
  - a signed-out viewer sees the stream from a watch-only link and their clicks change nothing;
  - a link with input lets them click;
  - a revoked link shows its state;
  - the viewer page shows nothing else of the task.
- [ ] Milestone 7's keyboard walk and contrast check pass on the pane, the dialog and the viewer page, in both themes, and the pane works at 390 px.
- [ ] Checks for `apps/web` and `packages/task-view` pass (spec section 10).
- [ ] Committed as `✨ add the preview pane and sharing`.

## Comments
