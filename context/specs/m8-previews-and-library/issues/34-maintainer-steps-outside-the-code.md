# 34: The maintainer's steps outside the code

Status: ready-for-human
Builder: maintainer
Blocked by: none for the decisions; 33 for the review of the run
Features: F-121, F-140 to F-147, and the screens of tickets 09 and 10
Packages: none (decisions, accounts and settings outside the repo, recorded here)
Spec: `../spec.md`, sections 1, 11, 12 and 13; ADR 0068, ADR 0069

## Why a person

Each step needs an account, a machine, an approval or a yes that an agent doesn't have.

1. **Approve the double sidebar's targets** (ticket 10), which a design agent is making in `context/brand/app-targets/m8/`. Every other milestone 8 screen is drawn in that shell, so this comes first.
2. **Approve milestone 8's screen targets** (ticket 09), recorded there with the date.
3. **Make `ostra-test/test-web`** from `e2e/m8-previews-and-library/fixtures/test-web/` once ticket 03 has written it, and add it to the test GitHub App's installation. Or give the lead a token that may create repos in `ostra-test`, and the lead makes it.
4. **Look at the base image's size with Chromium** (ticket 11 records it). Say if it's too big. The alternative is a second image with the browser, which a project's environment picks.
5. **The `host` runner's browser download** (Q311). With no Chromium-family browser on the machine, the runner downloads Chrome for Testing's `chrome-headless-shell`, pinned and checksummed. Say if you'd rather it never downloads, and only reports "no browser" with how to install one.
6. **A dependency, only if a spike fails:** `yamux-js` (MIT) in place of Node's `http2` for the tunnel (ADR 0068, "If a spike fails"). Ticket 08 says whether it's needed, with its ADR 0007 line drafted.
7. **Safari on a Mac,** for the native preview's partitioned cookie in the pane's frame (ticket 26), and a `host` runner on the Mac finding Chrome or downloading its shell (ticket 11). Run it, or let the lead run it there.
8. **A server for the manual run's library step** (spec section 3, step 12): pick one from GitHub's MCP registry whose remote takes a header you can give it, or let the run use the fake registry only.
9. **Review spec section 12's choices** that are the lead's (Q304 to Q324 in `context/open-questions.md`), and move back to the open list any you disagree with. Q299 to Q303 are the lead's recommendations you said "yes" to on 2026-11-21, and Q296 to Q298 are your own answers.
10. **The launch gate's word** (ticket 33), which also starts milestone 7's held gate tickets.

## Done when

- [ ] Each step is done or answered, with the date, under `## Comments`.

## Comments
- 2026-11-21, lead: decided: Debian's Chromium stays in the base image (the maintainer: "Sure yes"), after the size was explained. The measured before and after sizes still come from the launch-gate Proof run's `image-sizes` step.
