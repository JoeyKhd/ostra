# 17: Docs: Trackers and Jira

Status: ready-for-agent
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

- [ ] The pages exist, each command on them checked by milestone 7's docs check, the site builds, and its link check passes.
- [ ] `docs/configuration.md` lists `OSTRA_JIRA_API_URL` with its default (`settings-docs-reference.test.ts` passes).
- [ ] Checks for `apps/docs` pass (spec section 10).
- [ ] Committed as `📝 document Trackers and Jira`.

## Comments
