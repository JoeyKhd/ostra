# 04: Adapter SDK: account and budget mails, and four prices

Status: ready-for-agent
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

- [ ] The suite passes against milestone 3's panel, tracker, Resend and SMTP adapters and their fakes.
- [ ] Every caller compiles; milestone 3's kinds behave as before.
- [ ] Committed as `✨ add account and budget mails to notifications`.

## Comments
