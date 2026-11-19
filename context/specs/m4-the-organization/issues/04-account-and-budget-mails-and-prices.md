# 04: Adapter SDK: account and budget mails, and four prices

Status: done
Builder: adapters (contracts, first)
Blocked by: none (milestone 3's ticket 04 lands first)
Features: F-002, F-037, F-115
Packages: `packages/adapter-sdk` (`src/notification/`, `src/model-provider/`, `src/testing/`)
Spec: `../spec.md`, section 5.2; ADR 0050, ADR 0053, ADR 0055

## What to build

- **Notification kinds:** `invitation`, `email_verification`, `password_reset`, `budget_warning` and `budget_reached`, and `Notification.category: "moment" | "account"`.
- **Account mails:** one recipient address that may belong to no member yet; no delay and no member choices apply; the channel's `send` is the same call. The panel and tracker channels refuse the `account` category with a typed error.
- **The notification contract suite gains:** an account mail carries its link in both the HTML and the text part; the link never appears in a log line, an error or any returned value but the provider's message ID; a refused recipient is reported, not thrown.
- **Prices:** `matchCatalog`'s result carries all four prices per million tokens (fresh input, output, cache read, cache write), each `null` when the source lacks it, unless milestone 2 already did (say so in `## Comments`).

## Done when

- [x] The suite passes against milestone 3's panel, tracker, Resend and SMTP adapters and their fakes.
- [x] Every caller compiles; milestone 3's kinds behave as before.
- [x] Committed as `✨ add account and budget mails to notifications`.

## Comments
- 2026-11-19, adapters (contracts): done in `✨ add account and budget mails to notifications` (a05980c). **Kinds:** `notificationKinds` keeps milestone 3's values (the database's `NotificationKind` until ticket 05 adds the new ones), and beside it `budgetNotificationKinds` (`budget_warning`, `budget_reached`, moments: `MomentNotificationKind`), `accountNotificationKinds` (`invitation`, `email_verification`, `password_reset`) and `notificationCategories`. **`Notification`** is now `MomentNotification | AccountNotification`: a moment is milestone 3's shape with an optional `category: "moment"` (absent on every milestone 3 caller, which compile and behave as before); an account mail is `{ category: "account", kind, to: { email, memberId | null }, rendered }` with its bearer link in `url`. `emailRecipients(notification)` and `emailRecipientKey` give an email channel its addresses; `RefusedRecipient.memberId` may be `null` for an address with no member. `refuseAccountMail(channel)` is the panel's and the tracker's typed refusal (`unsupported`). Resend and SMTP send an account mail through the same `send`; the panel and tracker channels (and core's recording fakes) refuse it. **Suite:** the notification fixture gains `logs`; new cases: a budget notice delivered as a moment; an account mail to an address with no member, its link in both parts; its link and address never in a log line, an error or what `send` returns (a replay, a rate limit and a refusal included); a refused address reported with `memberId: null`, not thrown; a channel without email refuses it as `unsupported`. All pass on the panel, tracker (Linear and Jira fakes), Resend and SMTP adapters and on the tiny notifiers. **Prices:** milestone 2 had added the cache prices as optional fields; `CatalogEntry`'s four prices are now required, each `null` where models.dev has none, and the model provider suite checks `matchCatalog` carries all four. Proof rows in `context/proof/F-115.md` (rows 1 and 2, still `partial`: core sends the mails in tickets 13 and 19) and a new `context/proof/F-037.md` (row 1 `partial`). F-002's mails are core's (ticket 19), so its proof is untouched. Break-it checks: logged the link in `resend.sent` and the address in `smtp.sent`; sent an account mail to no one; dropped a refused recipient; let the panel and tracker deliver an account mail; read the cache-read price from the input price; dropped the cache-write price in `matchModelsToCatalog`. Each failed its cases.
