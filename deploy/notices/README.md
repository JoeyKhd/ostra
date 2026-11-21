# Extra notices

The base image's THIRD_PARTY_NOTICES lists every package its installs bundle (`packages/deploy-checks/src/notices-main.ts`). This folder holds the notices for what it carries that isn't a package:

- the models.dev catalog (`/opt/ostra/catalog/models-dev.json`), under models.dev's MIT license as its repository gives it (https://github.com/anomalyco/models.dev/blob/dev/LICENSE, read 2026-11-20);
- Chromium, the box's browser (milestone 8's ticket 11, ADR 0068): Debian bookworm's `chromium` package at the version `packages/deploy-checks/src/chromium.ts` pins, which `chromium.json` must name (`pnpm check:images`). `chromium.LICENSE` is Chromium's own BSD-3-Clause license, as its repository gives it (https://github.com/chromium/chromium/blob/main/LICENSE, read 2026-11-21), and points to Debian's copyright file in the image, `/usr/share/doc/chromium/copyright`, which lists each component Chromium bundles with its license. Its fonts, `fonts-liberation` and `fonts-noto-color-emoji`, are Debian packages like the image's other system packages, each with its copyright file in `/usr/share/doc`.
