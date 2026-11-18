# Developing ostra

## Local secrets

This repo is public, so secrets never go in it, nor in its folder on disk. Keep them outside the repo, one file per service:

```
~/.config/ostra-dev/
├── linear.env       LINEAR_API_KEY for the test Linear workspace
├── github.env       the test GitHub App's ID, private key path and webhook secret
├── openrouter.env   OPENROUTER_API_KEY, the model key for the spikes
└── tunnel.env       whatever the chosen tunnel needs to give the dev server a public address
```

The code reads secrets only from the environment. Load a file into your shell when you need it, for example `set -a; . ~/.config/ostra-dev/linear.env; set +a`.

Develop and test only against ostra's own test workspaces: a Linear workspace and a GitHub org set up for ostra (`AGENTS.md`).

Never paste a secret into a chat, a ticket, a commit message or a log. `.gitignore` blocks common secret files (`.env`, `*.pem`, `*.key`) as a backstop, not as the plan.
