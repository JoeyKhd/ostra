# 17: Docs: Trackers and Jira

Status: done
Builder: core
Blocked by: 09, 10
Features: F-152, F-008, F-058
Packages: `apps/docs` (`content/install/`: new `trackers.mdx` and `jira.mdx`, `linear.mdx` re-homed under Trackers, `meta.json`, `setup.mdx`; `content/start/before-you-start.mdx`, `30-minute-path.mdx`, `what-ostra-is.mdx`; `content/using-ostra/tasks.mdx`, `ticket-files.mdx`; `content/reference/ports.mdx`; `content/contributing/adapters.mdx`), `docs/configuration.md`
Spec: `../spec.md`, sections 1, 3 and 5.5; ADR 0047, ADR 0071

## What to build

- **Trackers** (`install/trackers.mdx`, new): what a tracker connection is, several per organization (one per client), one per site or workspace, what each kind does here (from the adapters' capabilities), webhooks or polling, disconnecting and resuming, who can see what.
- **Jira** (`install/jira.mdx`, new): the three steps with exactly what to create at Atlassian (a service account in admin.atlassian.com › Directory › Service accounts with access to the projects; a scoped API token with the four scopes and its expiry; an admin webhook in Settings › System › WebHooks with the URL, the secret, the six events, Exclude body unticked, the optional JQL); polling without a public address; the mapping by target status and Done by Jira automation; rotating the secret and replacing the token; what Jira doesn't do here (agent mode, Data Center); S-10's note on service accounts and Atlassian Guard, and the bot-user fallback ADR 0047 names.
- **Linear** (`install/linear.mdx`): re-homed under Trackers (its URL kept, its navigation under Trackers), "the organization's Linear" becoming a Linear connection; agent mode as Linear-only.
- **The rest:** setup's step 4 and the 30-minute path say "Connect a tracker"; `what-ostra-is` and `before-you-start` name Jira; `ticket-files` names Jira's attachments; `ports.mdx` names `/webhooks/jira/<id>`; the adapter guide names the new capabilities; `docs/configuration.md` has `OSTRA_JIRA_API_URL`.
- **The docs' command check** (milestone 7) runs every command the new pages hold.

## Done when

- [x] The pages exist, each command on them checked by milestone 7's docs check, the site builds, and its link check passes.
- [x] `docs/configuration.md` lists `OSTRA_JIRA_API_URL` with its default (`settings-docs-reference.test.ts` passes).
- [x] Checks for `apps/docs` pass (spec section 10).
- [x] Committed as `📝 document Trackers and Jira`.

## Comments

- 2026-11-23, builder: new `install/trackers.mdx` (what a connection is, several per organization, one per site, what each kind does from the adapters' capabilities, webhooks or polling, boards from any connection, who sees what, disconnect and resume, Trello/Notion "Coming soon") and `install/jira.mdx` (the site, the service account and the four scopes, the admin webhook with its six events, `Exclude body` unticked and the optional JQL, polling, the target-status mapping and Done by Jira automation, rotate the secret and replace the token, the token's date, what Jira doesn't do, S-10 and the bot-user fallback). `install/linear.mdx` re-homed: its URL kept, its entry in the install nav's new Trackers group, its words now "a Linear connection", agent mode Linear-only. `install/meta.json` groups `trackers`, `jira`, `linear` under `---Trackers---`. Setup's step 4 and closing paragraph, the 30-minute path, `what-ostra-is`, `before-you-start`, `tasks`, `ticket-files`, `ports` (`/webhooks/jira/<id>`), `docker-compose`, `security/files` (Jira's file host) and the adapter guide (Jira in the shipped-adapter row, the fakes) follow. `docs/configuration.md` already listed `OSTRA_JIRA_API_URL` from ticket 06; verified against `settings.ts`, not changed.
- 2026-11-23, builder, checks: `pnpm turbo run typecheck lint test --filter=@ostra/docs --cache-dir=C:/Users/santi/ow/.turbo-cache` → 4/4 tasks green (14 tests); `pnpm turbo run build --filter=@ostra/docs …` → 61 static pages; `pnpm check:export` in `apps/docs` → 5/5; a crawl of `out/`'s every `/ostra/docs/…` href → all resolve; `pnpm vitest run src/settings-docs-reference.test.ts` in `packages/domain` → 1/1. No `sh run` block on the new pages, so milestone 7's command check has nothing to execute there.
- 2026-11-23, builder, gap: `packages/api/src/routers/setup.ts`'s `setupStepDocs.tracker` still reads `docs/install/linear/`, under a comment saying "until the docs gain their Trackers page (milestone 11, ticket 17)". That page exists now; a one-line follow-up in `packages/api` should point the setup row at `docs/install/trackers/`. Outside this ticket's packages, so left for its owner.
- 2026-11-23, builder: rebased onto `origin/main` (`78fb261a`), commit `e30d320e`.
