// Milestone 9 (ticket 07, F-150/c5, ADR 0070): core reads PDFs' text with unpdf, which bundles
// Mozilla's pdf.js and its decoders in its own files instead of depending on `pdfjs-dist`, so pnpm's
// report lists unpdf (MIT) and not them. The server image's THIRD_PARTY_NOTICES names them through
// `deploy/notices/pdfjs.json`. `pnpm check:images` holds the server's Dockerfile and that notice to
// this pin, and its tests hold this pin to the unpdf core installs. Bumping unpdf: its version and
// the pdf.js it bundles here, and the notice's version, in one change.

export const PDFJS_IN_UNPDF = {
  /** The unpdf `apps/core` pins. */
  unpdf: "2.2.1",
  /** The pdf.js it bundles (`dist/pdfjs.mjs`'s API version). */
  pdfjs: "6.5.438",
  /** pdf.js's license, its decoders' wrappers' and the decoders' own, as unpdf ships them in `dist/licenses/`. */
  license: "Apache-2.0 AND BSD-2-Clause AND BSD-3-Clause",
} as const;

/** Where the server image's build finds the notice, and the flag that adds it. */
export const PDFJS_NOTICE_EXTRA = "--extra /opt/notices/extra/pdfjs.json";
