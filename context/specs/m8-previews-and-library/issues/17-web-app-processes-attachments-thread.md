# 17: Web: app processes and attachments in the thread

Status: ready-for-agent
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

- [ ] The targets' approval is recorded in ticket 09's `## Comments` before the UI is built.
- [ ] Tests named for `F-121` (the browser suite's own spec file only):
  - a screenshot and a recording shown in the thread, and still shown after the box stopped and after a reload;
  - the player plays and pauses;
  - "Add to draft".
- [ ] Tests named for `F-140`: the editor's rules shown as the API refuses them, and a proposal's processes accepted.
- [ ] Milestone 7's keyboard walk and contrast check pass on the new parts, in both themes.
- [ ] Checks for `apps/web` and `packages/task-view` pass (spec section 10).
- [ ] Committed as `✨ show app processes and attachments`.

## Comments
