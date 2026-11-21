# Milestone 8 screen targets

The design targets for milestone 8 (`context/specs/m8-previews-and-library/`, section 13):
- **the double-sidebar shell** (F-147), which every other screen is drawn in;
- **the live preview pane** (F-141, F-142);
- **screenshots and recordings in the timeline** (F-121);
- **the skills and MCP library** (F-145, F-146);
- **the environment's app processes** (F-140), **the viewer page for a preview link** (F-142), and **the native preview with the preview domain's settings** (F-144), in the second batch below.

**Status:** the first batch was **approved 2026-11-21** (the maintainer: "yes to all"). The choices the approval settled are under "Approval" below. Build from those targets. **The second batch,** section 13's other seven targets, drawn the same day, is **waiting for the maintainer's approval**, and nothing in it is built until then.

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
- **All data is demo data:** Acme Corp, its projects and people, and the marketplace's owners, counts and audits (except `anthropics/skills@webapp-testing`, a real repo). Globex, its repos, registry entries and hosts are invented for the second batch. Model names and protocol facts are from the research files each spec cites.

## Screens

| Screen | Targets | Build spec | m8 spec, section 13 |
|---|---|---|---|
| The shell on Home, dark and light | `shell-home`, `shell-home-light` | `app-shell.md` | ticket 10 (F-147) |
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

The names follow the milestone 8 spec's section 13 where it names the screen.

### The second batch: waiting for the maintainer's approval

Ticket 09 drew section 13's other seven targets on 2026-11-21, in the approved shell and the same way. **Each is waiting for the maintainer's approval.** When it's given, record it under "Approval" and in ticket 09's `## Comments`, with the date.

| Screen | Targets | Build spec | m8 spec, section 13 |
|---|---|---|---|
| The environment's app processes: the list, a process kept from a task, one found in the repo, services with a web UI, the after-turn screenshots, dark and light | `environment-app-processes`, `environment-app-processes-light` | `environment-app-processes.md` | target 5 |
| A process's editor sheet: the ready check, primary and the host rewrite | `environment-app-process-sheet` | `environment-app-processes.md` | target 5 |
| The environment when the box has no browser | `environment-app-processes-no-browser` | `environment-app-processes.md` | target 5 |
| The page a signed-out person opens from a link, dark and light | `preview-viewer`, `preview-viewer-light` | `preview-viewer.md` | target 7 |
| The viewer on a phone with input, and the expired and revoked links | `preview-viewer-states` | `preview-viewer.md` | target 7 |
| The pane with the app in the member's own browser, dark and light | `preview-native`, `preview-native-light` | `preview-native.md` | target 8 |
| Instance › Previews: the preview domain, its DNS record and certificate, the check, and public links | `instance-preview-domain` | `instance-preview-domain.md` | target 9 |
| The same with no preview domain set | `instance-preview-domain-unset` | `instance-preview-domain.md` | target 9 |
| Install by reference: a repo's skills, its files and scripts, the hash, a source to allow | `library-install` | `library-install.md` | target 11 |
| Install an MCP server: the registry, the remote, the inputs and secret, the test call's tools | `library-install-server` | `library-install.md` | target 11 |
| What can't be installed: OAuth sign-in, packages only, an SSE remote, a digest that doesn't match | `library-install-refusals` | `library-install.md` | target 11 |
| The admins' suggestions, with Install and Dismiss | `library-suggestions` | `library-suggestions.md` | target 13 |
| A member's Suggest sheet and their past suggestions | `library-suggest-form` | `library-suggestions.md` | target 13 |
| The profile editor's skills and MCP servers: its own, attached, every profile, the attach picker, dark and light | `agent-profile-library`, `agent-profile-library-light` | `agent-profile-library.md` | target 15 |
| A profile at its limit of 20 MCP servers, and the refusal | `agent-profile-library-limit` | `agent-profile-library.md` | target 15 |

**What the second batch changes in the first:**
- **The Organization panel's Instance group** gains `Previews` (`app-window`, `/instance/previews`, the instance admin's), drawn by `html/shell.js`. The approved renders that show the Organization panel predate it: re-rendering `library`, `library-update`, `library-browse` or `shell-peek` adds the row. `app-shell.md`'s list of the panel's rows gains it when the second batch is approved.
- **`library-install`'s sheet is 560 wide,** where `library.md` says 440, for the files and inputs it holds (`library-install.md`, open point 1).
- **`library-browse` and `library-update` draw skills.sh's audit verdicts as an option** (`library-update.md`, open point 3), which ADR 0069 has since left out (Q319). The second batch shows none.

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
