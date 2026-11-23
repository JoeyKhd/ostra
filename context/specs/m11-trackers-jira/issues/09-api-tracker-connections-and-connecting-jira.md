# 09: API: tracker connections and connecting Jira

Status: done
Builder: api
Blocked by: 04, 06
Features: F-152, F-008, F-005, F-076
Packages: `packages/api` (new `routers/trackers.ts`, `routers/linear.ts` (per connection), `routers/setup.ts`, `routers/notifications.ts`, `services/trackers.ts`, new `services/jira-connect.ts`, `runtime.ts`, `testing/world.ts`)
Spec: `../spec.md`, sections 4 ("Connecting Jira", "A disconnect") and 5.3; the targets' `trackers.md`, `jira-connect.md` and `connection-settings.md` "Data" sections; ADR 0071

## What to build

- **The tracker directory** (`services/trackers.ts`): `forConnection` for any kind (Linear and Jira built with their tokens), `connectionsOf(organizationId)`; `linearConnectionOf` goes, and each caller takes a connection.
- **`services/jira-connect.ts`:** the domain's `JiraConnectKit` on `adapter-jira`'s `jiraConnect` calls, with `OSTRA_JIRA_API_URL`.
- **`trackers.*`** (the targets' "Data"): `list` (every connection: `id`, `kind`, `name`, `site`, `webhookMode`, `lastEventAt`, `state`, `failedReason`, `tokenExpiresAt`, `silentSince`, `boards`, `capabilities`), `get({ id })` (plus Jira's `cloudId`, `email`, `reach`, `workflowsReadable`, `scopes`; Linear's as today's `linear.status`), `create({ kind, name })`, `rename`, `disconnect`. Members get `list` and `get` without the webhook URL, secret, email or token details; every write is admin only and audited.
- **`trackers.jira.*`:** `findSite`, `checkToken`, `saveToken`, `replaceToken`, `recheck`, `webhook` (URL, the secret while no delivery has come, the six events, the suggested JQL, `lastDeliveryAt`, `badSignatureAt`), `finishPolling`, `rotateSecret` (the new secret once).
- **`trackers.linear.*`:** today's `linear.*` procedures, each taking `connectionId`. `linear.*` stays one release as a thin alias on the first Linear connection, so the panel keeps working until ticket 14 lands; its line in the router says when it goes.
- **`setup.status`'s step `tracker`** (`state`, and the connection's `id`, `kind` and `name` when pending, failed or done, the most recent one); `setup.skip({ step: "tracker" })`.
- **Notifications** name the connection's kind and name, not "the Linear".
- **Errors** say what to do in the targets' words, with Jira's status code and never its body.

## Done when

- [x] Tests named for `F-152/c1`: `trackers.list` holds two Linear and two Jira connections with their names, kinds, modes, states and capabilities; `create`, `rename` and `disconnect` work and are audited.
- [x] Tests named for `F-152/c2`: `findSite` on a site the organization holds is refused, naming the holder; a Linear Authorize on a workspace another connection holds is refused the same way.
- [x] Tests named for `F-152/c3`: a member gets `list` and `get` with no webhook URL, secret, email or token detail, and every write is refused; another organization's connection is a 404.
- [x] Tests named for `F-008/c1`: the three steps through the procedures against the fake Jira (through `jira-connect.ts`): the site, a checked token saved, the webhook's words, a first delivery making `get` answer `active`; `finishPolling` without a public address.
- [x] Tests named for `F-008/c8`: `replaceToken` reads back first; `rotateSecret` answers a new secret once and never again.
- [x] Tests named for `F-008/c9`: a Jira connection's `capabilities` hold no agent sessions, and `trackers.linear.*`'s agent mode refuses a Jira connection.
- [x] Tests named for `F-152/c7`: `setup.status`'s `tracker` step for open, pending (either kind), failed, done and skipped.
- [x] Checks for `packages/api` pass, and the whole-repo checks (spec section 10).
- [x] Committed as `✨ serve tracker connections of any kind`.

## Comments

- 2026-11-23, api: built as `✨ serve tracker connections of any kind`. Tests in `packages/api/src/routers/trackers.test.ts` (9, on Postgres, with the HTTP fake Jira behind `services/jira-connect.ts` and the fake Linear), the isolation matrices' new rows, and the setup and notification tests moved to the `tracker` step and `{ kind, name }`. Readings and differences:
  - **The directory** (`services/trackers.ts`): `forConnection` builds Linear's or Jira's adapter (Jira's from the site's host, cloud ID, the service account's email and the `jira-token` secret; `runtime.ts`'s `jiraTrackerOn` on `OSTRA_JIRA_API_URL`, overridable as `makeJiraTracker`), `connectionsOf`, `connectionOf` and `capabilities` (the adapters' own `LINEAR_CAPABILITIES` and `JIRA_CAPABILITIES`). `linearConnectionOf` is gone; `routers/boards.ts` keeps a local `firstLinearOf` bridge until ticket 10 gives each procedure its board's connection.
  - **Answered, not thrown:** the outcomes a step draws in place come back in the output, so `unwrap` drops nothing: `trackers.jira.findSite` (`site-taken` with `holder`, `not-found`, `data-center`, `unreachable`, `name-taken`), `saveToken` and `replaceToken` (`token-refused` with `status`, `token-failed` with `readBack`, `unreachable`), `trackers.linear.complete` (`workspace-taken` with `holder`). Everything else is a tRPC error; a missing or another organization's connection is `NOT_FOUND`.
  - **A member** reads `trackers.list` and `trackers.get` with `tokenExpiresAt`, `tokenExpiry`, `signsInAs`, Jira's `email`, `webhookUrl`, `webhooksPage`, `reach`, `scopes` and `badSignatureAt` empty, Linear's `linear` (today's `linear.status`) `null`, and only the boards of projects they may open; `canManage` says which. `trackers.jira.webhook` and `trackers.linear.status` are an admin's.
  - **`linear.*`** stays as the alias on the first Linear connection (oldest first), `start`'s one-connection behaviour included, until ticket 14's pages call `trackers.*`; its comment in the router says it goes the release after milestone 11. `linear.disconnect` goes through `disconnectTracker`. `trackers.linear.*` has no `start` or `disconnect`: `trackers.create` and `trackers.disconnect` are every kind's.
  - **Agent mode** on a Jira connection is refused by its capability (`Agent mode is Linear's: Jira has no agent sessions`), not by its kind.
  - **`setup.status`:** the step's id is `tracker` (from `trackerSetupStepInTx`), its row carries `connection` (`id`, `kind`, `name`: the newest pending or failed one, or the newest active one once done), and its docs link stays `docs/install/linear/` until ticket 17. `apps/web`'s checklist, its tests and the e2e specs 01 to 03 follow the id only (`tracker`, copy still `checklist.linear.*`): ticket 16 draws the step.
  - **`notifications.preferences.get`:** `tracker` is the first active connection's `{ kind, name }`, and `trackers` lists every one; `needs-you-view.tsx` and `notification-settings-view.tsx` word the kind with `tracker-mark.tsx`'s `trackerName`.
  - **Step 3's last delivery** is `firstDeliveryAt` and `lastEventAt` in `trackers.jira.webhook`, with `badSignatureAt`.
