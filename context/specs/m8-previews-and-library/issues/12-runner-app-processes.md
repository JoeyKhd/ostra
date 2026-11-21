# 12: Runner: app processes

Status: ready-for-agent
Builder: runner
Blocked by: 01, 03
Features: F-140
Packages: `apps/runner` (`task-host/`, `sidecar/`), `packages/adapters/adapter-executor-docker` (`init/`), `packages/adapters/adapter-executor-host`
Spec: `../spec.md`, sections 4 ("An app process"), 5.1 and 6; ADR 0068 ("The app's processes")

## What to build

- **Starting them.** On `start_app`, the after-turn screenshots, a preview opened, or `app.start`, the runner starts the spec's app processes that aren't running, in the list's order:
  - through the init on `docker` and `kubernetes`, and in the containment unit on `host`;
  - from the command as an argument array (`sh -c <command>` only because the command is the project's own line, in the repo's folder, never with ticket or agent text in it);
  - with the repo's variables and secrets as the setup script gets them;
  - with `OSTRA_APP_<NAME>_URL` and `OSTRA_SERVICE_<NAME>_URL` from `appAddresses` (ticket 05).
- **Ready.** Each process's ready check, every 2 s for at most 120 s: an HTTP `GET` of the path answering below 500, a command exiting 0, or the port accepting a connection. Then `app.process ready`.
- **Logs.** Each process's output goes to `.ostra/app/<name>.log` in the task's config folder, never in a repo, capped at 4 MiB with the oldest lines dropped *(working value)*. A process that exits sends `exited` (code 0 after `stop`) or `failed` with its exit code, its last 64 KiB as an `app-log` blob, and a reason in ostra's words. The log's text is never in a log line.
- **Stopping.** `app.stop`, and the box's end, stop them with their trees.
- **A port already taken** (the agent ran its own dev server on the primary's port): the start reports `failed` with "port 5173 is already in use in this box", and the tool's result tells the agent to stop its own or announce it with `show_preview`.
- **Announced previews.** `show_preview` checks the port against `mayReach` (ticket 05) and the limit, adds it to the task's previews, and sends `preview.list`. The runner sends `preview.list` at box start with the declared ones too.
- **`dispatch.purpose: "app"`:** the box starts as for a reopen (the snapshot, the branches, the hidden ref), runs the setup, starts the processes, and launches no agent and no driver session. A turn on the same lease later launches the agent and restores its session from the archive (ADR 0039).
- **Services as previews:** a service with a preview label is listed in `preview.list`, reached by its name on `docker` and at `localhost` on `kubernetes`. A `host` runner never gets one (ADR 0029's first difference).

## Done when

- [ ] Tests named for `F-140`, on `host` live with the `test-web` fixture and on `docker` and `kubernetes` against their fakes:
  - processes in order, each ready, logged, and stopped with the box;
  - a crashed process reported with its code and its log's blob;
  - the addresses in each process's environment, and the frontend's `/api` answered through Vite's proxy;
  - a taken port reported;
  - an announced port added and a reserved one refused (break-it: skip `mayReach`, and the case fails).
- [ ] Tests named for `F-141`: `purpose: "app"` starts the processes and no agent: the key proxy counts no call, and no ACP process exists in the box.
- [ ] A test that feeds a process's log with shell syntax and prompt-like text, and finds none of it in a log line or an argument list.
- [ ] The whole-repo checks pass (spec section 10).
- [ ] Committed as `✨ run the app's processes in the box`.

## Comments
