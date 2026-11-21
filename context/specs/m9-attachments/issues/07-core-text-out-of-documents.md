# 07: Core: the text out of documents

Status: done
Builder: core
Blocked by: none
Features: F-150
Packages: `apps/core/src/files/text/` (new), `apps/core/package.json`, `pnpm-lock.yaml`, `e2e/m9-attachments/fixtures/` (new), `context/decisions/0007-web-app-libraries.md`
Spec: `../spec.md`, sections 5.5 and 11; ADR 0070; `research/attachments-for-agents.md` §5

## What to build

- **The dependencies,** exact, in `apps/core/package.json` with the lockfile: `unpdf` 2.2.1, `fflate` 0.8.3, `@xmldom/xmldom` 0.9.12. ADR 0007 gets a "Milestone 9" table with the three, each with what it's for, its license and its fallback (spec section 11). The core image's notices list them (`packages/deploy-checks`), and `unpdf`'s notice names the pdf.js it bundles.
- **`extractText(bytes, kind, limits)`** and the worker pool, as section 5.5 says: two workers, 256 MiB of heap each, 30 s a file, a terminated worker replaced, `busy` after 30 s of waiting. Every limit is a named working value in one place.
- **The Office reader** (`.docx`, `.xlsx`, `.pptx`) on `fflate` and `@xmldom/xmldom`, and **the PDF reader** on `unpdf`, each with section 5.5's parts, options, refusals and output.
- **The fixtures** of section 5.5 in `e2e/m9-attachments/fixtures/` (a `package.json` for the new e2e package, Sustainable Use, and a script that generates the large ones), and a short `README.md` listing each fixture and what it's for.
- **Nothing in a document runs or is fetched:** no macro, no script, no external part, no font, no link followed; the tests assert no network call is made (a fetch that throws).

## Done when

- [x] Tests named for `F-150/c1`: each kind's fixture gives its text in the shape section 5.5 says (headings, lists, tables, sheets, slides, pages), headed by ostra's line, and a long one is cut at 1 MiB with its last line.
- [x] Tests named for `F-150/c2`: the zip bomb is refused as `too-big` without inflating it; the 5,000-entry zip as `too-many-parts`; the DOCTYPE `.docx` as `doctype`; the PDF with JavaScript gives its text and runs nothing; a fixture that loops past the time limit is `timeout` and the pool takes the next file; a file over the heap is refused and the pool lives on; no fetch happens (break-it: lift the declared-size check, and the bomb case fails).
- [x] Tests named for `F-150/c3`: the encrypted PDF is `encrypted`, the scanned one `no-text`, a damaged zip `damaged`; none throws.
- [x] Tests named for `F-150/c5`: `pnpm check:licenses` and the core image's notices check pass with the three packages; the runner's package and image depend on none of them.
- [x] Tests named for `F-150/c6`: no extracted text or file name reaches a log line, checked by value.
- [x] Checks for the whole repo pass (spec section 10: untrusted input).
- [x] Committed as `✨ read the text out of documents in core`.

## Comments

- 2026-11-21, core: built as `✨ read the text out of documents in core`. `apps/core/src/files/text/`: `createDocumentTextReader({ extraction, logger })` once per core process, then `read({ bytes, contentType, name })` for each file as it comes in, answering `none`, `off`, `ready` (`markdown`, `words`, `truncated`) or `failed` with the reason (`encrypted`, `damaged`, `too-big`, `too-many-parts`, `doctype`, `timeout`, `no-text`, `busy`); it never throws. `ready` and `failed` fit the domain's `TextReading`, so ticket 10 passes them to `fileTextOf`; `extraction` is `settings.files.textExtraction` (ticket 05). The working values are in `limits.ts`. Readings and differences:
  - **Sheets are Markdown tables,** not tab-separated rows: the lead's brief to this ticket asked for Markdown tables from `.xlsx` and `.docx`. Spec section 5.5 and ADR 0070 now say so.
  - **pdf.js 6.5.438 has no `eval` path left,** and its `isEvalSupported` option is gone with it, so the reader can't pass it. It passes `useWasm: false` (no WebAssembly compiled from a document's functions), `disableFontFace`, `useSystemFonts: false`, no range, stream or auto fetch, no XFA, no image decoder, and no URL for fonts, CMaps or decoders, so there is nothing to fetch. pdf.js runs as its own "fake worker" on the text worker's thread. Spec section 5.5 and ADR 0070 now say so.
  - **Big parts in batches:** one xmldom DOM of the 100,000-cell workbook passed even a 256 MiB worker, so a body's blocks, a sheet's rows and the shared strings are parsed a batch (about 256K characters) at a time, inside copies of their ancestors' start tags; reading stops once the text passes 1 MiB. The workbook now reads within 64 MiB. A single block past the heap (a paragraph of 300,000 runs) is `too-big`, and the pool goes on.
  - **The worker** imports only the readers and their three libraries, starts when the first document comes (none with extraction off), and runs with `env: {}`, no flags, its stdout and stderr dropped, its console silenced and `fetch`, `WebSocket`, `EventSource` and `XMLHttpRequest` sealed to throw and be counted (`refusedCalls`, 0 in every test). A DOCTYPE or ENTITY anywhere in a part read is refused before xmldom sees it. A password-protected Office file (an OLE file with an `EncryptedPackage`) is `encrypted`. A slide is parsed whole: slides are small.
  - **The slow fixture** is a PDF of 20,000 empty pages: pdf.js walks its page tree for each, about 45 s here, so the test pool's 2 s always stops it.
  - **The fixtures** are built by `apps/core/src/testing/document-fixtures.ts` (exported as `@ostra/core/testing/document-fixtures`), so core's tests make them in memory; `e2e/m9-attachments/fixtures/make-fixtures.ts` writes them, the repo keeps the ten small ones (each under 5 KB) and ignores `many-parts.docx` and `big.xlsx`, and a test holds the kept ones to the builders' bytes.
  - **Notices:** unpdf is MIT and pnpm lists it under its own name, but its `dist/` bundles pdf.js and its decoders, so the server image's notices add `deploy/notices/pdfjs.json` (pdf.js 6.5.438, `Apache-2.0 AND BSD-2-Clause AND BSD-3-Clause`, with every license file unpdf ships in `dist/licenses/`). `pnpm check:images` holds the Dockerfile and the notice to `PDFJS_IN_UNPDF` (`packages/deploy-checks/src/pdfjs.ts`), and its test holds that to the installed unpdf. ADR 0007's milestone 9 table was already there.
  - **Installed licenses:** `unpdf@2.2.1` MIT, `fflate@0.8.3` MIT, `@xmldom/xmldom@0.9.12` MIT, none with a dependency; the runner's and the base image's installs hold none of them.
  - **F-150/c4** has a test here too: with the setting false, no worker starts and a document's text is `off`. F-150 is `building` until tickets 10, 12, 13, 15 and 16 land.
  - **Checks:** the whole repo's typecheck and lint, the tests of `apps/core`, `packages/deploy-checks`, `e2e/m9-attachments` and the root scripts, `pnpm check:licenses`. No break-it pass was run (the lead's rules).
