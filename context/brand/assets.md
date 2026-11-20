# Brand asset ledger

Every brand file ostra needs, so nothing is forgotten. Same rules as `context/features.md`: IDs are permanent, a status changes in the same commit as the file, and `done` means the file exists at its path in the listed sizes.

- **Priority:** `v1`, `later`.
- **Status:** `planned` → `building` → `done`, or `dropped`.
- **Made by:**
  - *brandkit:* the `higgsfield-brandkit` skill (palette, logo, typography, brandbook). Its state is `kit/state.json`.
  - *script:* `scripts/build-assets.py`, generated from the approved logo, palette and fonts, with no credits. It places the exported mark untouched and outlines text from the OFL fonts in `fonts/`. Run it again after any change to the foundation, from the repo root: `PATH="$PATH:/c/msys64/ucrt64/bin" python context/brand/scripts/build-assets.py`. It needs rsvg-convert and hb-shape from MSYS2 ucrt64, appended to the PATH so Windows Python, which has fontTools and Pillow, still runs.
  - *Higgsfield:* an image generation.
  - *template:* built in code with dynamic content.
- **Naming:** `-shell` files are for dark backgrounds (the default), and `-abyss` files are for light ones.

## Foundation

| ID | Asset | Format and sizes | Made by | Priority | Status |
|---|---|---|---|---|---|
| B-001 | Palette | Approved in `brief.md`. Tokens: `files/tokens/tokens.css` (dark `:root`, light under `[data-theme="light"]`) and `tokens.json` | brandkit + script | v1 | done |
| B-002 | Logo symbol | Master SVG (Recraft vector): `kit/logo/hinge.svg` | brandkit | v1 | done |
| B-003 | Logo symbol PNG | Transparent PNG 2048×2048: `kit/logo/export/ostra-hinge-2048.png` (Abyss) and `ostra-hinge-single-color-2048.png` (Shell) | brandkit | v1 | done |
| B-004 | One-colour logos | Abyss and Shell, SVG + PNG, in `kit/logo/export/`. Pure black or white are exported only when a use needs them | brandkit | v1 | done |
| B-005 | Typography | Manrope ExtraBold 800 (display), IBM Plex Sans 400 (body), IBM Plex Mono (code and logs). All OFL, in `fonts/` with their licenses. Specimen: `kit/reviews/typography-rounded-geometry.png` | brandkit | v1 | done |
| B-006 | Wordmark "ostra" | Outlined SVG: `files/logo/wordmark-shell.svg` and `wordmark-abyss.svg` | script | v1 | done |
| B-007 | Lockups | `files/logo/lockup-horizontal-{shell,abyss}.svg` + 1600 px PNG, and `lockup-stacked-{shell,abyss}.svg` + 1200 px PNG | script | v1 | done |
| B-008 | Brandbook | PDF + PPTX | brandkit | later | planned |
| B-009 | Identity board | `kit/reviews/identity.html` and `identity.png`: palette, mark and type on one page | brandkit | v1 | done |

## The panel and the web

| ID | Asset | Format and sizes | Made by | Priority | Status |
|---|---|---|---|---|---|
| B-010 | Favicon | `files/web/favicon.svg` (Abyss mark on light tabs, Shell on dark, by `prefers-color-scheme`) and `favicon.ico` (16, 32, 48; the Abyss mark) | script | v1 | done |
| B-011 | Apple touch icon | `files/web/apple-touch-icon.png` 180×180, the Shell mark on Abyss, no transparency | script | v1 | done |
| B-012 | PWA icons | `files/web/icon-192.png`, `icon-512.png` (rounded Abyss tile) and `icon-maskable-512.png` (safe zone) | script | v1 | done |
| B-013 | Web manifest colours | `files/web/site.webmanifest`, with Abyss as `theme_color` and `background_color` | script | v1 | done |
| B-014 | Open Graph image | `files/web/og-image.png` 1200×630, dark: the lockup, the headline and the proof line | script | v1 | done |
| B-015 | Email logo | `files/web/email-logo@2x.png`, 400 px wide (shown at 200), the Abyss lockup for light email backgrounds. The needs-you mail's two lockups (`app-targets/m3/email-needs-you.md`), served by the panel from `apps/web/public/email/`: `logo-abyss@2x.png`, 186×40 (shown at 93×20), the Abyss lockup on a baked-in Shell `#F3F0E8` background so clients that invert colours never lose it, and its dark-mode twin `logo-shell@2x.png`, the Shell lockup on transparency. Both rendered from `files/logo/lockup-horizontal-*.svg` in headless Chromium, 2026-11-19 | script | v1 | done |
| B-017 | Sign-in illustration | `files/web/sign-in-illustration.webp` 1792×2240 (the master, WebP quality 90) and `sign-in-illustration-1200.webp` 960×1200 (the app at 1×). The decorative right column of `/sign-in` and `/change-password` (`app-targets/m1/sign-in.md`): a machined matte stone in the Hinge's shape, split by a diagonal seam with Shell light inside, in deep blue-green water. Higgsfield `gpt_image_2_6`, 4:5, generation 3 of the "Deep water" direction; the maintainer chose it on 2026-11-19 from three directions (Strata, Deep water, Contour). Graded, not regenerated, by `scripts/sign-in-illustration.py`, which takes the raw generation (not committed): darkened ×0.87 so the form stays the brightest thing on the screen, a soft left-edge fade and a bottom fade into `--side` `#0A0B0C`, baked in. **Regraded to the panel's graphite on 2026-11-20** (it was blue-green), from the committed master, with no new pixels: chroma ×0.08 (sharp `modulate({ saturation: 0.08 })`, the empty-state art's grade), the two fades retargeted from `--side` to `--bg` `#0D0E10` with the script's own masks, the last rows below the bottom fade eased the rest of the way so the bottom row is `--bg`, and the same one-level dither. The same file is `apps/web/public/` (sign-in, change-password, accept-invite, reset) and `apps/docs/public/deep-water.webp` (the docs' home and search). The empty-state crops (`app-targets/m2/inbox-empty-illustration.webp`, `app-targets/m4/search-empty-illustration.webp`, and their `apps/web/public/` copies) have the same chroma grade plus an elliptical alpha mask, opaque to 55% of the radius and clear at the edge, so they melt into any page | Higgsfield + script | v1 | done |

## Inside the tools ostra plugs into

Every install registers its own Linear app and GitHub App (ADR 0001), so ostra ships the images the setup wizard asks admins to upload.

| ID | Asset | Format and sizes | Made by | Priority | Status |
|---|---|---|---|---|---|
| B-016 | Integration app icon | `files/integrations/app-icon-512.png` 512×512, the Shell mark on Abyss, no transparency. Used for the Linear app, its agent avatar on tickets, and the GitHub App, whose commits and PRs show it | script | v1 | done |

## Repository and listing

| ID | Asset | Format and sizes | Made by | Priority | Status |
|---|---|---|---|---|---|
| B-020 | GitHub org avatar | `files/github/avatar-500.png` 500×500 | script | v1 | done |
| B-021 | GitHub social preview | `files/github/social-preview.png` 1280×640, dark | script | v1 | done |
| B-022 | README header | `files/readme/header-dark.png` and `header-light.png` 1600×560, for a `<picture>` that follows the reader's GitHub theme | script | v1 | superseded by B-025 |
| B-025 | README banner | `files/readme/banner.png` 2400×1040, a plain edge-to-edge rectangle with no border or rounded corners (the maintainer, 2026-11-20: "just the image"). The Shell lockup, the tagline and the task screen, embedded live from `scripts/readme-banner-task.html`. Source: `scripts/readme-banner.html`, rendered at 1200×520, 2×, with the panel's own font files. **Re-themed to the panel's graphite on 2026-11-20** (it was Abyss with a teal cast): the card is `--bg` `#0D0E10` with a faint lighter graphite glow and a `--line` edge, and its text is the panel's `--text`, `--muted` and `--faint`. The task screen was redrawn as the panel draws it now, at its scale and contrast (the sidebar, the status and ticket lines, the tabs, an approval in the thread), in place of the 2026-11-18 concept. The copy says what v1 does: Linear tickets and prompts, your own runners and model keys | HTML + browser render | v1 | done |
| B-023 | Container image icon | `files/registry/icon-512.png` for the server and runner images on GHCR and Docker Hub | script | v1 | done |
| B-024 | Terminal look | The runner and `ostra attach` CLI's colours and banner, from the palette's ANSI-safe values | script | later | planned |

## Launch

| ID | Asset | Format and sizes | Made by | Priority | Status |
|---|---|---|---|---|---|
| B-030 | Social banners | X and LinkedIn headers | Higgsfield + script | later | planned |
| B-031 | Launch gallery | Images for directory and launch sites | Higgsfield + script | later | planned |
