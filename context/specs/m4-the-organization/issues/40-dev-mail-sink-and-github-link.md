# 40: Dev tools: the mail sink and the dev GitHub link

Status: resolved
Builder: core
Blocked by: 05
Features: F-002 and F-104 (their demo), F-115
Packages: `scripts/` (`dev-mail-sink.ts`, `dev-link-github.ts`), `package.json` (`pnpm dev:mail-sink`, `pnpm dev:link-github`), `docs/development.md`
Spec: `../spec.md`, sections 3 and 8; ADR 0053 ("For development only")

## What to build

- **`pnpm dev:mail-sink`:** milestone 3's fake SMTP server (`EHLO`, `STARTTLS` refused, `AUTH PLAIN`, `MAIL`, `RCPT`, `DATA`) as a long-running process on loopback, writing each message to `.data/mail/<time>-<to>.eml`. A helper in `e2e/` reads the newest mail to an address and returns its subject and its links. The dev stack points SMTP at it with `OSTRA_EMAIL_PROVIDER=smtp` and loopback settings that `docs/development.md` lists.
- **`pnpm dev:link-github <username> <github-login>`:** reads the GitHub user's numeric ID with the test token from `github-test.env`, and writes the link on the account as F-119's callback would (`githubUserId`, `githubLogin`, `githubLinkedAt`), with an audit entry naming the dev tool.
- **Both refuse to run** unless `NODE_ENV` is `development` or `test`, and the production build includes neither (a test checks the build's file list).

## Done when

- [x] Tests: the sink stores a mail sent by milestone 3's SMTP adapter and the helper finds its link; `dev:link-github` refuses with `NODE_ENV=production`; neither script is in the production build.
- [x] `docs/development.md` names both, and the settings for the sink.
- [x] Committed as `🔧 add the mail sink and the dev GitHub link`.

## Comments

- 2026-11-19: built in `e2e/dev-tools/` (`@ostra/dev-tools`), a workspace package that neither core nor the panel depends on, rather than the root `scripts/`: the root can't import workspace packages, and `turbo prune` leaves the package out of the server image, which the test checks by running the prune. The sink writes to `.ostra-dev/mail/` (the dev data folder, gitignored and cleared by `pnpm dev:reset`) instead of `.data/mail/`. It offers no `STARTTLS`, so the dev stack uses `OSTRA_SMTP_SECURE=none`. The fake SMTP server gained `port` and `onMessage`, and `@ostra/adapter-email-smtp` exports `./read-mail` for the mail box helper. `NODE_ENV` unset counts as development, as for `pnpm dev:seed-member`. Commit: 16d8f56.
