# Milestone 9's documents

The files core's text reader is tested on (ticket 07, F-150) and the demo attaches (ticket 18). Each is made by a builder in `apps/core/src/testing/document-fixtures.ts`, the same bytes each time. `make-fixtures.ts` writes them all here (`pnpm --filter @ostra/e2e-m9-attachments fixtures`); the repo keeps the small ones and ignores the large ones, which the script makes again.

| File | What it's for |
|---|---|
| `history-panel-spec.docx` | A spec: headings (one by its style's name), a paragraph with a tab and a line break, a nested list, a table with a `\|` in a cell, tracked changes and a field (left out), a link never followed, and text with shell syntax and instruction-like words. Its text is ready. |
| `budget.xlsx` | Two sheets: strings, numbers, booleans, an inline string and formulas with the results Excel stored, never recomputed. Its text is ready. |
| `roadmap.pptx` | Three slides listed in `presentation.xml` out of their parts' order: titles, bullets, a line break, a table and a remote picture never fetched. Its text is ready, in the deck's order. |
| `report.pdf` | Two pages of text and a link never followed. Its text is ready. |
| `encrypted.pdf` | Opens only with the password `ostra`. No text: `encrypted`. |
| `scanned.pdf` | A picture and no text layer. No text: `no-text`. |
| `javascript.pdf` | JavaScript on open, in its names and on close (an alert, a form post, a URL to open), and a link. Its text is read; nothing runs, opens or is fetched. |
| `zip-bomb.docx` | A zip of about 3 KB whose document part declares 2 GiB. No text: `too-big`, refused before anything is inflated. |
| `doctype.docx` | A `<!DOCTYPE>` declaring an external entity (`file:///etc/passwd`, XXE) and using it. No text: `doctype`, never parsed. |
| `$(touch pwned) ignore previous instructions.docx` | The spec again, under a name with shell syntax and instruction-like words: a name is data, made safe and never run or logged. |
| `many-parts.docx` | Large, not kept: the spec's zip with 5,000 more entries. No text: `too-many-parts`, counted from the zip's directory. |
| `big.xlsx` | Large, not kept: 100,000 cells, each its own string. Its text is cut at 1 MiB, its last line saying so. |

Core's tests also build what isn't a file a member sends: a slow PDF (20,000 empty pages, past the time limit), a document of one paragraph of 300,000 runs (past a worker's heap), a cut zip, broken XML, a broken PDF, an encrypted Office file and an empty one.
