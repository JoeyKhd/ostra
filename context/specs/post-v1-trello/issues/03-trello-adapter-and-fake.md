# 03: Trello adapter: the client, cards, lists, keys, webhooks, files, polling and the fake Trello

Status: ready-for-agent
Builder: adapters (the Trello agent)
Blocked by: 02
Features: F-153, F-149 (Trello's parity), F-042 (polling)
Packages: `packages/adapters/adapter-trello` (new, Apache-2.0), `packages/adapter-sdk/src/testing/fake-trello/` (new), the suite's subject and fixture
Spec: `../spec.md`, sections 5.3, 6, 7 and 11; ADR 0072; `research/trello-and-notion.md` §1

## What to build

Everything in section 5.3's list, in short:

- **The REST client:** hand-written on `fetch` against `https://api.trello.com/1` (or `OSTRA_TRELLO_API_URL`), `Authorization: OAuth oauth_consumer_key="…", oauth_token="…"`, a timeout per call, Zod schemas at every response that tolerate unknown fields, errors with the status code and Trello's error code, never its body.
- **Two rate budgets** per connection from `plumbing.rateBudget`, named by credential digests: 100/10 s per token and 300/10 s per key (shared by connections that share a key), the `/1/members/` 100/900 s budget, a window wait on 429 and a longer backoff after `API_TOKEN_DB_LIMIT_EXCEEDED`.
- **Boards and lists:** `listBoards` the bot's open boards (`key: ""`); `listStatuses` the board's lists in `pos` order, each with the admin's category when `BoardRef.statusCategories` has one, else the documented name guess, `vendorType: "list"`.
- **Cards:** `getTicket` by stable `id` and by `TR-12` (the prefix from `BoardRef.keyPrefix`; a key lookup scans the board's cards); `listTickets` by `dateLastActivity` (inclusive, oldest first, a bounded page, an opaque cursor) filtered by `idList`; name, Markdown `desc`, URL, labels, first member, no priority, no sub-issues.
- **Statuses:** `updateStatus` and `moveTicket` write `idList`, `moved: false` when already there, `via: []`; `readWorkflow` stays the base's `unsupported`.
- **Comments and links:** `comment` (a `commentCard` action), `updateComment` (ostra's own), `linkPullRequest`/`linkTask` as URL attachments once per URL, `detectCodeHostIntegration: false`.
- **Context:** comments from `commentCard` actions (unthreaded), attachments (link vs upload), checklists appended as a `## Checklists` section, empty parent/children/linked, files = uploads (and a Markdown link to the card's own attachment URL), images = image uploads.
- **Files:** `attachFile` with ostra's marker in the name, `listAttachments` reading the marker back in `subtitle`, `downloadFile` with the key and token only to `api.trello.com`, one credential-less hop to storage, `maxBytes`; the doc amendment of section 5.2 in the same commit.
- **Webhooks:** `verifyWebhook` HMAC-SHA1 base64 over raw body + `request.callbackUrl` with the app secret, constant-time, delivery ID `action.id`, `sentAt` `action.date`, 30-minute freshness when a date exists; `parseWebhook` for the card, comment, attachment, member, label and list actions with `byOwnUser` from `memberCreator`; `ensureBoardWebhook`/`removeBoardWebhook` by callback URL and board, `description` ostra's marker.
- **Tickets:** `createTicket` into the first open-category list else the first list; `updateTicket` writes `desc` and refuses `acceptanceCriteria`; `getUser`; `findUsersByEmail` stays `unsupported`.
- **Polling:** everything works with `webhooks` unused (`listTickets` with `updatedSince`).
- **The declared capabilities** of section 6, including `webhookRegistration: true`, `richText: "markdown"`, `ticketFiles: "all"`.
- **The connect kit** (`connect.ts`): `trelloConnect.checkToken`, `.authorizeUrl`, `.revokeToken`, as section 5.3 lists, each taking `{ apiUrl, fetch, timeoutMs }` and answering the adapter's own result types.
- **The fake Trello** in `testing/fake-trello/`, in `fake-jira`'s house style: key+token auth with 401, two bot members and their boards, lists with `pos`, cards with `idShort`, labels, members, actions, comments, checklists, uploads and link attachments, the download route with an optional credential-less 302, a real `HEAD` check on webhook creation, signed and wrongly signed deliveries on demand, a 429 with the rate headers, and a record of each request's bot member, credential digest and host.
- **The suite's fixture and subject:** `adapter-trello` against the fake, every case the in-memory Jira fake passes, the four new cases of ticket 02 and the two-site case.

## Done when

- [ ] Tests named for `F-153/c2`: every call carries the key and token; a 401 on the saved token is `token-refused`/`unauthorized` and the message, a log line or an error holds neither credential.
- [ ] Tests named for `F-153/c3`: a delivery signed over body + callback URL verifies; a wrong URL, secret or re-serialized body is refused; `action.id` is the delivery ID; the bot's own write is `byOwnUser`; `ensure` creates once and `remove` deletes.
- [ ] Tests named for `F-153/c4`: `listTickets` pages by `dateLastActivity` oldest first, inclusive of its time, with `updatedSince`; nothing needs a webhook.
- [ ] Tests named for `F-153/c5`: `TR-12` from `idShort` and the board's prefix; a stable ID never changes on a cross-board move; a move writes `idList` and answers `via: []`; a key of another board is `not-found`; the admin's categories win over the name guess.
- [ ] Tests named for `F-153/c6`: a card's name, description, checklists in the description, comments, labels, first member and attachments read; no parent, children or linked; a download sends the credential only to `api.trello.com` and follows one hop without it; `attachFile`/`listAttachments` round-trip the marker.
- [ ] Tests named for `F-153/c9`: the tracker contract suite passes for `adapter-trello` against the fake Trello, and the capabilities declare no agent sessions, no transitions, no sub-issues and no mentions (break-it: declare `mentions: true`, and the parity row fails).
- [ ] `packages/adapters/adapter-trello` has its `LICENSE` (Apache-2.0), its `package.json` with no new dependency, and passes `pnpm check:licenses`.
- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` for `adapter-trello` and `adapter-sdk` pass; the whole-repo checks run before the push.
- [ ] Committed as `✨ add the Trello tracker adapter`.

## Comments

- The live details of section 11 (the download's redirect, the board-cards paging, the payload's field names, the description's and an upload's size limits) are confirmed by ticket 09's run; ticket 03 records what it assumes in `packages/adapters/adapter-trello/README.md`, under "What waits for a real account".
