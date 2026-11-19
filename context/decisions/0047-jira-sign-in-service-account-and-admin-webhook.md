# Jira connects through a service account and an admin webhook

**Status:** accepted (2026-11-18, from the delegated answers in `context/history/answers-2026-11-18.md`). Settles Q-20. It adds to ADR 0013, which says Jira comes first after v1. Ledger: F-008, which stays later. Confidence is medium. The facts are in `research/trackers.md` §2.

Jira Cloud connects to an organization's ostra in two parts.

- **A service account that the organization owns,** with a scoped API token. ostra uses it for every call to Jira.
- **One admin webhook,** signed with a shared secret. It delivers Jira's events to ostra.

ostra never asks a customer to create its own OAuth 3LO app, and it never collects a member's personal API token.

Each organization has its own Jira connection, as it has its own GitHub App and Linear app (ADR 0001). The webhook URL is per connection, so ostra routes an event by connection and not by one install-wide address (Q102).

## Why

- **Atlassian's rule is aimed at the other routes.** Its 3LO page says that apps which "collect API tokens or instruct customers to create individual 3LO apps" don't comply with its security requirements (`research/trackers.md` §2.2). A service account is owned by the customer, so ostra holds the token of one bot and not tokens of members.
- **A service account writes as a bot.** ostra can tell its own changes from a person's (`user.accountId` is the service account) and drop its own echoes. A 3LO app acts as the consenting user.
- **API-token traffic is exempt from the points quota** that Atlassian enforces on Forge, Connect and 3LO apps from 2026-03-02. Only the burst limits apply (§2.1).
- **Admin webhooks don't expire.** Dynamic webhooks last 30 days, allow five per app per user, take a smaller set of events and filters, and a non-public app receives them only if its owner registered them (§2.3).

## How it works

- **Setup, by an organization admin:**
  1. Create a service account, and grant it access to the Jira projects ostra should see.
  2. Create a scoped API token for it, and paste it into ostra. It's stored encrypted through the secret store adapter (ADR 0025).
  3. Create an admin webhook in Jira's admin UI, with the URL and the secret that ostra shows.
- **Calls** go through `api.atlassian.com/ex/jira/{cloudId}`, which scoped tokens require. The adapter finds the `cloudId` from the site. The token's scopes are the least the adapter needs. The adapter's spec lists them.
- **Webhooks are hints.** The server checks the `X-Hub-Signature` HMAC with the shared secret and refuses an event without a valid one. It stores the event in a durable inbox, deduplicated by `X-Atlassian-Webhook-Identifier`, and answers at once. The job then fetches the ticket before acting. Jira delivers at least once, so duplicates are normal (§2.3, §4.3).
- **The webhook's JQL filter only narrows traffic.** ostra evaluates intake rules itself. A periodic reconcile query per rule catches anything missed.
- **The panel shows the last event received.** A silent webhook is visible.
- **Rate limits.** The adapter's per-credential budget (Q20) respects the burst limits and the per-issue write limits (20 per 2 s and 100 per 30 s). Progress updates are coalesced into one comment that's edited in place.
- **The token expires.** Scoped tokens last 1 to 365 days. The panel warns admins before the date, and an expired token shows as a failed connection.
- **No native agent mode.** Jira's agent route is a Forge connector on Atlassian's platform. The `TrackerAdapter` declares no agent sessions for Jira, and progress goes through comments (ADR 0013).

## Considered options

- **A 3LO app that each customer creates.** Rejected: it's the route Atlassian's rule names. It acts as the user, its refresh tokens rotate and expire after 90 days of inactivity, and it needs dynamic webhooks with a 30-day refresh job.
- **A single 3LO app that ostra publishes.** Rejected: one client secret would ship to every install. *Changed 2026-11-19: this added that a hosted version could do it, and none is planned (ADR 0001).*
- **Collecting each member's personal API token.** Rejected: it's the other thing the rule names, and ostra would hold a token for every person.
- **Registering the webhook for the admin through the REST API.** Not part of this decision. It needs an admin's own credentials, and ostra doesn't collect those.
- **Dynamic webhooks with the service account's OAuth 2LO credentials.** Rejected: whether 2LO can register them is unverified (S-11), and they expire every 30 days.
- **A Forge app, or the older Connect.** Rejected: Forge code runs on Atlassian's platform and targets multi-tenant SaaS, and Connect support ends on 2027-01-31.
- **Jira Data Center or Server.** Out of scope. It has personal access tokens, no dynamic webhooks, and no signing secret in its docs (§2.7). It gets its own ADR if someone asks.

## Consequences

- **Jira stays after v1.** This ADR means Jira work can start without waiting on this question. From milestone 2, the tracker contract suite runs against a Jira fake as well as Linear (Q104).
- **Two things are still unverified.** Atlassian hasn't said how its rule applies to a self-hosted tool (S-9). Whether service accounts need a paid plan is unclear, because the docs say Atlassian Guard Standard or Enterprise and also list a free tier of 5 (S-10).
- **If service accounts need a paid plan,** the fallback is a dedicated bot user with a scoped token. The organization creates the bot user for ostra. It's still not a member's personal token. The setup steps stay the same, but the bot user may cost a seat.
- **Jira's quirks stay in the adapter.** Rich text is ADF, and issue keys change when a ticket moves project. The adapter keys everything on stable IDs (`research/trackers.md` §3).
- **Statuses move through Jira's transitions.** Each board has its own workflow, so the adapter reads the allowed transitions and moves a ticket with one, never by writing a status directly. The tracker contract suite covers this (Q104).
- **ADR 0013 gets a pointer to this ADR.**
