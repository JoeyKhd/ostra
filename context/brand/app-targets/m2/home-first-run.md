# Home, first run: target

> **Committed image:** `home-first-run.webp`, downscaled from the 2048×1360 picture to 1440×956, so one image pixel is one CSS pixel.

Home's first-run checklist (F-076) with the Linear step live (F-005), no longer "milestone 2" (screen 2 of `../../../specs/m2-tickets-in/spec.md` section 12). Everything else on Home is milestone 1's target, `../m1/home.md`: this file changes only its "First run" section and the right panel while the checklist shows.

Prompt: `home-first-run.prompt.txt`. Made with the `ui-taste` skill, image first, on Higgsfield `gpt_image_2_6` (3:2, 2k, high), from the approved milestone 1 Home target (`../m1/home.png`, its 2048 original), the graphite Home concept (`../../app-concepts/html/home-graphite.png`) and the Hinge logo. One generation, with the right column asked for empty. The right column was then composited with the brand's "Deep water" illustration (`../../files/web/sign-in-illustration.webp`, B-017 in `../../assets.md`), scaled and darkened as "The illustration" below says. It's the maintainer's chosen illustration, not a dimmed mock of product UI.

**Status:** a target, not yet approved by the maintainer (ticket 32). The picture is an image-model render: the copy and rules in this file win over the pixels, and the tokens below win over its colours.

## Purpose

A new organization's first screen, for its admin. It answers:
1. What's left to set up, and what's next? (the checklist, the next step's one primary button)
2. Can I skip Linear? (yes: a project can run on prompts alone)

Route: `/` (`app/(panel)/page.tsx` → `components/home/home-view.tsx`). The checklist shows while `setup.status.next` isn't `null`, as in milestone 1.

## Layout (1440 px wide)

| Region | Size | Contents |
|---|---|---|
| Sidebar | 232px, `--side`, right hairline | The shared sidebar; **Home** selected. A new organization has no projects, so Projects holds only `New project` |
| Top bar | 44px, bottom hairline | Breadcrumbs `Acme Corp › Home`. Right: `+ New task` as an **outline** button (`.btn`) while the checklist shows; it becomes the primary once setup is done (`../m1/home.md`) |
| Page | `1fr`, padding `28px 40px` | Heading, then **Set up ostra**, **Projects**, **Recent activity**, 26px apart |
| Right column | 320px, left hairline, `--side` | Decorative: the brand illustration. No text, no data |

At `< xl` the right column is hidden (the properties panel would stack under the page there, and a picture under a checklist says nothing). At phone width (F-075) a step's action wraps under its body, left-aligned with the title, and `Skip for now` sits after the button.

### Heading
- Eyebrow, `.key` (Plex Mono 12px, `--faint`): `Thursday 19 November` (the member's locale date, `en-GB`).
- `h1` (Manrope 700 24px): the organization's name, `Acme Corp`.
- Lede (13.5px `--muted`): `Your organization's projects and what waits on you.` (`home.lede`, unchanged while setup runs; the live summary of `../m1/home.md` replaces it once there's something to count).

### Set up ostra (the checklist)

- Header (`Section`): `Set up ostra`, and on the right `3 of 7` in mono `--faint` (`checklist.progress`). A skipped step counts as settled: `{done}` is done plus skipped.
- Rows: minimum 52px, hairlines between, padding 10px 0. Left to right: the 22px step circle, then the title (13px 500) over the body (12.5px `--muted`, one line at 1440, wrapping below), then the action, right-aligned on one edge.
- Circles: done is a filled `--green` circle with an `--ink` check (13px); the next step a 1px `--text` ring with its number in mono `--text`; a later step a 1px `--line-2` ring with a `--muted` number; a skipped step a 1px dashed `--line-2` ring with a `--faint` `–`.
- A done step's title is `--muted` and it has no action.
- The next step's action is the page's **one primary** (Shell) button; every other open step's action is an outline button, 28px, `--surface` fill, `--line-2` border, each label followed by `→` (Lucide `arrow-right` 12px).

The seven steps, in this order (the copy for the steps milestone 1 already has is `messages/en.json`'s, unchanged):

| # | Step | Body | Action |
|---|---|---|---|
| 1 | `Create the first admin` | `You're signed in as the admin.` | – (always done) |
| 2 | `Add a model provider` | `A base URL and a token. ostra lists the models and tests the connection.` | `Add a provider →` |
| 3 | `Connect GitHub` | `A GitHub App opens every pull request. Use an existing App or create one.` | `Connect GitHub →` |
| 4 | `Connect Linear` | `Tickets become tasks, and ostra keeps their status in step. Skip it to run on prompts alone.` | `Connect Linear →` (to `/organization/linear`), and before it a teal link `Skip for now` |
| 5 | `Create a project` | `Pick a repo. ostra drafts its environment from the repo's files.` | `Create a project →` |
| 6 | `Connect a runner` | `Run one command on a machine. Tasks run there.` | `Connect a runner →` |
| 7 | `Start the first task` | `Type a prompt and watch the agent work, then review its pull request.` | `New task →` |

The picture shows steps 1 to 3 done and Linear next.

### The Linear step's states

| State | When | Circle | Body | Action |
|---|---|---|---|---|
| Next | the first unsettled step | `--text` ring, `4` | the table's body | `Skip for now` (teal link) + primary `Connect Linear →` |
| Open, not next | an earlier step is still open | `--line-2` ring | the table's body | `Skip for now` + outline `Connect Linear →` |
| Started | the connection is `pending` | `--text` or `--line-2` ring, as above | `Started: paste the app's values and authorize to finish.` | primary or outline `Continue →` (to `/organization/linear`); no skip link |
| Failed | the connection is `failed` | `--line-2` ring | `--red` `triangle-alert` 13px + `Linear refused the token. Authorize the app again.` | outline `Authorize again →` (to `/organization/linear`) |
| Skipped | an admin skipped it | dashed ring, `–` | title `--muted`; body `Skipped. Tasks start from prompts until you connect it.` | teal link `Connect Linear` (to `/organization/linear`), no button |
| Done | a connection is `active` | green, check | the table's body | – |

- `Skip for now` acts at once, with no dialog: it's undone by connecting. Saving it is a server write (see differences, item 2), so for the moment it takes, the link reads `Skipping…` and is disabled.
- A revoked connection doesn't undo a finished checklist: once `next` has been `null`, the checklist doesn't come back.
- **A member** who isn't an admin sees the same rows with no actions, except `New task →` on step 7, as today. No `Skip for now`.

### Projects and Recent activity, while the checklist shows
- **Projects**, count `0` in mono `--faint`: one `--muted` row between hairlines, `No projects yet. Create one from the checklist.` (`home.noProjectsAdmin`; a member: `home.noProjects`).
- **Recent activity**: one `--muted` row, `Nothing has happened yet.` (`home.activity.empty`, a key `../m1/home.md` adds; the section isn't built yet).
- The **Needs you** section of `../m1/home.md` isn't shown while the checklist is: the checklist takes its place.

### The illustration (decorative)

The right column replaces milestone 1's "the right panel is empty (not rendered)" during first run.
- **The file:** the sign-in illustration, `../../files/web/sign-in-illustration-1200.webp` (B-017), served as `/sign-in-illustration-1200.webp`: `sign-in.md` copies it to `apps/web/public/`; whichever screen is built first copies it. No new asset.
- **The column:** `PageFrame`'s `properties` slot, 320px, `position: relative; overflow: hidden; background: var(--side)`, `aria-hidden`, nothing focusable.
- **The image:** `background: url(/sign-in-illustration-1200.webp) 50% 0 / 162.5% auto no-repeat` on a child layer with `opacity: 0.85`, over `--side`. That shows the stone whole, about 200px wide, centred, its middle about 275px below the top bar, with the light from above, and fades into `--side` at about 650px down (the asset's own bottom fade). The opacity keeps the stone dimmer than the primary button, so `Connect Linear →` stays the brightest thing on the page.
- **No text** in the column, and no other image: Home already says what ostra is.
- Hidden at `< xl` (`hidden xl:block`), so it costs a narrow screen nothing (a CSS background on a hidden element isn't fetched).

### Loading and errors
- **Loading:** the heading at once; the checklist shows 4 `Skeleton` rows (52px, `--surface` bars, no shimmer) until `setup.status` answers. The right column renders at once (it needs no data).
- **Error:** the checklist keeps its header and shows one row: `Couldn't load this. Retry`, with `Retry` as a teal link. The other sections still render.

## Components (shadcn/ui names)

| Piece | Component |
|---|---|
| Section header | the existing `Section` (`page-frame.tsx`) with its `end` slot for the progress |
| Step circles | `Tick` from `setup-checklist.tsx`, moved to a shared `components/ui/step-tick.tsx` (the Linear page's steps use it too), with a new `skipped` look |
| Actions | `Button` (default = Shell) for the next step, `variant="outline" size="sm"` for the others; links rendered `asChild` through `next/link` |
| Skip for now, Connect Linear (skipped) | `Button variant="link"` in `--teal` |
| Top bar New task | `Button variant="outline"` while the checklist shows |
| Loading | `Skeleton` |
| Illustration | a plain `div` with the CSS background above (no `next/image`: it's decorative and CSS-sized) |

## Tokens (from `../../app-concepts/html/graphite.css`)

> **Scale.** The sizes and colours below are `graphite.css`'s. The panel is built at the approved pictures' scale, which wins on size, spacing and contrast: body 14.5px, dense rows 14px, secondary 13px, small 12px, title 26px, `--muted` `#B4B7BB`, `--faint` `#8B8E93`, buttons 30px, a 46px top bar and a 320px properties panel (380px with a form). The measured values are in `../m1/README.md`, "Scale".

```css
--bg: #0D0E10;   --side: #0A0B0C;  --surface: #131416; --raise: #17181B;
--line: #1F2023; --line-2: #2A2C30;
--text: #EDEDEE; --muted: #9A9DA3; --faint: #64676D;
--sel: #1A1B1E;  --teal: #6FB8AA;  --green: #4FB286;  --red: #E5675C;
--amber: #FFB224; --shell: #F3F0E8; --ink: #0C1D21;
```

- Type: `h1` Manrope 700 24px; body IBM Plex Sans 13px; step titles 500 13px; bodies 12.5px; section titles 600 13px; the date, the progress and the step numbers IBM Plex Mono.
- Sizes: step rows 52px minimum, circles 22px, buttons 28px, radius 7px, icons Lucide 15px stroke 1.75 (12px arrows in buttons).
- **No amber on this screen:** nothing waits on the member yet. Green only on done circles; teal only on links; red only on the Failed step's icon.

## Differences from the current code

`components/home/setup-checklist.tsx` and `home-view.tsx` today, and `packages/api/src/routers/setup.ts`:

1. **A `linear` step in `setupStepIds`,** between `github` and `project`, done when the organization has a `Connection` of kind `linear` in state `active`. The hard-coded dashed `milestone 2` row in `SetupChecklist` goes, with `checklist.linear.later`.
2. **Skipping is new state.** `setup.status` needs a way to know the step was skipped, shared by every admin: a `setup.skip({ step: "linear" })` mutation (admin only) and a nullable `linearSkippedAt` (or a general `setupSkipped` list) on the organization's settings, added by ticket 05's migration. `setup.status`'s step gains `state: "done" | "skipped" | "open"` (instead of `done: boolean`), plus the connection's `pending` / `failed` for this step; `next` is the first `open` step. Neither is in tickets 05, 27 or 33 yet: ticket 33 (or 27) should take it.
3. **Progress** counts done and skipped steps: `3 of 7` in the picture.
4. **Actions:** today every open step gets a button and the next gets the Shell fill. Unchanged, plus `Skip for now` on the Linear step and its five states above.
5. **Top bar:** `New task` is always the Shell primary today (`buttonVariants()`); while the checklist shows it's the outline variant, so the next step's button is the page's one primary (`../m1/home.md` says so already; the code doesn't do it).
6. **The right column** is new while the checklist shows: today `HomeView` passes no `properties`. Pass the decorative column only while `setup.status.next !== null`.
7. **Sidebar:** a `Linear` row (Lucide `ticket`) after GitHub, as `connect-linear.md` says.
8. **Messages:** `checklist.linear.body` changes to the copy above; new keys `checklist.linear.action` (`Connect Linear`), `checklist.linear.skip` (`Skip for now`), `checklist.linear.skipping` (`Skipping…`), `checklist.linear.skipped` (`Skipped. Tasks start from prompts until you connect it.`), `checklist.linear.pending`, `checklist.linear.continue` (`Continue`), `checklist.linear.failed`, `checklist.linear.authorizeAgain` (`Authorize again`); `checklist.linear.later` is removed.

## Wrong in the image

The build uses the copy in this file, not the pixels.

1. **The logo mark** (top-left) is drawn as a circle with a slash, a little large: use the real Hinge file (`../../kit/logo/export/ostra-hinge-single-color.svg`, 20px).
2. **The sidebar** shows `Needs you`, `My tasks`, `Members` and `Settings`, which milestone 1's shared shell doesn't have yet. Build the sidebar from `components/shell/sidebar.tsx`, plus the Linear row. The user at the bottom is the default first admin, `demo`, as a fresh install has.
3. **The `Projects` count** is drawn as `0` in a slashed-zero mono: a faint mono `0` is right, its glyph comes from IBM Plex Mono.
4. **The step titles** of done steps are drawn in nearly the same white as open ones: they're `--muted`.
5. **The right column** is drawn 320px wide, wider than milestone 1's 300px properties panel. 320px is right for this decorative column.
6. **The stone** is composited, not generated: build it from the asset and the CSS above, not by cropping the picture.
7. No misspellings.
