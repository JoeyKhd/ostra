# 51: The maintainer's steps outside the code

Status: ready-for-human
Builder: maintainer
Blocked by: none for the decisions; 39 and 47 for the GitHub link (step 3); 50 for steps 6 and 7
Features: F-115, F-119, F-053, and the screens of ticket 41
Packages: none (decisions and settings outside the repo, recorded here)
Spec: `../spec.md`, sections 3, 11 and 12

## Why a person

Each step needs an account, a click or a yes that an agent doesn't have.

1. **A Resend key for development** in `~/.config/ostra-dev/email.env` (`RESEND_API_KEY`, and `EMAIL_FROM`: an address on a domain verified in Resend, or Resend's onboarding sender, which only mails the account's own address), plus `EMAIL_TO`, the maintainer's own address for the manual run. `docs/development.md` gets the names, never the values.
2. **The link's callback on the test App:** add `<web>/api/github/link/callback` (the dev tunnel's address) to the test App's callback URLs in GitHub's App settings. New Apps get it from the manifest (ticket 09).
3. **Link the maintainer's GitHub account** to the demo admin once, through Account, "Link GitHub", once ticket 47 is in, so the demo's `@ostra` comment comes from a linked member.
4. **The second sandbox GitHub user** of `GITHUB_TEST_REVIEWER_TOKEN` (already asked for in `build-order.md`), as the unlinked commenter.
5. **Approve the milestone 3 screen targets** (ticket 41), recorded there with the date.
6. **Name the install and the Linear workspace for ostra's own tickets** (ticket 49), and install the GitHub App on `JoeyKhd/ostra`.
7. **Say yes to ostra's own tickets moving to Linear** (ticket 49), and which ones go first.
8. **Review spec section 11's choices** (Q165 to Q185, and Q186 to Q190 added while preparing the build, in `context/open-questions.md`), all settled on the delegation of 2026-11-19, and move back to the open list any you disagree with. The targets' open points are decided in the tickets' `## Decided 2026-11-19` sections (01, 02, 06, 07, 12, 13, 17, 21, 23, 25, 30 to 32, 34 to 37, 39, 40, 42, 43, 46, 47, 50).
9. **Turn on the test App's webhook** (added 2026-11-19). In the App's settings (`ostra-sandbox-036d7c`, owned by `ostra-test`): Webhook → Active, the URL `<core's public address>/webhooks/github`, and a new secret, saved as `GITHUB_APP_WEBHOOK_SECRET` in `github.env`. Under "Permissions & events", subscribe to the events in `appEvents` (`packages/adapters/adapter-github/src/manifest.ts`): at least Pull request, Pull request review, Pull request review comment, Issue comment and Push. Without this, `@ostra` never reaches ostra (Q187), and "behind" waits for the reconcile. A quick tunnel's address changes each run; once a webhook exists, a dev helper can point it at the new address with `PATCH /app/hook/config` and the App's JWT.
10. **A token for the linked member's GitHub user** (added 2026-11-19): a fine-grained token for the `ostra-test` org, repositories `test1` and `test2`, "Pull requests: read and write" and "Issues: read and write", saved as `GITHUB_TEST_MEMBER_TOKEN` in `github-test.env`. Demo step 10 posts the `@ostra` comment with it, as the user step 3 links. The App's own token can't do this: its comments come from the App's bot, which no member can link.
11. **Optional: a third-party SMTP server for the tests** (added 2026-11-19). SMTP is proved with the real adapter against an in-process `node:net` server, with no new dependency (ticket 13, Q186). Say yes if you also want a test against a full SMTP implementation such as `smtp-server`; that's a new devDependency.

## Done when

- [ ] Each step is done or answered, with the date, under `## Comments`.

## Comments

- **2026-11-19, lead, on the maintainer's delegation** ("continue working on everything throughout the night, would be nice to wake up to the finished product"). An agent did what it could, as follows. The ticket stays `ready-for-human` for what's left at the end of this entry.
  - **Step 1, the Resend key: not possible for an agent.** There's no `email.env`, and making a Resend account and key needs a person. `docs/development.md` now names `RESEND_API_KEY`, `EMAIL_FROM` and `EMAIL_TO`, never a value. **Until the key exists** (Q186): Resend is proved on a fake of its API (ticket 12), SMTP with the real adapter against an in-process `node:net` server with `STARTTLS` and `AUTH` (ticket 13), and the scripted demo mails through that local server (ticket 50). The live Resend send, the SMTP relay case and the delivery readback wait for this step, and F-115 stays `building`.
  - **Step 2, the link's callback: not possible for an agent.** GitHub has no API that edits an App's callback URLs. Checked through the App's JWT (`GET /app`, 2026-11-19): the App is `ostra-sandbox-036d7c`, owned by `ostra-test`, installed on all of `ostra-test`'s repos, with `contents`, `pull_requests` and `checks` write, and `actions`, `issues`, `metadata` and `statuses` read. GitHub matches the `redirect_uri` against the registered callback URLs exactly, so add both `http://localhost:3000/api/github/link/callback` (the dev panel's own address: the browser follows the redirect, so it needn't be public) and `<tunnel>/api/github/link/callback`.
  - **Step 3, the link: waits for tickets 39 and 47.**
  - **Step 4, the reviewer user: not there.** `github-test.env` has no `GITHUB_TEST_REVIEWER_TOKEN`, and a second GitHub account needs a person.
  - **Step 5, the screen targets:** approved for the build by the lead on the delegation (ticket 41, `context/brand/app-targets/m3/README.md`), pending the maintainer's own review. Their open points are now decided (step 8).
  - **Step 6, the install and the workspace: the maintainer's call.** Recommended: a Linear workspace of its own for ostra's tickets, not `ostra-test`, whose tickets the demos create, cancel and archive; and an install on the version tagged at milestone 3's demo, with its own data folder and ports apart from the dev stack. Installing the App on `JoeyKhd/ostra` is a real repo, so only the maintainer does it (`AGENTS.md`).
  - **Step 7, the yes for ostra's tickets in Linear:** the maintainer's.
  - **Step 8, the choices:** Q165 to Q185 stand, and Q186 to Q190 were added and settled (spec section 11, items 21 to 25). The targets' open points were decided by their recommendations, in the tickets' `## Decided 2026-11-19` sections. Two of them changed contracts before the contracts start: ticket 01 gains `readOnly` on MCP servers, the match `mcp-not-read-only`, `ApprovalRule.preset`, `TaskRule.ruleId` and `plan.answered.entries`, and ticket 06 gains `Snapshot.buildDurationMs` and `NotificationPreference.updatedAt`. Q190 also fixes a license-line problem in the spec: the matcher and the runner's prompts were in `packages/domain` (Sustainable Use), which the Apache-2.0 runner and adapters can't import, so they move to `@ostra/protocol`.
  - **Found while checking, now steps 9 and 10:** the test App has **no webhook and no events** (`GET /app` lists `events: []`, and `GET /app/hook/config` answers 404), because it was made from a manifest while the dev address was private, so `buildAppManifest` left `hook_attributes` out. And there's no token for the linked member's own GitHub user, which demo step 10 needs to post the `@ostra` comment.
  - **Linear, for ticket 10's live case: ready.** `ostra-test` has one human user, the personal key's own (an admin), with an email, and two app users. So the maintainer's own address can be found and mentioned. Checked by count; no address was printed or kept.
  - **Still open from milestone 2:** `test1` and `test2` are still private, and their rulesets still answer 403 (milestone 2's ticket 40, step 3). Milestone 3 doesn't need them public.
  - **Left for the maintainer:** steps 1, 2, 4, 6, 7, 9 and 10, step 3 once ticket 47 is in, step 5's and step 8's own review, and step 11 if wanted.
- 2026-11-19, lead: the record above, the `## Decided 2026-11-19` sections of 24 tickets, spec sections 5.1, 5.3, 5.4, 8 and 11 (items 21 to 25), Q186 to Q190 and `docs/development.md`'s secret names are in 289b56f (`📝 prepare the milestone 3 build`).
