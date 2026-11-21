# Attachments for agents: what OpenCode takes, and how to read documents

**Asked by:** milestone 9's spec (`specs/m9-attachments/`, ADR 0070), 2026-11-21. The maintainer: "add image support and file support to our chat text box thing", and "in the linear/jira ticket screenshots, docx anything should be added as context".

**The questions:**
1. Does OpenCode 2.3.2 take ACP `image` content blocks in `session/prompt`, and pass them to the model in both API formats ostra configures (Anthropic Messages and OpenAI-compatible)?
2. What does it do with `resource` and `resource_link` blocks for files?
3. If images can't go over ACP, can the agent open an image from disk with its read tool?
4. Which pure-JS libraries can read the text out of `.docx`, `.pdf`, `.xlsx` and `.pptx`, under licenses `pnpm check:licenses` and the images' notices accept?

**How it was read.** OpenCode's repo was cloned at the tag `v2.3.2` into a folder of its own and read, never built or run, the same way `research/opencode-reasoning-effort.md` and `research/opencode-subagents.md` read it. ostra's code was read at `origin/main` `9704dcd3`. The npm registry was asked with `npm view <package> version license dependencies peerDependenciesMeta engines time` on 2026-11-21. Nothing here was run against a model: every OpenCode behaviour below is **read from source**, and ticket 08 of milestone 9 checks the ones the design rests on against the pinned binary with the stub models.

## Sources

| Key | Source |
|---|---|
| [OC] | OpenCode at tag `v2.3.2`, commit `c0ad18b402eb2827fc1ee71c171b1177b3fc02d1`, `https://github.com/anomalyco/opencode`. Paths are under `packages/` |
| [OST] | ostra at `9704dcd3` (`origin/main`, 2026-11-21) |
| [NPM] | The npm registry, `npm view`, read 2026-11-21 |

## Findings

### 1. Images over ACP: yes, on both API formats, once the model says it takes images

- **OpenCode advertises images.** Its `initialize` answer has `promptCapabilities: { embeddedContext: true, image: true }`, and no `audio` ([OC] `cli/src/acp/service.ts:138`).
- **An `image` block with `data` becomes a file part** with a `data:` URL; one with only a `uri` is treated as a `resource_link` ([OC] `cli/src/acp/content.ts:28-34`). The block's `mimeType` isn't trusted: the server sets `mime: undefined` for a data URL and detects the type from the bytes ([OC] `core/src/session/prompt.ts:112-126`), knowing PNG, JPEG, GIF, BMP, PDF, WebP, AVIF, HEIC, MP4, text and octet-stream ([OC] `core/src/mime.ts:3-43`).
- **What reaches the model.** A PNG, JPEG, GIF or WebP, and a PDF, become a media part, after an `Attached file: <path>` line when the file came from disk; plain text is inlined; **anything else is dropped without a word** ([OC] `core/src/session/runner/to-llm-message.ts:20`, `63-71`).
- **Both API formats send real images.** The Anthropic Messages protocol sends `image { source: { type: "base64", media_type, data } }`, and a PDF as a `document` ([OC] `ai/src/protocols/anthropic-messages.ts:704-718`). The OpenAI Chat protocol sends `image_url { url: <data URL> }`, and a PDF as `file { filename, file_data }` ([OC] `ai/src/protocols/openai-chat.ts:466-482`); the OpenAI-compatible route reuses it whole ([OC] `ai/src/protocols/openai-compatible-chat.ts:1-20`). ostra's config names `@opencode/ai/providers/anthropic-compatible` and `@opencode/ai/providers/openai-compatible` ([OST] `packages/adapters/adapter-opencode/src/config.ts:26-29`).
- **But only for a model whose capabilities list images.** Before each request OpenCode maps a part's type to `image`, `audio`, `video` or `pdf`, and when the model's `capabilities.input` has no entry starting with it, replaces the part with the text `ERROR: Cannot read "<name>" (this model does not support image input). Inform the user.` ([OC] `core/src/session/model-request.ts:139-164`). It reads `modalities.input` from the catalog, and **a catalog entry without `modalities` defaults to `{ input: ["text"], output: ["text"] }`** ([OC] `core/src/models-dev/v1.ts:135`). The config's `capabilities.input` wins over the catalog's when given ([OC] `core/src/model.ts:32-41`). models.dev's `attachment` flag is read nowhere.
- **ostra's catalog entry has no `modalities` today** ([OST] `packages/adapters/adapter-opencode/src/config.ts:273-290`), and its config model sets only `name`, `limit` and `capabilities.reasoning` ([OST] same file, `203-208`). **So every model ostra runs is text-only to OpenCode now:** an image sent in a prompt would arrive as the error text, and so does an image the read tool returns (finding 3). This is also why F-064's ticket images, written under `.ostra/ticket/` since milestone 2, have never been seen by a model as pictures: the agent can open the file, and the model gets the error text instead (**inferred** from the two reads above; ticket 08 checks it on the binary). The fix is to write the model's real input modalities into both the catalog entry and the config.
- **Mid-turn steering takes images too.** `_session/steering` runs the same `ACPPrompt.prepare` as a prompt, and submits its files with `delivery: "steer"` ([OC] `cli/src/acp/turn.ts:433-447`).
- **Size.** A prompt attachment over 20 MiB fails the whole prompt with `InvalidRequestError` ([OC] `core/src/session/prompt.ts:120-124`, `224`). PNG, JPEG, GIF, WebP and BMP are resized to fit 2000×2000 and 5 MiB of base64 by default ([OC] `core/src/image.ts:63-68`), configurable as `media.image.{auto_resize, max_width, max_height, max_base64_bytes}` ([OC] `schema/src/config/media.ts:6-15`). Once a request's inline images pass 25 MiB, the oldest are replaced by a note until 15 MiB remain ([OC] `core/src/session/model-request.ts:50-53`).

### 2. `resource_link` and `resource`: OpenCode reads the file itself, past its permission check

- **`resource_link` with `file://`** becomes a file part that OpenCode reads from disk itself: the bytes are inlined, a folder is listed, and `?start=&end=` picks lines ([OC] `cli/src/acp/content.ts:138-158`; `core/src/session/prompt.ts:172-222`). Any other scheme becomes the text `[name](uri)`.
- **No `external_directory` check on that path.** The prompt's file read never asks the permission service, where the read tool goes through `authorizeRead` ([OC] `core/src/session/prompt.ts:172-222`; `core/src/tool/plugin/read.ts:117`; `core/src/file-access.ts:139-157`). A link outside the project is read anyway.
- **A `.docx` or any other type it can't name is dropped silently** (finding 1, `to-llm-message.ts:63-71`), so a link does nothing for a document but put its bytes in the session.
- **An embedded `resource`** with `text` becomes a text part; with `blob` and a `mimeType`, a data-URL file part; with a blob and no type, nothing ([OC] `cli/src/acp/content.ts:37-63`). Unknown block types and `audio` are dropped ([OC] same, `64-65`).

**So the design sends no `resource_link`:** files are written to disk by ostra's runner, named in the prompt's text, and opened by the agent with its own tools, under its own permissions. Only images go as content, as `image` blocks with `data`.

### 3. The read tool shows an image or a PDF to a model that takes them

- The read tool detects PNG, JPEG, GIF, WebP and PDF from the bytes and refuses one over 20 MiB ([OC] `core/src/tool/read-filesystem.ts:15-22`, `143-155`).
- It answers `Image read successfully` or `PDF read successfully` with the file as a data-URL part ([OC] `core/src/tool/plugin/read.ts:349-363`); images are resized as prompt images are, and one it can't decode becomes `[N images omitted…]` ([OC] `core/src/tool.ts:99-124`).
- For a model without that input, the same error text replaces the part in the tool's result ([OC] `core/src/session/model-request.ts:183-191`). OpenAI Chat sends a tool's image as a following user message ([OC] `ai/src/protocols/openai-chat.ts:618-619`, `744`).
- **So the fallback works:** where an agent can't take images in its prompt, the file on disk and its path in the text are enough for a vision model, once the catalog says so (finding 1). The read tool honours `external_directory`, which ostra allows for the workspace's root ([OST] `packages/adapters/adapter-opencode/src/config.ts:95-100`, commit `ec0e3482`).

### 4. What comes back on ostra's event stream

- **A live turn doesn't echo the prompt.** OpenCode's live translator has no user-message case ([OC] `cli/src/acp/translate.ts:132-142`).
- **`session/load` replays the history** as `user_message_chunk`s, images as full base64 ([OC] `cli/src/acp/replay.ts:43-55`). ostra's mapper drops `user_message_chunk` ([OST] `packages/adapter-sdk/src/agent/acp/map.ts:567`), so none reaches the event log.
- **A tool's image comes back in `tool_call_update`** as `{ type: "image", mimeType, data }` ([OC] `cli/src/acp/tool.ts:111-120`, `152-157`). ostra maps a `read` call to its line count alone ([OST] `packages/adapter-sdk/src/agent/acp/map.ts:231-234`), so an image the agent reads adds no base64 to the event log either.
- **The session keeps the images.** A user message stores its files as base64 ([OC] `schema/src/prompt.ts:31-38`), and `opencode session export` writes them inline ([OC] `core/src/session/transfer.ts:58-64`); only `--sanitize` blanks them ([OC] `transfer.ts:247-257`), which ostra doesn't pass. So a session archive (ADR 0039) grows by each image as resized, at most 5 MiB of base64 each, against `OSTRA_BLOB_MAX_MIB` (64). An archive over it falls back to the rebuild template, as ADR 0043 already says.

### 5. Libraries for the text in documents

What each candidate is, on [NPM] on 2026-11-21:

| Package | Version | License | Dependencies | Notes |
|---|---|---|---|---|
| `unpdf` | 2.2.1 (2026-11-15) | MIT | none; `pdfjs-dist` and `@napi-rs/canvas` are optional peers | unjs's wrapper around a serverless build of Mozilla's pdf.js (Apache-2.0), which it bundles. Node ≥ 24, as ostra is (`package.json` `engines.node` `>=24.2`). Releases every few weeks since 1.9 (2026-10-15) |
| `fflate` | 0.8.3 (2026-07-20) | MIT | none | Pure-JS zip and deflate. Its `unzipSync` takes a filter that sees each entry's name and declared size before inflating it |
| `@xmldom/xmldom` | 0.9.12 (2026-08-23) | MIT | none | A W3C DOM parser for XML, pure JS |
| `mammoth` | 1.13.0 (2026-09-26) | BSD-2-Clause | `jszip`, `@xmldom/xmldom` ^0.8.6, `lop`, `argparse`, `underscore`, `xmlbuilder`, `base64-js`, `dingbat-to-unicode` | The usual `.docx` reader. **`jszip` is `(MIT OR GPL-3.0-or-later)`** |
| `officeparser` | 8.9.0 (2026-11-18) | MIT | `pdfjs-dist`, `tesseract.js`, `file-type`, `fflate`, `@xmldom/xmldom` | Reads every Office format and PDFs, and OCRs with `tesseract.js` |
| `pdf-parse` | 2.4.5 (2025-10-29) | Apache-2.0 | `pdfjs-dist` 5.4.296, `@napi-rs/canvas` 0.1.80 | A native module in its dependencies |
| `pdfjs-dist` | 6.5.438 (2026-11-01) | Apache-2.0 | — | The official build; usable directly, larger, and a legacy build for Node |

- **ostra's license lists** ([OST] `scripts/known-licenses.ts`): permissive ids are Apache-2.0, MIT, BSD-2-Clause, BSD-3-Clause, ISC and 0BSD; an image may bundle a few more (Zlib, MPL-2.0 and others). The images' notices check accepts a package's license expression only when **every** id in it is known (`isKnownBundledLicense`, `licenseIds` splits on AND, OR and WITH), so `jszip`'s `GPL-3.0-or-later` alternative fails it, and with it `mammoth`.
- **`officeparser`** brings `tesseract.js`, an OCR engine that loads its language data at run time, which is an outbound fetch ADR 0021 doesn't allow, and a large dependency for text ostra doesn't need.
- **`pdf-parse`** depends on `@napi-rs/canvas`, a native module per platform.
- **`.docx`, `.xlsx` and `.pptx` are zips of XML** (Office Open XML, ECMA-376): a document's text is in `word/document.xml` (`w:p` paragraphs of `w:r` runs of `w:t` text, `w:tbl` tables), a workbook's in `xl/sharedStrings.xml` and `xl/worksheets/sheet<n>.xml` named by `xl/workbook.xml`, a deck's in `ppt/slides/slide<n>.xml` (`a:t`). Reading their text needs only an unzip and an XML parser, which `fflate` and `@xmldom/xmldom` are, with no dependency of their own (**inferred** from the formats; ticket 06's fixtures check each).

**So the design takes three packages,** all MIT with no dependencies: `unpdf` for PDFs, and `fflate` with `@xmldom/xmldom` under ostra's own small Office reader. They run in core only, so the runner's image doesn't grow (ADR 0070).

## What this doesn't answer

- **How a real Anthropic or OpenAI-compatible endpoint behind the key proxy takes these blocks.** Read, not run. Ticket 08 sends an image through the binary to the stub models in both formats, and the launch gate's demo sends one to a real model.
- **Whether a model's own image limits** (Anthropic's long edge, an endpoint's request size) bite below OpenCode's 2000×2000 and 5 MiB. OpenCode's resize stays as it is until a run shows otherwise.
- **Scanned PDFs** have no text layer. Without OCR their extracted text is empty, and the agent gets the PDF itself, which a model that takes PDFs reads through the read tool (finding 3).
