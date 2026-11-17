# keys/

Local secrets for developing ostra. Everything in this folder except this file is gitignored (`AGENTS.md`). The code reads secrets from the environment, and never from a committed file.

| File | Holds | Needed from |
|---|---|---|
| `linear.env` | `LINEAR_API_KEY` for the test Linear workspace | Milestone 0 (spike 3) |
| `github.env` | The test GitHub App's ID, private key path and webhook secret | Milestone 0 (spike 4) |
| `tunnel.env` | Whatever the chosen tunnel needs to give the dev server a public address | Milestone 0 (spike 3) |
| `anthropic.env` | `ANTHROPIC_API_KEY`, only for shared remote runners and CI (ADR 0014). Local work uses your own Claude Code login | Milestone 4 |

Never paste a secret into a chat, a ticket, a commit message or a log.
