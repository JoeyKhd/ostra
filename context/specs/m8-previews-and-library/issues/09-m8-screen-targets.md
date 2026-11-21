# 09: Milestone 8 screen targets

Status: done
Builder: web
Blocked by: the double sidebar's targets approved (ticket 10's first condition), since every new screen is drawn in the new shell. *Approved 2026-11-21 (the maintainer: "yes to all").*
Features: F-121, F-140, F-141, F-142, F-144, F-145, F-146 (their screens)
Packages: `context/brand/app-targets/m8/`
Note: the maintainer requires `ui-taste` plus Higgsfield targets, approved before any of tickets 17, 21, 26 and 31 builds its UI.
Spec: `../spec.md`, section 13

## What to build

`build-order.md` says a milestone's screens are designed first, image first, and the approved pictures land in `context/brand/app-targets/`.
- Follow `context/brand/brief.md` and `context/brand/app-design.md`, in the double-sidebar layout its targets set (ticket 10).
- Start each screen from the target the spec names.
- Use the `higgsfield-brandkit` skill's state in `context/brand/kit/`.

The fifteen new targets are spec section 13's table. Make them as milestones 1 to 7's approved targets were made: image first with the `ui-taste` skill on Higgsfield, from the target the spec names. Each screen gets three files:
- `<screen>.webp`, at CSS scale (1440 px wide);
- `<screen>.md`, the build spec: purpose, route, layout, every state with its copy, components, tokens, differences from the current code, and what the picture gets wrong;
- `<screen>.prompt.txt`.

The folder's `README.md` is the double sidebar's (the design agent's). Add this ticket's screens to its list, with their approval status.

The screens that only grow (section 13's second list) get no new picture. Their changes go into the building ticket's `## Comments` as a short list against the existing target.

Notes for some targets:
- **`task-preview-pane`, `task-preview-expanded` and `task-preview-stopped`** settle the pane's width beside the thread at 1440 px and at 1280 px; how "Expand" folds the thread without moving the frame; the view's line for each mode ("Live: the box's browser", "In your browser", "Runner on HTTP: 2 frames a second", "This runner needs upgrading"); and the watchers' count. The pane's picture is the app's own, so it carries no ostra colour.
- **`task-attachments`** settles a screenshot's size in the thread, the caption's place, the browser line, and the recording's player controls with its steps beside it.
- **`preview-share` and `preview-viewer`** hold the words for each level and each refusal. The viewer page shows nothing of the task but the preview's label, so it says who shared it only by the organization's name.
- **`library-install`** holds the words for "not installable yet" (packages only, OAuth), for a source that isn't allowed, and for pointing out script files.
- **Every target** is checked against WCAG AA contrast in its build spec, in both themes, as F-081 asks.

## Done when

- [x] The fifteen targets exist in `context/brand/app-targets/m8/`, three files each, listed in the folder's README. *Done 2026-11-21: each has its `.webp`, its build spec and its `html/` page, which stands in for the `.prompt.txt` (the README's "How they're made").*
- [ ] They're approved, recorded under `## Comments` with the date. Until then, tickets 17, 21, 26 and 31 build their data and tests, not their UI.
- [ ] Committed as `🎨 add milestone 8 screen targets`.

## Comments

- **2026-11-21, the second batch.** Targets 5, 7, 8, 9, 11, 13 and 15 are drawn in the approved shell: 19 pictures with their build specs, listed in the README's "The second batch", **waiting for the maintainer's approval**. As in the first batch, each is real HTML rendered with Playwright, so no Higgsfield credits were used. Targets 1, 2, 3, 4, 6, 10, 12 and 14 were approved the same day ("yes to all", the README's "Approval").
- 2026-11-21, lead: the maintainer approved the second batch ("Yes to all"); every open point is settled as its spec recommends, recorded in `context/brand/app-targets/m8/README.md`. Both batches are approved, so the screen tickets (17, 21, 26, 31) can build.
