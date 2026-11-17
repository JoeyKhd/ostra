# Agent credentials: your own on your machine, the team's keys on shared runners

**Status:** accepted (plan signed off 2026-11-17). Chosen on 2026-11-17 in grilling round 2.

- **Local runners** use the member's own agent logins.
  - A Claude subscription works only inside Claude Code itself, which Anthropic's terms allow.
  - Anthropic forbids third-party tools from routing, collecting, storing or passing on subscription credentials, so ostra never touches a Claude login.
  - A Claude subscription is never used inside OpenCode, oh-my-pi or any other agent (`research/agent-harnesses.md` §1.4).
- **Remote runners** use team API keys:
  - Admins store them in ostra, encrypted.
  - ostra passes them to the agent as environment variables for one task only.
  - They're never saved on the runner.
- **GitHub access** follows the same idea. The server mints a token that lasts one hour, covers one repo and can only push, for each git operation (ADR 0012).

## Consequences

- An agent can use any token its runner hands it, so tokens are as narrow and short-lived as possible, and the default branch must be protected (Q-14).
- Other providers' terms for subscription logins are checked per agent as adapters are added (`research/agent-roster.md`).
