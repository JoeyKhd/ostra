# Milestone 8 screen targets

The design targets for milestone 8 (`context/specs/m8-previews-and-library/`, section 13):
- **the double-sidebar shell** (F-146), which every other screen is drawn in;
- **the live preview pane** (F-140, F-141);
- **screenshots and recordings in the timeline** (F-121);
- **the skills and MCP library** (F-144, F-145).

**Status: approved 2026-11-21** (the maintainer: "yes to all"). The choices the approval settled are under "Approval" below. Build from these targets.

**Why these screens:**
- **The shell:** the maintainer, 2026-11-21: "i like the ux of multica a lot, their double sidebar is nice". How Multica's works is in `context/research/multica-ui.md`. These targets take its structure and keep ostra's own look (`../../brief.md`, `../../app-design.md`).
- **The rest:** the same day, the maintainer approved live previews in the task chat, screenshots in the timeline, and a skills and MCP library.

## How they're made

They're real HTML, not image-model pictures (`app-design.md`, rule 5). Each page in `html/` uses the panel's tokens, copied from `apps/web/src/app/globals.css` for both themes into `html/m8.css`, the panel's own font files (`apps/web/src/fonts`), Lucide icons and the Hinge from `apps/web/public/brand/`.
- **The shared parts:** `html/shell.js` draws the rail and the context panel. `html/app-fixture.js` draws "Tally", the demo app inside the preview, in its own colours on purpose, so it never reads as ostra's chrome.
- **The render:** Playwright renders each page at 1440×956 and 2×, to `<name>.png` (2880×1912). `html/to-webp.py` then writes `<name>.webp` at 1440×956, one image pixel per CSS pixel. The commands:

  ```
  node html/render.mjs <path to playwright/index.mjs> [name ...]
  python -I html/to-webp.py [name ...]
  ```

  The renders used `playwright@1.65.1` from the repo's `node_modules`.
- **No Higgsfield credits were used.** Every screen could be drawn in HTML, so the `html/` page stands where earlier milestones kept a `.prompt.txt`.
- **All data is demo data:** Acme Corp, its projects and people, and the marketplace's owners, counts and audits (except `anthropics/skills@webapp-testing`, a real repo). Model names and protocol facts are from the research files each spec cites.

## Screens

| Screen | Targets | Build spec | m8 spec, section 13 |
|---|---|---|---|
| The shell on Home, dark and light | `shell-home`, `shell-home-light` | `app-shell.md` | ticket 10 (F-146) |
| The shell on a project's task list, dark and light | `shell-project-tasks`, `shell-project-tasks-light` | `app-shell.md` | ticket 10 |
| The panel collapsed, peeking the Organization | `shell-peek` | `app-shell.md` | ticket 10 |
| The shell at phone width, with no tab bar: a project's tasks under the menu button and breadcrumb, and a task | `shell-phone` | `app-shell.md` | ticket 10 |
| The phone's menu sheet: the rail and the panel together, dark and light | `shell-phone-menu` | `app-shell.md` | ticket 10 |
| The task page with the preview pane, dark and light | `task-preview-pane`, `task-preview-pane-light` | `task-preview.md` | target 1 |
| The preview at full width | `task-preview-expanded` | `task-preview.md` | target 2 |
| The pane starting, and with the box asleep | `task-preview-starting`, `task-preview-stopped` | `task-preview.md` | target 3 |
| The pane with nothing to preview | `task-preview-none` | `task-preview.md` | not in the spec's list |
| The service switcher (web and api, a service, the agent's) | `task-preview-services` | `task-preview.md` | target 1 |
| Who can open a preview | `preview-share` | `task-preview.md` | target 6 |
| Screenshots and a recording in the timeline, and their viewer | `task-attachments`, `task-attachments-viewer` | `task-attachments.md` | target 4 |
| The organization's library | `library` | `library.md` | target 10 |
| An item: source, pin, used-by profiles, an update's diff | `library-update` | `library-update.md` | target 12 |
| The admin's marketplace browser | `library-browse` | `library-browse.md` | target 14 |

The names follow the milestone 8 spec's section 13 where it names the screen. Section 13's other targets aren't drawn here yet; ticket 09 makes them in this shell, now that it's approved:
- 5 `environment-app-processes`
- 7 `preview-viewer`
- 8 `preview-native`
- 9 `instance-preview-domain`
- 11 `library-install`
- 13 `library-suggestions`
- 15 `agent-profile-library`

## Rules

The earlier milestones' rules hold (`../m1/README.md` to `../m7/README.md`):
- **The build spec wins** on copy, states, components and behaviour. Each `.md` ends with "Wrong in the image": build from the file, not the picture, where the two differ.
- **The picture wins** on size, spacing and contrast. Here a picture is HTML, so its sizes are exact CSS px, and its `.md` lists them.
- **Real data only** in the build, with the brand's fonts and logo.
- **Check each screen by eye** against its picture, at 1440×956, after the build.

These are new for milestone 8:
- **The shell replaces the single sidebar** on every screen from here on. Older targets keep their page area: only the frame around them changes (`app-shell.md`).
- **Amber stays only for "needs you":** Needs you's count in the rail, Needs approval's pill, and the dots. The preview pane and the library have none.
- **The app inside a preview is the customer's.** It draws in its own colours, and ostra puts no colour or chrome inside the frame.

## Approval

**Approved 2026-11-21.** The maintainer: "yes to all", for every screen in the table above. The choices it settled:
- **Projects:** one Projects space in the rail, not pinned projects (`app-shell.md`, open point 2).
- **Phone:** no bottom tab bar. The maintainer: "no need for a bottom tab bar btw". The menu button opens one sheet holding the rail and the panel together, and carries an amber dot while something needs the member. `shell-phone` was redrawn that day, and `shell-phone-menu` added (`app-shell.md`, "Phone" and open point 4).
- **The expanded preview:** a floating steer bar over the full-width app, not the thread folded to a strip (`task-preview.md`, open point 1).
- **The organization tile:** the Hinge with a small letter chip, not a plain letter tile (`app-shell.md`, open point 1).
- **`Wake to preview` and `Start the app`:** both labels kept, as drawn (`task-preview.md`, open point 2).

The open points this list doesn't name stay in their build specs as they were.
