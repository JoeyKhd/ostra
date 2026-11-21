# 03: Adapter SDK: a ticket's files

Status: done
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

- [x] Tests named for `F-149/c6`: the suite's cases pass for the Jira fake and the tiny adapter, and for Linear's `images` (break-it: return ostra's own comment's file, and the `byOstra` case fails).
- [x] Tests named for `F-149/c1`: a link attachment isn't in `files`; a download over `maxBytes` reads no more and is refused; a URL off the file host gets no credential.
- [x] Checks for `packages/adapter-sdk` and the tracker adapters pass (spec section 10).
- [x] Committed as `✨ add a ticket's files to the tracker contract`.

## Comments

- 2026-11-21, adapters: committed as `✨ add a ticket's files to the tracker contract`. What it holds:
  - **The contract** (`packages/adapter-sdk/src/tracker/`): `ticketFiles` (`TicketFilesCapability`, `ticketFilesCapabilities`), `TicketContext.files` of `TicketContextFile`, `filesInText` on the base class (`[]` unless overridden), and helpers every adapter composes: `ticketFileList` (each URL once, the first place shown winning), `filesForCapability`, `isImageFile`, `isOwnComment` and `isOwnAttachment`. `downloadFile`'s doc says what every adapter owes: the credential to the file host only, no redirect, nothing read past `maxBytes`.
  - **Decision: how an adapter knows ostra's own writes.** The progress comment's marker and `attachFile`'s marker are core's (`packages/domain`), which an Apache-2.0 package can't import, and an API-key connection has no app user to compare. So `getTicketContext` takes an optional third argument, `options.own: OwnWrites` (`userId`, `commentMarkers`, `attachmentMarkers`), as `parseWebhook` already takes `ownUserId`: core passes its user and markers (ticket 12), the adapter compares, and without it no file is `byOstra`. Additive: every caller with two arguments is unchanged.
  - **The suite** (`testing/tracker-suite.ts`): six cases, keyed `F-149/c6` (the declaration; the files in order per capability, each downloadable, another organization reading none; `byOstra` by marker, by ostra's user alone, by `attachFile`'s marker, and none without `OwnWrites`), `F-149/c1` (a link attachment never a file; a download within `maxBytes`, one byte over refused, an endless body refused, and a URL on a recording host of the suite's own refused with no credential sent) and `F-149/c9` (`filesInText`). The fixture's `files` hooks (`TrackerFilesHooks`) seed a ticket as a person makes one; `defineTrackerFilesSuite` runs the cases alone for an adapter outside the full suite.
  - **The Jira fake** declares `all`: attachments with `mimeType`, `size` and their author, `media` nodes of type `file` naming them in ADF (`adfToMarkdown` takes a resolver, optional, so its callers are unchanged), a web link, ostra's comment and attachment, `filesInText`, and `downloadFile` refusing anything off `https://jira-fake.invalid/secure/attachment/`.
  - **The tiny tracker** declares `none`, and now reads a seeded ticket's text with `files: []` (`seedTicket`), so the `none` cases run on a real context.
  - **Linear** declares `images`: `files` from the images it showed before, with where, comment and `byOstra`; `filesInText` the same. The fake Linear gains `upload`, `uploadEndless`, `attachToIssue` and `addComment`'s author, and `linearFilesHooks`. Ticket 08 makes it `all`.
  - **Docs:** the adapter guide's "The tracker kind: a ticket's files", with a `TrackerCapabilities` sample the guide test compiles, and fails without `ticketFiles`.
  - Core's cached context (`apps/core/src/tracker/context.ts`) carries `files: []`. No break-it pass, under the maintainer's 2026-11-21 change. Checks: typecheck of `packages/adapter-sdk` and every package that depends on it (`e2e/dev-tools` fails on `main` already, on `InvitationMailInput.address`, untouched here); lint of `packages/adapter-sdk`, `adapter-linear` and `apps/core`; tests of `packages/adapter-sdk`, `adapter-linear` and `adapter-notify-tracker`.
