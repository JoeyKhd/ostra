# 04: Domain: the Trello kind, its connect steps, and a board's settings

Status: ready-for-agent
Builder: core
Blocked by: 01, 02
Features: F-153, F-152 (the third kind), F-007 (a board's settings)
Packages: `packages/domain` (`use-cases/tracker-connections.ts`, `use-cases/trello-connection.ts` new, `use-cases/tracker-connection-changes.ts`, `tickets/board-mapping.ts`, `tickets/board-ref.ts` new, `setup/tracker-step.ts`, `testing/`, `index.ts`), `context/GLOSSARY.md`, `context/domain-model.md`
Spec: `../spec.md`, sections 5.4 and 14; ADR 0072; ADR 0071

## What to build

- **The kinds:** `trackerKinds` gains `"trello"`; `comingSoonTrackerKinds` becomes `["notion"]`; `isTrackerKind` and `trackerKindNames` gain Trello; `TrackerConnection` gains its arm (`kind: "trello"`, `site` the username, the bot's username and full name, its boards count, no token date); `TrackerKindCapabilities` gains `trello`.
- **Names and one per bot member:** the name the admin types, prefilled `Trello` (`defaultConnectionName("trello", null)`); `siteTakenBy` for Trello refuses a second connection of the same member, naming the holder.
- **`use-cases/trello-connection.ts`:** the port `TrelloConnectKit` (`checkToken`, `authorizeUrl`, `revokeToken`), a fake kit in `testing/`, and the admin use cases: `startTrelloConnection`, `saveTrelloApp`, `trelloAuthorizeUrlOf`, `checkTrelloToken`, `saveTrelloToken` (with `resumeBoardsInTx` in its transaction), `replaceTrelloToken`, `recheckTrelloToken`, `replaceTrelloAppSecret`, `reregisterTrelloWebhooks` (a job), `disconnectTrello`, `failTrelloConnection`, `trelloWebhookCallbackUrl` (the one place the URL is built), each audited with the actions of section 5.4.
- **The board's settings:** `boardMappingSchema.statusCategories` (optional, per list); `boardRefOf(board)` (the one builder of `BoardRef`, with `keyPrefix` from `Board.key` and the mapping's categories); `keyPrefixTakenBy` and `key-prefix-taken`; a Trello mapping whose steps aren't on the board's lists is refused; `attachBoard` takes and validates the prefix.
- **The lifecycle:** m11's unchanged; a Trello revoked row resumes by member ID (the existing `resumeBoardsInTx`, called by `saveTrelloToken`).
- **Every Trello caller of `BoardRef`** in `packages/domain` (sub-issues, refine, agent mode's board switch, prompt tickets, the cache's boards) moves to `boardRefOf`.
- **The words and docs:** the mapping page's "Lists" and `TR` hint, the paused board's line; `GLOSSARY.md` gains **Bot member**, **Card list** and **Trello board prefix**; `domain-model.md` gains Trello's arm.

## Done when

- [ ] Tests named for `F-153/c1`: a pending Trello row is made, the app saves with its key and secret, a token read-back reports the member and its boards, and a save stores the token and activates the row in the mode the public address implies.
- [ ] Tests named for `F-153/c2`: the token and the secret are read only from the secret store, never returned in a use case's result, and a 401 fails the connection with `token-refused` (break-it: return the token in a result field, and the test fails).
- [ ] Tests named for `F-153/c5`: `boardRefOf` carries a Trello board's prefix and categories; a duplicate prefix is `key-prefix-taken`; a mapping naming a list the board doesn't have is `unknown-mapped-statuses`.
- [ ] Tests named for `F-152/c2`: a member another connection holds is refused with its holder, and a revoked holder doesn't block.
- [ ] Tests named for `F-152/c1`: `trackerConnectionsOf` lists the Trello arm (name, username, full name, boards), and a revoked row's board resumes on the same member's new connection, and no other's.
- [ ] Tests named for `F-152/c3`: two Trello and two Linear/Jira connections in one organization, each named and kept apart; the isolation test's second organization gains a Trello connection and sees nothing of the first's.
- [ ] Tests named for `F-152/c7`: the setup step is done with a Trello connection as with any active one.
- [ ] `pnpm typecheck` and `pnpm test` for `packages/domain` and its direct consumers pass; the whole-repo checks run before the push.
- [ ] Committed as `✨ hold a Trello connection's steps and a board's settings`.
