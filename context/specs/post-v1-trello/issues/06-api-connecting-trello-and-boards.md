# 06: API: connecting Trello, boards with a prefix and categories, the ticket's tracker

Status: ready-for-agent
Builder: api
Blocked by: 03, 04
Features: F-153, F-152, F-007, F-097, F-149
Packages: `packages/api` (`routers/trackers.ts`, `routers/trello.ts` new or the `trackers` router's `trello` sub-router, `routers/boards.ts`, `routers/inbox.ts`, `routers/notifications.ts`, `services/trello-connect.ts` new, `services/ticket-trackers.ts`, `runtime.ts`, `testing/`)
Spec: `../spec.md`, section 5.5; ADR 0072; ADR 0071

## What to build

- **`trackers.create` takes `kind: "trello"`;** `trackers.list` and `get` include Trello's arm, field by field: name, the bot's username and full name, the state, the mode, the boards; no key, secret or token, and a member sees no admin-only field (the same rule as m11's).
- **`trackers.trello.*`,** each admin-only and answered, not thrown, where the panel draws a red line:
  - `saveApp({ connectionId, apiKey, secret, name })`;
  - `authorizeUrl({ connectionId })` (admin-only: it names the key);
  - `checkToken({ connectionId, token })` (in memory; the member, whether another connection holds it, the boards);
  - `saveToken({ connectionId, token })`, `replaceToken`, `replaceAppSecret`, `recheck`, `reregisterWebhooks`.
- **Boards:** `attachable` groups Trello's boards (`listBoards`, `key: ""`); `attach` takes `keyPrefix` (2–8 `[A-Z0-9]`, unique in the project) and refuses its absence on a Trello board; `get`/`mapping` carry `statusCategories`; a Trello board's statuses are its lists.
- **Every ticket payload's tracker kind includes `"trello"`:** the Inbox's rows and filters, a ticket's chip, `tasks.get`, notifications, and the task's "On Trello" rows (the list's name per move, no transitions).
- **`services/trello-connect.ts`** implements the domain's `TrelloConnectKit` on `adapter-trello`'s connect calls, wired in `runtime.ts`, as `services/jira-connect.ts` does. **`services/ticket-trackers.ts`:** `capabilitiesSchema` gains `webhookRegistration`, and the per-kind capability map the picker reads includes `trello`.

## Done when

- [ ] Tests named for `F-153/c1`: `create({kind:"trello"})` makes a pending connection; `saveApp`/`checkToken`/`saveToken` answer the member and its boards and activate the row; a refused token answers the step's failure and stores nothing.
- [ ] Tests named for `F-153/c2`: no procedure's output or error holds the key, the secret or the token; a member calling an admin procedure is refused (break-it: add the token to the view, and the test fails); two organizations' connections stay invisible.
- [ ] Tests named for `F-153/c5`: `attach` stores the prefix and refuses a duplicate or a missing one; `mapping` stores and reads `statusCategories`; a Trello board's statuses come from its lists.
- [ ] Tests named for `F-152/c1`: `trackers.get` reads Trello's arm for a member with no secret field, and a member calling an admin procedure is refused.
- [ ] Tests named for `F-153/c8`: the Inbox, a task's ticket and a notification name Trello's mark and the connection; a ticket's key is `TR-12`.
- [ ] `pnpm typecheck` and `pnpm test` for `packages/api` pass; the whole-repo checks run before the push.
- [ ] Committed as `✨ connect Trello from the API`.
