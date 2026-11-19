# 40: Dev tools: the mail sink and the dev GitHub link

Status: ready-for-agent
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

- [ ] Tests: the sink stores a mail sent by milestone 3's SMTP adapter and the helper finds its link; `dev:link-github` refuses with `NODE_ENV=production`; neither script is in the production build.
- [ ] `docs/development.md` names both, and the settings for the sink.
- [ ] Committed as `🔧 add the mail sink and the dev GitHub link`.

## Comments
