# 07: Core: the text out of documents

Status: ready-for-agent
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

- [ ] Tests named for `F-150/c1`: each kind's fixture gives its text in the shape section 5.5 says (headings, lists, tables, sheets, slides, pages), headed by ostra's line, and a long one is cut at 1 MiB with its last line.
- [ ] Tests named for `F-150/c2`: the zip bomb is refused as `too-big` without inflating it; the 5,000-entry zip as `too-many-parts`; the DOCTYPE `.docx` as `doctype`; the PDF with JavaScript gives its text and runs nothing; a fixture that loops past the time limit is `timeout` and the pool takes the next file; a file over the heap is refused and the pool lives on; no fetch happens (break-it: lift the declared-size check, and the bomb case fails).
- [ ] Tests named for `F-150/c3`: the encrypted PDF is `encrypted`, the scanned one `no-text`, a damaged zip `damaged`; none throws.
- [ ] Tests named for `F-150/c5`: `pnpm check:licenses` and the core image's notices check pass with the three packages; the runner's package and image depend on none of them.
- [ ] Tests named for `F-150/c6`: no extracted text or file name reaches a log line, checked by value.
- [ ] Checks for the whole repo pass (spec section 10: untrusted input).
- [ ] Committed as `✨ read the text out of documents in core`.

## Comments
