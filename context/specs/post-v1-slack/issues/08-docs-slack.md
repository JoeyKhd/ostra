# 08: Docs: Slack

Status: ready-for-agent
Builder: core
Features: F-057
Packages: `apps/docs`, `docs/configuration.md`, `README.md` only if its feature list names Slack
Blocked by: 06
Spec: `../spec.md`, sections 4.8 and 4.9; ADR 0050, ADR 0074

## What to build

- **A Slack page** under the panel's integrations:
  - what the channel does: the moments, per member, DMs only, never a shared channel;
  - the app: the manifest ostra shows, the bot scopes `chat:write` and `users:read.email` and why each, the redirect URL `<OSTRA_PUBLIC_URL>/api/slack/callback`, and the HTTPS requirement (Slack's OAuth guide);
  - installing: create the app, copy the client ID and secret, save, **Add to Slack**, the read-back and the connected state; the locked form when `OSTRA_SLACK_*` sets it;
  - the member's side: the column, off by default, the matched `@name`, the "No Slack account" case (ask a Slack admin to add the address);
  - the DM's contents: the same list ADR 0050 gives a mail, and what it never carries;
  - answers: in the panel, never from Slack; the message is edited to say who answered;
  - token renewal with rotation on, the 12-hour life and the refresh; what happens without rotation;
  - disconnect: deletes every secret, stops DMs, keeps member choices for a reinstall;
  - troubleshooting: the error states (`invalid_auth`, `token_revoked`, `missing_scope`, `ratelimited`), where to fix each, and that stack traces never show a token.
- **`docs/configuration.md`:** the four settings with their defaults, as section 4.8's table; the HTTPS consequence in the Slack row.
- **Organization › Email's docs page:** a line that Slack is a separate channel with its own page and link.
- **`README.md`:** only if its feature list becomes wrong; a Slack line joins the notifications sentence.

## Done when

- [ ] Tests named for `F-057/c1`: the docs' manifest, scopes and redirect URL match the code's constants (a test reads the constants and the page's text), and the install steps name every field the page asks for.
- [ ] Tests named for `F-057/c2`: the page says only "set"/"not set" for secrets and never prints a value shape.
- [ ] Tests named for `F-057/c8`: the page says Slack is optional and that everything else works without it; the configuration reference's four lines parse and match `settings.ts`.
- [ ] The docs' commands run (`apps/docs`'s own check), and no link is dead.
- [ ] Committed as `📝 document Slack notifications`.

## Comments
