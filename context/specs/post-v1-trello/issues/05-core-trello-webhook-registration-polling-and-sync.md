# 05: Core: the Trello webhook and HEAD, registration, polling, sync and context

Status: ready-for-agent
Builder: core
Blocked by: 03, 04
Features: F-153, F-042, F-149
Packages: `apps/core` (`tracker/connections.ts`, `webhooks/inbox.ts`, `webhooks/process.ts`, `tracker/registration.ts` new, `tracker/ingest.ts`, `tracker/writer.ts`, `tracker/context.ts`, `refine/apply.ts`, `settings.ts`), `apps/core/src/testing/`
Spec: `../spec.md`, sections 4 and 5.6; ADR 0072; ADR 0071

## What to build

- **`buildTracker` gains `"trello"`:** `new TrelloAdapter({ apiKey, token, apiUrl }, context)` from the row's `apiKey` and `accessTokenSecretRef`'s token (`TrackerBuildInput` gains an arm for the key; the app secret is `webhookSecretSecretRef`, which the inbox already reads); `trackerKindCapabilities` gains `TRELLO_CAPABILITIES`; `verifyOnlyTrackers` gains a Trello verifier constructed with placeholder key and token (verification is pure: it uses the per-delivery secret and callback URL).
- **The webhook route:** `HEAD` and `POST /webhooks/trello/:id`; `HEAD` answers 200 for a connection not revoked (404 unknown, 410 revoked) with no secret read; `POST` computes the callback URL once from `OSTRA_CORE_PUBLIC_URL` through the domain's `trelloWebhookCallbackUrl`, passes it to `verifyWebhook`, claims `(connectionId, action.id)`, answers 200, then enqueues processing. `WebhookKind` gains `"trello"`.
- **Processing:** the `trello` handler parses the hint, records and skips the bot member's own writes, fetches the card through the connection's adapter and ingests it; a list action re-reads the board's statuses so a renamed or added list shows.
- **Registration:** `tracker/registration.ts`'s `ensureBoardWebhooks(connection, boards)` and `removeBoardWebhooks(connection, boards)`, called on attach, detach, activation, disconnect and `Re-register webhooks`; a failure is a retried job and one needs-you item, never a failed activation.
- **Polling and sync:** the poll set includes Trello boards; the 60-second poll and 5-minute backstop are unchanged; `boardRefOf` in every adapter call; `moveTicket`'s `via: []` draws the "On Trello" rows with the target list's name; a card's checklist text arrives inside the description.
- **A saved token's 401:** the adapter's `unauthorized` on any call calls the domain's `failTrelloConnection(tx, id, "token-refused")`, which pauses the boards (m11's derivation).
- **Settings:** `OSTRA_TRELLO_API_URL` and `OSTRA_TRELLO_AUTHORIZE_URL`, defaulting to Trello's own; the existing poll and public-URL settings unchanged.

## Done when

- [ ] Tests named for `F-153/c3`: `HEAD` answers 200 for a pending, active or failed connection and 404/410 for unknown/revoked; a signed POST verifies with the derived callback URL, is stored once for `action.id`, answers 200 before work and ingests one ticket; a wrong signature is refused and counted (break-it: drop the callback URL from the HMAC, and the case fails).
- [ ] Tests named for `F-153/c4`: a card changed on the fake reaches the Inbox within 60 s by polling alone; the backstop sets `webhooksSilentSince` when it finds what no delivery brought.
- [ ] Tests named for `F-153/c2`: a 401 from a saved token fails the connection `token-refused` and pauses its boards; no key, secret or token reaches a log line or an event (searched by value).
- [ ] Tests named for `F-153/c5`: a card's move by ticket sync writes its list through the connection's adapter with `via: []`; the task's rows name the list.
- [ ] Tests named for `F-153/c6`: the first message's "What the agent got" holds a card's Markdown, checklists, comments, labels, member and files; a download's credential never leaves core.
- [ ] Tests named for `F-153/c7`: the task's and the PR's links are attachments once per URL, and an edited comment updates in place.
- [ ] Tests named for `F-153/c8`: an intake rule, a schedule, Create ticket, a prompt ticket, reopen and notifications each work on a Trello board.
- [ ] Tests named for `F-153/c3`: attaching a board registers one webhook, detaching deletes it, and `Re-register webhooks` replaces the URL after `OSTRA_CORE_PUBLIC_URL` changes.
- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` for `apps/core` and its direct consumers pass; the whole-repo checks run before the push.
- [ ] Committed as `✨ run Trello's webhooks, registration and polling`.
