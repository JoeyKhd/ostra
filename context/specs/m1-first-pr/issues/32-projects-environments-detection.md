# 32: Routers: projects, environments and detection

Status: ready-for-agent
Builder: api
Blocked by: 13, 30
Features: F-086, F-050, F-112
Packages: `packages/domain` (`src/environment/detect.ts`, `createProject`, `saveEnvironment`), `packages/api` (`src/routers/projects.ts`, `src/routers/environments.ts`)
Spec: `../spec.md`, sections 2 and 3 (step 5)

## What to build

- **Detection** (F-112), a pure function in `packages/domain`: given a repo's file list and the contents of the files it asks for, return a draft environment. No agent, no model, no network of its own. It reads:
  - lockfiles and package managers (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lock`, `package.json`'s `packageManager` and `engines`, `poetry.lock`, `uv.lock`, `requirements*.txt`, `Cargo.lock`, `go.sum`, `Gemfile.lock`)
  - tool versions (`.nvmrc`, `.node-version`, `.tool-versions`, `.python-version`, `rust-toolchain.toml`)
  - `.env.example` (variable names, values left empty, guessed secret or variable by name)
  - `devcontainer.json` (image, `postCreateCommand`)
  - compose files (services, drafted and marked "not run on `host`")
  - It returns the setup script lines, the variables, the services and a list of what it found and why, so the panel can show its reasons.
- **Projects:** `projects.create` (name, one repo from the App's installation; creates the project, the repo link, the project's pool link to the default pool, the default agent profile per kind, and the environment from detection as a draft), `projects.list`, `projects.get`.
- **Environments:** `environments.get` (the draft or saved environment, secrets masked), `environments.save` (setup script, variables, secrets through the secret store, files; each entry names one repo of the project; a service on a project whose only runner is `host` is saved with a warning). Project admins and organization admins only.

## Done when

- [ ] Detection has a test per file type above, and a fixture repo with several at once.
- [ ] Gated live: detection on `ostra-test/test1` returns a draft, and its reasons name the files it read.
- [ ] Routers: an admin creates a project on `test1` (fake GitHub), a member can't save its environment, another organization can't see it, and no router returns a secret's value.
- [ ] The whole-repo checks pass (spec section 9: the schema's data, secrets).
- [ ] Committed as `✨ add projects, environments and detection`.

## Comments
