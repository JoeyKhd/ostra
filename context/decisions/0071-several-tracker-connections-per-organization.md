# An organization holds several tracker connections, of any kind

**Status:** accepted (2026-11-23, the maintainer's decisions of the day, and the approval of `brand/app-targets/m11-trackers/` with "yes to all"). It amends ADR 0013 (trackers as adapters, one Linear app per organization) and ADR 0047 (Jira's sign-in), and builds on ADR 0026 (organizations and projects), ADR 0053 (isolation) and ADR 0065 (clients inside one organization, keys per project). Ledger: F-152 (trackers), F-008 (Jira, moved into v1 the same day), F-005, F-007, F-042, F-076. Spec: `specs/m11-trackers-jira/`.

## Context

Until milestone 11 an organization had at most one Linear connection: a partial unique index (`connection_one_linear_per_organization`) enforced it, and the panel, the API and core found "the organization's Linear" with one `findFirst` (`packages/api/src/services/trackers.ts`'s `linearConnectionOf`, `routers/linear.ts`, `routers/inbox.ts`, `routers/notifications.ts`, `domain/use-cases/linear-connection.ts`, `domain/use-cases/boards.ts`, `apps/core/src/tracker/ingest.ts`). One team runs each install, and its clients are projects inside one organization (ADR 0065): each client brings its own model keys and its own GitHub organization. A client also brings its own tracker, and one client can be on Linear while another is on Jira.

The maintainer, 2026-11-23: several tracker connections per organization, of any kind, the way model keys work per client; a project's Boards attach boards from any connection; the organization page is called **Trackers** and replaces Organization › Linear; Jira Cloud is built now; Trello and Notion appear in the picker as "Coming soon".

## Decision

### The data model

- **A connection is one tracker account an organization holds:** one Linear workspace through one Linear app, or one Jira Cloud site through one service account. It has a **kind** (`linear` or `jira`, more as adapters ship), a **name** an admin chose (prefilled from the kind and the workspace or site: `Globex Jira`, renamable), its **own credentials** (the Linear app's client secret, access and refresh tokens; Jira's scoped API token), its **own webhook** (its URL names the connection, `/webhooks/<kind>/<connectionId>`, and its secret is the connection's alone) or polling, its own state (`pending`, `active`, `failed`, `revoked`) and its own last event. An organization holds any number, of any mix of kinds.
- **The row stays `Connection`.** It gains `name` and the `jira` kind, and Jira's columns (the site's host and cloud ID in the workspace columns, the service account's email, the token's expiry date as the admin gave it, the last read-back, whether workflows are readable, the last bad signature). Every new column is nullable or has a default.
- **Boards belong to a connection.** `Board.connectionId` already names it. A project attaches boards from any of the organization's active connections, from several connections at once, and of several kinds at once. A board's status mapping, polling cursor and tickets are its own; a ticket keys on `(boardId, externalId)` and so on its connection.
- **Nothing is shared across connections.** No credential, webhook secret, rate budget, idempotency key, own-user (echo) ID, polling cursor or cached ticket belongs to two connections. A tracker adapter is built for one connection with that connection's credential (`createConnectionTrackers`), and every call through it is attributed to that connection.

### Keeping a client's connections apart

- **Every path names its connection.** A webhook is routed by the connection in its URL and verified with that connection's secret alone; a poll, a write, a ticket read and a file fetch go through the board's own connection, never "the organization's" tracker. Code that finds a tracker by kind (`findFirst({ kind: "linear" })`) is removed: the API and core look a connection up by its ID and the organization, and refuse one of another organization (ADR 0053).
- **A board's connection never changes behind its back.** Attaching asks for the connection and the team or project; the same external ID under two connections is two boards (two Jira sites both have a project `10000`).
- **Who sees what.** Organization admins connect, rename, re-check, rotate and disconnect connections. Members see the list, each connection's kind, name, site, state and boards, never its webhook URL, secret or token details. A project's members see the connection's kind and name on its boards and tickets, which is what lets them tell Globex's `PROJ-12` from Acme's `CALC-170`.
- **The words for it** (the Trackers page): "Each connection keeps its own token and webhook. A client's tickets only ever move through its own connection."

### One connection per site

- **One connection per Linear workspace or Jira site in an organization, among those not `revoked`.** A second is refused, naming the existing one. For Jira the site is known at step 1, so the check runs there; for Linear the workspace is known only when the app is authorized, so the check runs at the OAuth callback, which then deletes the pending row's secrets and says which connection already holds the workspace.
- **Enforced in Postgres** by a partial unique index on `(organizationId, kind, externalWorkspaceId)` where the state isn't `revoked` and the workspace is known, and by Jira's `appId` (the site's cloud ID) under the existing `(organizationId, kind, appId)` key.
- **Not install-wide.** Two organizations of one install may connect the same site, as they may connect the same GitHub account (ADR 0053 keeps them apart). One install runs one organization in v1 (F-049), so this only matters after F-134.

### Disconnecting, and connecting again (choice 12)

- **Disconnect** stops the connection's webhook handling and polling, revokes what can be revoked (Linear's token at Linear; a Jira scoped token can't be revoked through the API, so its deletion from the secret store is the revocation, and the dialog says to revoke it at admin.atlassian.com), deletes every secret of the connection, ends its open Linear agent sessions with a final response, and sets it `revoked` with its `appId` given back (`revoked:<id>`, as today).
- **Its boards stay attached but paused.** A board whose connection isn't `active` is *paused*: nothing moves on the tracker, polling stops, no rule, schedule or ticket starts a task from it, its tickets and tasks stay readable, and its mapping reads only. A paused board isn't a detached one: it still counts as the project's board, and the Boards page draws it with its pause line and a link to Trackers. *Paused* is derived from the connection's state, not stored on the board, so a failed connection's boards pause too, and resume when it's fixed.
- **Connecting the same site or workspace again resumes them.** When a connection becomes `active` and the organization holds a `revoked` connection of the same kind and the same `externalWorkspaceId`, the paused boards of that old connection move to the new one in the same transaction: each board's `connectionId`, and its tickets', are set to the new connection, polling restarts from each board's own cursor, and the old row keeps its history with `resumedIntoId` naming the new one. A board the old connection held for a team or project the new connection can't see stays paused, and its pause line says why. Moving boards (rather than reviving the old row) is what lets a Linear connection resume: its new Linear app's webhook URL names the new row.
- **ostra can't delete Jira's admin webhook.** It needs an admin's own credentials, which ostra never collects (ADR 0047); the dialog says so. Deliveries to a revoked connection's URL are answered `410 Gone` and stored nowhere.

### Linear's existing connection becomes the first named one

- **The migration adds, and relaxes two rules.** It adds the `jira` kind, the new columns, the per-site index and `Board`'s `(projectId, connectionId, externalId)` key, and copies `OrganizationSetting.linearSkippedAt` into a new `trackerSkippedAt`. It fills `name` on every existing tracker row from the workspace's name (`Acme Linear`), or `Linear` when it was never read. Then it **drops two constraints**: the one-Linear-per-organization index, and `Board`'s `(projectId, externalId)` key, which the new key replaces. Dropping a constraint removes no data and nothing an older release reads, so it doesn't fall under "add first; drop or rename in a later release" (`AGENTS.md`): it only allows what the new release does. A replica of the older release still running during a rolling upgrade still finds the first Linear connection.
- **Columns are dropped later.** `linearSkippedAt` stays, still written, until the release after milestone 11; `name` becomes required in that release too, once every row has one. Each later drop is its own migration, named in the ledger row that ships it.
- **Pending Linear rows.** A pending Linear row's placeholder `appId` becomes `pending:<connectionId>` (was `pending`), so several connections can be pending at once under the `(organizationId, kind, appId)` key; the domain reads both forms.
- **The panel's routes.** `/organization/linear` redirects to the first Linear connection's page, `/organization/trackers/<id>` (to Trackers when there's none). The setup checklist's `linear` step becomes `tracker`, done when any connection is `active`; an organization that skipped `linear` stays skipped. Copy keys move from `linear.*` to `trackers.linear.*`. Audit actions gain `tracker.*` (`tracker.connection-created`, `tracker.connected`, `tracker.renamed`, `tracker.token-saved`, `tracker.secret-rotated`, `tracker.disconnected`, `tracker.resumed`); the `linear.*` actions already written stay, and the setup timeline reads both.

### What each kind declares

Capabilities stay the adapter's (ADR 0025, ADR 0013): the panel shows a capability only where the connection's adapter declares it, and never draws a missing one as a disabled control. Agent mode and the PR's magic word are Linear's; workflow transitions and the JQL filter are Jira's; sub-issues and sub-tasks are both, each under its own word. Trello and Notion are in the picker as "Coming soon", disabled, with no link and no form, until their adapters ship (`research/trello-and-notion.md`).

## Considered options

- **One connection per kind per organization** (Linear's rule until now, plus one Jira). Rejected by the maintainer: two clients on Linear need two workspaces, and the model-keys precedent is per client.
- **A connection per project.** Rejected: one Linear workspace often serves several of a client's projects, and agent mode, the app and its webhook are per workspace. Boards already give each project its part of a connection.
- **Allow two connections to one site** (two service accounts with different reach). Rejected (choice 3): it doubles every webhook and poll, and a ticket would belong to two boards' caches with two credentials. A narrower reach is a narrower service account, or boards left unattached.
- **Detach every board on disconnect.** Rejected (choice 12): a client's tokens get rotated and sites get reconnected; detaching would lose every mapping and make a reconnect a re-setup.
- **Revive the revoked row on reconnect,** instead of moving its boards. Rejected: Linear's app is made before ostra knows the workspace, and its webhook URL names the new row; moving boards works for both kinds the same way.
- **A new table per kind** (`LinearConnection`, `JiraConnection`). Rejected: boards, tickets, deliveries and agent sessions already key on `Connection`; per-kind columns stay nullable, and the domain reads them through a discriminated union per kind.

## Consequences

- **Every caller that assumed one Linear changes** (the spec's section 1 lists them): the API's tracker directory loses `linearConnectionOf`; Boards, the Inbox, notifications, setup and the new-project form take a connection; core polls boards of every kind; the webhook inbox takes `jira`.
- **A ticket's payload names its connection** (`kind`, `name`), so every place a ticket shows draws the tracker's mark (choices 9 and 10).
- **The tracker contract suite gains isolation cases:** two connections of one kind in one organization, an event or a write on one never touching the other's boards, and a resume moving only the old connection's boards.
- **Search, Insights and the audit log** filter by connection where they filter by tracker today.
- **Cost:** one more column to choose when attaching a board, and one more line on Boards. The page reads as before for an organization with one connection.

## Amendments

- *2026-11-23:* written with milestone 11's spec.
