# 10: The maintainer's steps outside the code

Status: ready-for-agent
Builder: maintainer
Blocked by: none for the test account; 09 for the review of the run
Features: F-153
Packages: none (an account, an app, a bot member, boards, a tunnel, secrets)
Spec: `../spec.md`, sections 1, 3 and 11; ADR 0072

## What to build

| What | Needed for | Notes |
|---|---|---|
| A Trello test account, separate from any real team's | Every test and the demo | Never a production account; the boards hold only test cards |
| A Trello app on `trello.com/apps/admin` (a Power-Up, its **Trello Auth** tab), with its API key and secret | The two connect steps, the webhook's HMAC | The organization's own app; whether an app needs a paid Workspace is recorded |
| A dedicated **bot member** added to two test boards, one with the six lists (`Backlog`, `To Do`, `Doing`, `Review`, `Done`, `Won't do`), cards including one with a checklist, a label, two members and an uploaded image and a `.docx` | The demo's steps 6 to 12 | The bot member presses Allow, or the admin pastes a token from its Token link (never a person's token) |
| `~/.config/ostra-dev/trello.env`: the key, the secret and the bot member's token | The manual run and the live test | Outside the repo; read with `set -a; . ~/.config/ostra-dev/trello.env; set +a`; never printed, logged or committed |
| A public HTTPS address for the dev server (the tunnel milestone 2 uses for Linear) | The webhook path and `HEAD` | A Cloudflare quick tunnel, started when the run needs it; installing it asks the maintainer first |
| A decision on the seat and the terms (spec section 11) | Shipping the feature | Whether a bot member costs a seat on a paid Workspace, and whether Trello's Developer Terms allow a self-hosted tool to hold the token (unread) |
| A read of the live run's findings | Ticket 09 | The five unverified vendor details the run settles |

## Done when

- [ ] The account, the app, the bot member and the two boards exist, and the token's grant is the bot member's, with `expiration=never`.
- [ ] `~/.config/ostra-dev/trello.env` holds the three values, and a read of them by ticket 03's live test passes against the real API.
- [ ] The seat and terms questions are answered, or recorded as accepted risks in ADR 0072's amendments.
- [ ] The run's findings are reviewed and either folded into the docs and the fake or noted as open questions.
