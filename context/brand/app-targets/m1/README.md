# Milestone 1 screen targets

Each milestone 1 screen has a design target, and the panel is built to match it. These are the targets.

They were made image first with the `ui-taste` skill on Higgsfield `gpt_image_2_6`, using the graphite concepts in `../../app-concepts/html/` and the Hinge logo as references. Each target has three files:

| File | What it is |
|---|---|
| `<screen>.webp` | The picture, at CSS scale: 1440 px wide (sign-in: 1200), so one image pixel is one CSS pixel |
| `<screen>.md` | The build spec: purpose, layout, every state with its copy, components, tokens, differences from the current code, and what the picture gets wrong |
| `<screen>.prompt.txt` | The prompt that made the picture |

**Status:** the maintainer approved every target on 2026-11-19, `sign-in` and `change-password` included. Their right column, first a dimmed task mock, is now a brand illustration ("the sign in page requires a proper illustration on the right"): the maintainer chose "Deep water" from three directions (Strata, Deep water, Contour) the same day, and both pictures show it composited in. The file is `../../files/web/sign-in-illustration.webp` (B-017 in `../../assets.md`), and `sign-in.md` says how to build the column. No screen is rebuilt to its target before it's approved (`../../app-design.md`, and the UI process in `AGENTS.md`).

## Screens

| Screen | Route | Target |
|---|---|---|
| Sign-in | `/sign-in` | `sign-in` |
| Home | `/` | `home` |
| Project, tasks | `/projects/[project-id]` | `project` |
| Create a project | `/projects/new` | `project-new` |
| Environment | `/projects/[project-id]/environment` | `environment` |
| Task | `/tasks/[task-id]` | `task` |
| New task | `/tasks/new` | `task-new` |
| Runners | `/organization/runners` | `runners` |
| Approve a runner | `/device` | `device` |
| Models | `/organization/models` | `models` |
| GitHub | `/organization/github` | `github`, `github-not-connected` |
| Choose a new password | `/change-password`, forced at the first sign-in with the default password | `change-password`, `home-banner` (the default-password banner) |

The old "Create the first admin" setup target is gone. On 2026-11-19 the maintainer decided that a fresh install creates its first admin from settings, `demo@demo.com` / `demo` by default. The setup checklist now lives on Home (`home.md`, "First run").

## Rules for every screen

- **The spec wins.** Where a picture and its `.md` disagree, build what the `.md` says. Each spec lists the picture's errata under "Wrong in the image".
- **One sidebar.** Build it from the shared shell (`components/shell/sidebar.tsx`, from `app-concepts/html/shell.js`), never from a picture. In milestone 1 it holds only what works:
  - Home
  - Projects, each with Tasks and Environment, plus New project
  - Organization: Runners, Models and GitHub

  Some pictures show the full later sidebar (Runner pools with counts, Agent profiles, Insights, Memory, Members, Audit log, Background work). That's flavour from the concepts, not milestone 1 scope.
- **Real data only.** The counts, names and spend in the pictures are demo data. The build shows what the API returns, and an honest empty state where it returns nothing.
- **Fonts and the logo come from the brand.** The image model draws them only approximately: use Manrope and IBM Plex from `graphite.css`, and the real Hinge SVG.
- **Check it by eye.** After building, screenshot the screen at the target's viewport, compare it with the picture, fix what differs, and repeat.
