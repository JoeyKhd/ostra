# 08: Docs: Trello under Trackers, and the configuration reference

Status: ready-for-agent
Builder: core
Blocked by: 06
Features: F-153, F-042
Packages: `apps/docs` (a Trello page under Trackers, the Trackers page's list, `docs/configuration.md` or its generated source)
Spec: `../spec.md`, sections 1, 5.7 and 11; ADR 0072; `research/trello-and-notion.md` §1

## What to build

- **A Trello page under Trackers:** what a connection is (one bot member, its own app key and secret), the two steps with the exact consent URL's parameters (`scope=read,write`, `expiration=never`) and the bot member's Allow (or a pasted token), what ostra reads and stores, and how to remove it.
- **Webhooks and polling:** ostra registers a webhook per attached board itself; the callback URL is signed, so changing `OSTRA_CORE_PUBLIC_URL` needs `Re-register webhooks`; without a public HTTPS address the connection polls every 60 seconds and the Inbox is still within a minute.
- **A board's mapping:** lists are statuses, every list gets a category, the started/in-review/done steps and the key prefix (`TR-12`); Done is moved by ostra; a move writes the card's list.
- **The limitations, in their own words:** no mentions (emails unreadable), no sub-issues (checklists go into the description), one assignee (a card's first member), no priority, a link attachment is a link and never fetched, uploads download with the credential, and a person's comment edit may only show on the next read. Trello disables a webhook after 30 days of failures numbering over 1,000: the Trackers row's silent line shows it, polling still catches the work, and `Re-register webhooks` makes a new one.
- **The configuration reference:** `OSTRA_TRELLO_API_URL` and `OSTRA_TRELLO_AUTHORIZE_URL`, each with its working default and a line saying they're for tests.
- **The Trackers page** lists Trello beside Linear and Jira and no longer says Trello is coming.

## Done when

- [ ] The docs build (`pnpm --filter @ostra/docs build` or the repo's docs command) passes.
- [ ] A test or the docs' link check confirms every command, setting and page link in the new pages resolves (the docs' own checks; no browser).
- [ ] No credential, token, app key or card text appears in the pages; every Trello claim cites the primary source or says it's unverified (spec section 11).
- [ ] Committed as `📝 document Trello as a tracker`.
