# 12: The Resend email adapter

Status: ready-for-agent
Builder: adapters
Blocked by: 04
Features: F-115
Packages: `packages/adapters/adapter-email-resend` (new), `pnpm-lock.yaml`
Spec: `../spec.md`, sections 5.2 and 10; ADR 0050, ADR 0007

## What to build

Resend is the priority (ADR 0007, the maintainer: "resend is priority").

- An Apache-2.0 package with one class, `ResendEmailAdapter extends NotificationAdapter` (`name: "resend"`, `channels: ["email"]`, `edits: false`), on `resend` (MIT, confirmed 2026-11-19), pinned exactly.
- **`send`** sends `rendered.subject`, `rendered.html` and `rendered.text` from the configured from address to each recipient's email, one message per recipient (so one bounce never hides another), with Resend's idempotency key set from the notification's key and the recipient. It returns Resend's message ID.
- **`health`** checks the key with a cheap authenticated call and reports `down` with the reason (an invalid key, the domain not verified) in words, never the key.
- **Errors:** Resend's 429 becomes `rate-limited` with its retry time; a 422 for a bad address is that recipient's failure; a 401 is the adapter's.
- The key comes in the constructor from the secret store, through core; the adapter never reads the environment and never logs the key or a mail's body.
- The notification contract suite (ticket 04) passes on the fake Resend API; the live case, gated on `email.env`, sends one mail to Resend's test recipient and reads its delivery back.

## Done when

- [ ] Tests: the suite passes on the fake; the live case passes with `email.env` loaded.
- [ ] `pnpm-lock.yaml` updated in the same commit; `pnpm check:licenses` passes.
- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for the package.
- [ ] Committed as `✨ add the Resend email adapter`.

## Decided 2026-11-19

Decided on the maintainer's delegation while preparing the build, from the open points of the milestone 3 targets (`context/brand/app-targets/m3/`) and the spec's gaps. If the maintainer disagrees with one, it goes back to `context/open-questions.md` and this section changes.

- **The proof without a Resend key** (Q186). No key exists yet (ticket 51, step 1). Every done-when condition but the live case is proved on ticket 04's fake Resend API, whose request and response shapes follow Resend's API reference for `POST /emails` (the `Idempotency-Key` header, a 422 for a bad address, a 429 with `Retry-After`, a 401). The live case stays in the suite, skipped unless `email.env` holds `RESEND_API_KEY`. The ticket's "live" box stays unticked until the maintainer adds the key and runs it once, and `context/proof/F-115.md` names it as a maintainer step.

## Comments
