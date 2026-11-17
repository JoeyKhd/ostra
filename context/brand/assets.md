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
| B-015 | Email logo | `files/web/email-logo@2x.png`, 400 px wide (shown at 200), the Abyss lockup for light email backgrounds | script | v1 | done |

## Inside the tools ostra plugs into

Every install registers its own Linear app and GitHub App (ADR 0001), so ostra ships the images the setup wizard asks admins to upload.

| ID | Asset | Format and sizes | Made by | Priority | Status |
|---|---|---|---|---|---|
| B-016 | Integration app icon | `files/integrations/app-icon-512.png` 512×512, the Shell mark on Abyss, no transparency. Used for the Linear app, its agent avatar on tickets, and the GitHub App, whose commits and PRs show it | script | v1 | done |

## Open source

| ID | Asset | Format and sizes | Made by | Priority | Status |
|---|---|---|---|---|---|
| B-020 | GitHub org avatar | `files/github/avatar-500.png` 500×500 | script | v1 | done |
| B-021 | GitHub social preview | `files/github/social-preview.png` 1280×640, dark | script | v1 | done |
| B-022 | README header | `files/readme/header-dark.png` and `header-light.png` 1600×560, for a `<picture>` that follows the reader's GitHub theme | script | v1 | done |
| B-023 | Container image icon | `files/registry/icon-512.png` for the server and runner images on GHCR and Docker Hub | script | v1 | done |
| B-024 | Terminal look | The runner and `ostra attach` CLI's colours and banner, from the palette's ANSI-safe values | script | later | planned |

## Launch

| ID | Asset | Format and sizes | Made by | Priority | Status |
|---|---|---|---|---|---|
| B-030 | Social banners | X and LinkedIn headers | Higgsfield + script | later | planned |
| B-031 | Launch gallery | Images for directory and launch sites | Higgsfield + script | later | planned |
