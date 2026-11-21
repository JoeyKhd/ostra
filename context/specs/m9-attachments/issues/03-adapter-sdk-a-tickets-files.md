# 03: Adapter SDK: a ticket's files

Status: ready-for-agent
Builder: adapters
Blocked by: none
Features: F-149
Packages: `packages/adapter-sdk` (the tracker base and capabilities, the Jira fake, the tiny adapter, the tracker suite), `packages/adapters/adapter-linear` (declares `ticketFiles: "images"` until ticket 08)
Spec: `../spec.md`, sections 5.2 and 6; ADR 0070

## What to build

- **Capability:** `ticketFiles: "all" | "images" | "none"` on `TrackerCapabilities`, declared by every tracker adapter in the same commit: the Jira fake `all`, the tiny adapter `none`, Linear `images` until ticket 08 makes it `all`.
- **`TicketContext.files`:** `TicketContextFile[]` (`{ url, name, contentType, size, where, commentId, byOstra }`), in the order section 5.2 gives, each URL once, files the tracker holds only. `images` stays, the image subset. Linear fills `files` from its images until ticket 08.
- **`filesInText(markdown)`** on the base class: `[]` unless overridden.
- **The Jira fake:** attachments with `mimeType`, `size` and a content URL, ADF `mediaSingle` and `media` nodes pointing at them in the description and a comment, a link attachment, a comment by ostra's app user holding a file, and `filesInText` over ADF text. Its `downloadFile` serves its content URLs only.
- **The tracker contract suite** gains section 5.2's cases. The adapter guide's samples (`adapter-guide-samples.test.ts`) and `docs` for adapter authors name the capability.

## Done when

- [ ] Tests named for `F-149/c6`: the suite's cases pass for the Jira fake and the tiny adapter, and for Linear's `images` (break-it: return ostra's own comment's file, and the `byOstra` case fails).
- [ ] Tests named for `F-149/c1`: a link attachment isn't in `files`; a download over `maxBytes` reads no more and is refused; a URL off the file host gets no credential.
- [ ] Checks for `packages/adapter-sdk` and the tracker adapters pass (spec section 10).
- [ ] Committed as `✨ add a ticket's files to the tracker contract`.

## Comments
