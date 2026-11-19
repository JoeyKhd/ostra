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

## Scale: the picture wins on size, spacing and contrast

The approved pictures are drawn about 12 to 15% larger and brighter than `graphite.css`, which the specs' token tables quote. The maintainer approved the pictures, so **where a picture and its `.md` disagree on size, spacing or contrast, the picture's scale wins.** The `.md` still wins on copy, states, components and behaviour.

The panel's values were measured from the pictures on 2026-11-19 (home, task, project, runners, models, github, device and environment; one image pixel is one CSS pixel), and live as tokens in `apps/web/src/app/globals.css`:

| What | graphite.css (the specs) | The pictures, measured | The panel now |
|---|---|---|---|
| Body and sidebar text | 13px | cap height 10 to 11 px (≈15px of Plex Sans), word widths ≈1.11 × 13px | 14.5px (`text-body`) |
| Dense rows: tables, properties, buttons, fields | 12.5px | ≈1.12 × | 14px (`text-ui`) |
| Secondary text | 12px | ≈1.09 × | 13px (`text-sm`) |
| Small: group labels, table heads | 11px, 11.5px | ≈1.09 × | 12px (`text-xs`), 12.5px |
| Lede | 13.5px | | 15px (`text-lede`) |
| Page title (Manrope 700) | 24px | 25 to 30px, median ≈25.5px | 26px (`text-title`) |
| Organization name | 13px | ≈15px | 15px |
| Mono | the same steps | | the same steps |
| Sidebar | 232px | 231 to 237px, median 234px | 234px |
| Sidebar rows | 26px | 25 to 33px, median ≈29px | 28px |
| Search box and its + button | 28px | 27 to 34px, median 30px | 30px |
| Top bar | 44px | 43 to 49px, median 46px | 46px |
| Buttons | 28px | 30px | 30px (sm 26px) |
| Inputs | 32px | | 34px |
| Properties panel | 300px, 340px with a form | 319 to 343px (task pages 336px), 380px with a form | 320px, 380px with a form |
| Page padding | 28px 40px | 32 to 46px, median ≈36px | 28px 36px |
| `--text` | `#EDEDEE` | `#F3F4F5` to `#FCFCFD` | `#F2F3F4` |
| Sidebar rows | `--muted` | `#D3D5D8` to `#DBDEE0` | `--text-2` `#D6D8DB` |
| `--muted` (secondary) | `#9A9DA3` | `#B2B4B7` to `#BFC1C5` | `#B4B7BB` |
| `--faint` | `#64676D` | `#828487` to `#969799`, median `#8E9093` | `#8B8E93` |

Table rows (38px) and section spacing (26px) already matched the pictures and are unchanged. Text widths in the pictures run narrower than Plex Sans at their height, so the type sits between the two measures. Sign-in and change-password keep the scale their own pictures were matched at (`.auth-scale`).

## Rules for every screen

- **The spec wins, except on scale.** Where a picture and its `.md` disagree on copy, states, components or behaviour, build what the `.md` says. Each spec lists the picture's errata under "Wrong in the image". On size, spacing and contrast the picture wins ("Scale", above).
- **One sidebar.** Build it from the shared shell (`components/shell/sidebar.tsx`, from `app-concepts/html/shell.js`), never from a picture. In milestone 1 it holds only what works:
  - Home
  - Projects, each with Tasks and Environment, plus New project
  - Organization: Runners, Models and GitHub

  Some pictures show the full later sidebar (Runner pools with counts, Agent profiles, Insights, Memory, Members, Audit log, Background work). That's flavour from the concepts, not milestone 1 scope.
- **Real data only.** The counts, names and spend in the pictures are demo data. The build shows what the API returns, and an honest empty state where it returns nothing.
- **Fonts and the logo come from the brand.** The image model draws them only approximately: use Manrope and IBM Plex from `graphite.css`, and the real Hinge SVG.
- **Check it by eye.** After building, screenshot the screen at the target's viewport, compare it with the picture, fix what differs, and repeat.
