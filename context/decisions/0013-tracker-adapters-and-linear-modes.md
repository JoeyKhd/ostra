# Every tracker is an adapter; Linear works in two modes

**Status:** accepted (plan signed off 2026-11-17). Amended 2026-11-18: the decision stands, with a pointer to the Jira sign-in ADR, and the Linear app is registered by each organization, not each install (Q-20, Q102, ADR 0047). Chosen on 2026-11-17 in grilling round 2. The maintainer: "make sure each PM tool is an adapter".

- **Each tracker is an adapter** behind one tracker interface. Things only some trackers have, such as Linear's native agent sessions, are declared capabilities (adapter parity in `AGENTS.md`).
- **Linear ships in v1, Jira in the first release after it.** A Jira test during planning makes sure the interface isn't shaped only for Linear (`research/trackers.md`). Jira signs in through a service account that the organization owns, plus one admin webhook, as ADR 0047 records.
- **Linear works in two modes, on one Linear app** that each organization registers itself:
  - **Always:** the plain API for picking up tickets, statuses, comments and PR links. It uses webhooks when Linear can reach the install, and checks Linear regularly when it can't.
  - **With a public HTTPS address:** native Linear agent mode. People hand a ticket to ostra inside Linear, see a live agent session on it, and can stop it or send follow-ups from there.
- **Private installs** work fully, just without agent mode. The docs show how to get a public address through a reverse proxy, Cloudflare Tunnel or Tailscale Funnel.

## Consequences

- Linear agent mode has to answer within 5 seconds, post its first update within 10 seconds, and post again at least every 30 minutes. That's the server's job, not the runner's.
- ostra works with Linear's own GitHub integration, not against it. The ticket ID goes in the branch name and PR title, so Linear links them by itself.
