# 19: The maintainer's steps outside the code

Status: ready-for-human (held: the test site is needed only for ticket 18's live run at the launch gate)
Builder: maintainer
Blocked by: none for the test site; 18 for the review of the run
Features: F-008, F-152
Spec: `../spec.md`, sections 1 ("On this machine"), 3, 11 and 12

## What to do

1. **Approve the targets** in `context/brand/app-targets/m11-trackers/`. Done 2026-11-23 ("yes to all"), recorded in the targets' README.
2. **Agree the ledger's rows:** F-008's new "done when" (it moved into v1 on 2026-11-23) and the new F-152, in `context/features.md`, or say what to change.
3. **Answer Q353:** may `adapter-jira` use `mdast-util-from-markdown` 2.1.0, `micromark-extension-gfm` 3.0.0 and `mdast-util-gfm` 3.1.0 (MIT, already in the lockfile through `apps/docs`) to turn markdown into ADF? The default, if you say nothing, is the hand-written converter.
4. **Make a Jira Cloud test site and its service account,** for the live run only, nothing in the repo:
   1. **The site:** a free Jira Cloud site at `https://<name>.atlassian.net` (for example `ostra-test`), on an Atlassian account you own. Jira Software, a company-managed Scrum or Kanban project with the key `OJ`, its default workflow, plus one status `Blocked` with no transition to `In Review` (the demo's step 10), and one team-managed project (`OT`) to answer S-12 on both kinds.
   2. **The service account:** in `admin.atlassian.com` › Directory › Service accounts, create `ostra-bot`, and give it the Jira product role and access to `OJ` and `OT` with Browse projects, Create issues, Edit issues, Transition issues, Add comments and Create attachments (the project's permission scheme). If the page says service accounts need Atlassian Guard (S-10), make a dedicated bot user `ostra-bot` instead (ADR 0047's fallback) and say so here.
   3. **The scoped API token:** for `ostra-bot`, a scoped token for Jira with `read:jira-work`, `write:jira-work`, `read:jira-user` and `read:workflow:jira`, expiring in 30 days or more. Note its expiry date.
   4. **The secrets file:** `~/.config/ostra-dev/jira.env` (never in the repo) with `OSTRA_JIRA_LIVE_SITE=<name>`, `OSTRA_JIRA_LIVE_EMAIL=<the service account's email>`, `OSTRA_JIRA_LIVE_TOKEN=<the token>` and `OSTRA_JIRA_LIVE_TOKEN_EXPIRES=<YYYY-MM-DD>`.
   5. **The admin webhook,** at the run: you, as the site's admin, create it in Settings › System › WebHooks with the URL and secret ostra shows on step 3 (ticket 18 runs it with you), events `Issue created/updated/deleted` and `Comment created/updated/deleted`, Exclude body unticked.
   6. **GitHub for Atlassian** (optional): install it on the site for the `ostra-test` GitHub org, so the run sees Jira link the PR by its key as well as ostra's remote link.
5. **Look at Notion's brand page** (`notion.so/brand`), which refuses automated reads, and say whether its mark may name the integration as the targets draw it (ticket 11 reads Linear's and Atlassian's).
6. **Look at the build** once tickets 12 to 16 land: the new screens at 1440 and 390 px in both themes against the targets, or say what to change.
7. **Review the demo's run** (ticket 18) at the launch gate.

## Done when

- [x] The targets approved (2026-11-23), recorded in the targets' README.
- [ ] F-008's and F-152's "done when" agreed.
- [ ] Q353 answered (or left to the default).
- [ ] The test site, the service account (or bot user), the scoped token and `~/.config/ostra-dev/jira.env` made.
- [ ] Notion's brand page looked at.
- [ ] The build looked at.
- [ ] The run reviewed.

## Comments

- 2026-11-23, lead: the maintainer approved every target and the fifteen choices as recommended ("yes to all"); the spec and these tickets build them.
