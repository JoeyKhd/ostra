# Developing ostra

## Local secrets

This repo is public, so secrets never go in it, nor in its folder on disk. Keep them outside the repo, one file per service:

```
~/.config/ostra-dev/
├── linear.env       LINEAR_API_KEY for the test Linear workspace
├── github.env       the test GitHub App's ID, private key path and webhook secret
├── model.env        OSTRA_DEV_MODEL_BASE_URL, OSTRA_DEV_MODEL_API_KEY and OSTRA_DEV_MODEL_ID
└── tunnel.env       whatever the chosen tunnel needs to give the dev server a public address
```

`model.env` points at any model endpoint: an API base URL, a bearer token and a model ID. ostra never assumes a particular provider, and neither does its development setup.

The code reads secrets only from the environment. Load a file into your shell when you need it, for example `set -a; . ~/.config/ostra-dev/linear.env; set +a`.

Develop and test only against ostra's own test workspaces: a Linear workspace and a GitHub org set up for ostra (`AGENTS.md`).

Never paste a secret into a chat, a ticket, a commit message or a log. `.gitignore` blocks common secret files (`.env`, `*.pem`, `*.key`) as a backstop, not as the plan.

## Working in the repo

You need Node 24.2 or newer and pnpm 11. The exact pnpm version is pinned in `package.json`, and Corepack (`corepack enable`) picks it up.

```
pnpm install      # installs every workspace package from the lockfile
pnpm typecheck    # tsc in every package, strict, through Turborepo
pnpm lint         # ESLint (typescript-eslint strict-type-checked) in every package
pnpm test         # Vitest in every package, plus the repo's own scripts
pnpm build        # Turborepo's build task, for the packages that have one
```

`pnpm format` runs Prettier over the code. `spikes/` is outside the workspace, and each spike has its own `pnpm-workspace.yaml`.

Every package is `private: true` for now, including the ones ADR 0045 lists as published (`runner`, `protocol`, `adapter-sdk` and the adapters). Their `exports` point at TypeScript source, and publishing starts at the v1 launch in milestone 7. That commit removes `private` and adds a built `exports` and `publishConfig`.

**The license check.** `pnpm check:licenses` reads every workspace package's `package.json`. It fails when a package declares no license, or when an Apache-2.0 package depends on a restricted one, today one under the Sustainable Use License, directly or through another package (ADR 0048, ADR 0045). CI runs it with the other checks, so run it before you push a new dependency between packages.
