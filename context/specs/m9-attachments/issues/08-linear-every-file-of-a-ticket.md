# 08: Linear adapter: every file of a ticket

Status: ready-for-agent
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

- [ ] Tests named for `F-149/c1,c6`: the tracker suite's cases pass for Linear; a `.docx` link in the description, an attached PDF and a comment's `.xlsx` are files, in order; ostra's comment's picture and a link attachment aren't (break-it: drop the file-host check, and the Figma case fails).
- [ ] Tests named for `F-149/c9`: `filesInText` finds a follow-up's file, and a link off the file host is ignored.
- [ ] Checks for `adapter-linear` and `adapter-sdk` pass (spec section 10).
- [ ] Committed as `✨ read every file of a Linear ticket`.

## Comments
