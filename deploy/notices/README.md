# Extra notices

Each image's THIRD_PARTY_NOTICES lists every package its installs bundle (`packages/deploy-checks/src/notices-main.ts`). This folder holds the notices for what they carry that isn't a package of its own. In the base image:

- the models.dev catalog (`/opt/ostra/catalog/models-dev.json`), under models.dev's MIT license as its repository gives it (https://github.com/anomalyco/models.dev/blob/dev/LICENSE, read 2026-11-20);
- Chromium, the box's browser (milestone 8's ticket 11, ADR 0068): Debian bookworm's `chromium` package at the version `packages/deploy-checks/src/chromium.ts` pins, which `chromium.json` must name (`pnpm check:images`). `chromium.LICENSE` is Chromium's own BSD-3-Clause license, as its repository gives it (https://github.com/chromium/chromium/blob/main/LICENSE, read 2026-11-21), and points to Debian's copyright file in the image, `/usr/share/doc/chromium/copyright`, which lists each component Chromium bundles with its license. Its fonts, `fonts-liberation` and `fonts-noto-color-emoji`, are Debian packages like the image's other system packages, each with its copyright file in `/usr/share/doc`.

In the server image:

- pdf.js (milestone 9's ticket 07, F-150, ADR 0070): unpdf 2.2.1, which core reads PDFs' text with, bundles Mozilla's pdf.js 6.5.438 and its JBIG2 and OpenJPEG decoders in its `dist/`. unpdf is listed under its own name with its MIT license; `pdfjs.json` lists what it bundles, at the version `packages/deploy-checks/src/pdfjs.ts` pins and the installed unpdf carries (`pnpm check:images` and its tests hold the three together). `pdfjs.LICENSE` is the license files unpdf ships in `dist/licenses/` (pdf.js's Apache-2.0, its decoders' wrappers' Apache-2.0 and BSD-2-Clause, PDFium's JBIG2 BSD-3-Clause and OpenJPEG's BSD-2-Clause), read 2026-11-21.
