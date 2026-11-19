# 43: The `host` executor finds Git for Windows' bash

Status: done
Builder: runner
Blocked by: none (19 is in)
Features: F-050, F-014
Packages: `packages/adapters/adapter-executor-host`, `packages/protocol` (`src/runner/config.ts`, the setting's description), `docs/configuration.md`
Spec: `../spec.md`, section 11 (item 9)

## Why

Settled as Q136, item 9, on 2026-11-19 (`context/open-questions.md`, Settled). The setup shell is `bash` from `PATH`. On the Windows machine milestone 1 was built on, `bash` isn't on `PATH` in PowerShell: Git for Windows puts only `git` there. So `ostra runner`, started the way the panel's own command says, stops at its health check and asks for `OSTRA_RUNNER_SHELL`. On a machine with WSL, `bash` is `System32\bash.exe`, the WSL launcher: the health check passes, and setup scripts run on another computer, with other tools and other paths.

## What to build

- **On Windows, `bash` means Git for Windows' own bash.** When the shell is the bare name `bash`, the executor finds it from the `git` on `PATH`: `git --exec-path` gives the install's folder, and its bash is `bin\bash.exe` under that install's root. It uses the full path.
- **Never the WSL launcher by default.** A `bash` that resolves to Windows' own `System32\bash.exe` is not used for the bare name.
- **A full path is used as given,** the WSL launcher's included, because someone asked for it. So is any other name.
- **The health check's message** says what it looked for and the fix: install Git for Windows, or set `OSTRA_RUNNER_SHELL` to a shell's full path.
- **Linux and macOS are unchanged:** `bash` from `PATH`.
- `docs/configuration.md`'s line for `OSTRA_RUNNER_SHELL` and the setting's description say the same.

## Done when

- [x] Tests with a faked `PATH` and a faked `git --exec-path`: the bare name resolves to Git's `bin\bash.exe`; with only `System32\bash.exe` to find and no Git bash, the health check is down, with the fix; a full path is used as given; on Linux and macOS nothing changes.
- [x] On this machine, `pnpm ostra runner` started from PowerShell with no `OSTRA_RUNNER_SHELL` passes its health check and runs a setup script, recorded under `## Comments`.
- [x] The settings test still matches `docs/configuration.md`.
- [x] Proof (`AGENTS.md`, `context/proof/README.md`): each test that proves a condition of a row's "done when" names the row's ID in its title and has a break-it check, its rows are in `context/proof/`, and `pnpm check:proof` passes.
- [x] Committed as `🐛 find Git for Windows' bash for setup`.

## Comments

**2026-11-19** (commit `e70ee59`): `resolveSetupShell` (`packages/adapters/adapter-executor-host/src/setup-shell.ts`) finds Git for Windows' `binash.exe` from `git --exec-path` for the bare name, never the WSL launcher, and falls back to a non-WSL `bash` on `PATH`; the health check says what it looked for and the fix. Five tests on a faked Windows machine, each broken on purpose and restored (`context/proof/F-050.md`). The live run from PowerShell follows.

**2026-11-19, live:** from PowerShell 5.1 on this machine, with no `bash` on `PATH` (only Git's `cmd` folder) and no `OSTRA_RUNNER_SHELL`, the runner (`node apps/runner/src/main.ts runner`, what `pnpm ostra runner` runs, started by `pnpm e2e:m1`'s demo with the new `OSTRA_E2E_SETUP_SCRIPT`) passed its health check, connected, and ran the project's setup script with exit code 0 before the agent started. The script's output, as core stored it: `bash 5.2.37(1)-release at /usr/bin/bash` and `system MINGW64_NT-10.0-26200`, so Git for Windows' bash, not WSL. The task opened ostra-test/test1#33, closed after the run. Record: `context/specs/m1-first-pr/live/43-git-bash/run.txt`. One thing found on the way: a runner data folder under a long path (my first try put it in a deep temp folder) fails at `git checkout` with `cannot lock ref`, Windows' 260-character limit, the same as `docs/development.md` says for the checkout.
