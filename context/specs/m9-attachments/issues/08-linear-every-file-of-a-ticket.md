# 08: Linear adapter: every file of a ticket

Status: done
Builder: adapters
Blocked by: 03
Features: F-149
Packages: `packages/adapters/adapter-linear`, `packages/adapter-sdk/src/testing/fake-linear/`
Spec: `../spec.md`, sections 5.2 and 6; ADR 0070

## What to build

- **`ticketFiles: "all"`.**
- **`files` in `getTicketContext`:** besides the images `#imagesOf` finds today, a markdown link (`[name](url)`, `<url>`) to Linear's file host in the description and in each comment, and every attachment whose URL is on the file host, each once, in section 5.2's order. The name comes from the link's text or the attachment's title when it's a plain file name, else the URL's last segment; it's untrusted, and core makes it safe. A file in ostra's own progress comment, or in a comment by ostra's app user, is `byOstra`; so is an attachment whose subtitle carries `attachFile`'s marker (F-099). An attachment off the file host (a pull request, Figma, Sentry) stays a link in `attachments` and never enters `files`.
- **`filesInText(markdown)`**: the same reading over a follow-up's comment.
- **The readers stay linear in their input,** as `markdown-images.ts`'s do, and nothing they find is run.
- **The fake Linear** gains what spec section 9 lists: uploads inline and attached, a file link that isn't an image, a link attachment, ostra's comment with a picture, a download that fails on demand, a 12 MiB file, and an agent session whose `prompted` comment holds a file.
- **The live test** (`linear-adapter.live.test.ts`, run only when its variables are set): a test ticket's files listed and one downloaded.

## Done when

- [x] Tests named for `F-149/c1,c6`: the tracker suite's cases pass for Linear; a `.docx` link in the description, an attached PDF and a comment's `.xlsx` are files, in order; ostra's comment's picture and a link attachment aren't (break-it: drop the file-host check, and the Figma case fails).
- [x] Tests named for `F-149/c9`: `filesInText` finds a follow-up's file, and a link off the file host is ignored.
- [x] Checks for `adapter-linear` and `adapter-sdk` pass (spec section 10).
- [x] Committed as `✨ read every file of a Linear ticket`.

## Comments

- 2026-11-21, adapters: committed as `✨ read every file of a Linear ticket`, on ticket 03's `01d5a998`. What it holds:
  - **Linear declares `ticketFiles: "all"`.** `files` reads, in order, the description's and then each comment's images, links (`[name](url)`) and autolinks (`<url>`) on Linear's file host, then every attachment whose URL is on it, each URL once; `filesInText` reads a follow-up the same way. A link anywhere else (a pull request, Figma, a URL in the text) is never a file, and nothing fetches it. `byOstra` comes from ticket 03's `OwnWrites`: a comment by ostra's user or holding its marker, an attachment whose subtitle holds `attachFile`'s.
  - **The readers** (`markdown-images.ts`): `markdownFiles` beside `markdownImages`, on the same kind of bounded pattern (no nested quantifiers; a hostile text of 240,000 characters reads in under a second). A URL shown both as a link and as an image is an image. `fileName` names a file by its link text or attachment title when that's a plain file name, else by the URL's last segment, decoded when it can be; `imageName` is now `fileName` with `image` as its fallback.
  - **The fake Linear:** `failNextDownload` (an upload's next download answers 500, once) beside ticket 03's `upload`, `uploadEndless`, `attachToIssue` and `addComment`'s author. A 12 MiB file is an `upload` of 12 MiB, and an agent session's `prompted` comment holds whatever its body links, so neither needed more.
  - **Tests** (`linear-adapter.test.ts`): the suite's `F-149` cases now run Linear's `all` path on both the app token and an API key; `F-149/c1,c6` (a `.docx` link and an autolinked image in the description, a comment's `.xlsx`, an attached PDF, in order and named; ostra's picture `byOstra`; a Figma attachment, a PR link and a URL in the text never files; each file downloaded once), `F-149/c6` (the app user's comment without a marker, and `attachFile`'s marker), `F-149/c9` (a follow-up's screenshot and document from a real `prompted` event, the off-host link left out), and `F-149/c1` (12 MiB refused at 10 MiB; a failed download is `unavailable`, and the next try gets the file).
  - **The live test:** `F-149/c1` in `linear-adapter.live.test.ts` uploads a `.txt` linked in a description and an attached PNG, adds a Figma link attachment, lists the two files (and not the link) and downloads the first byte for byte. Run once against `ostra-test` (team `OST`) on 2026-11-21: passed, and its ticket was archived. Linear's real upload URLs carry no extension, so a file's name comes from its link text or attachment title there.
  - No break-it pass, under the maintainer's 2026-11-21 change. Checks: typecheck and lint of `packages/adapter-sdk` and `adapter-linear`; tests of `adapter-linear`, the fake Linear's and `adapter-notify-tracker`.
