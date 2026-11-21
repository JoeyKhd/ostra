# 11: Images and runner: the box's browser

Status: ready-for-agent
Builder: runner
Blocked by: 03
Features: F-121, F-141
Packages: `deploy/Dockerfile.base`, `deploy/notices/`, `packages/deploy-checks`, `packages/adapters/adapter-executor-docker` (`init/`), `packages/adapters/adapter-executor-kubernetes`, `packages/adapters/adapter-executor-host`, `apps/runner` (the DevTools client), `docs/configuration.md`
Spec: `../spec.md`, sections 5.2, 6 and 11; ADR 0068 ("The box's browser")

## What to build

- **The base image:** Debian bookworm's `chromium` package, at a pinned version, in the runtime stage, and its fonts (`fonts-liberation`, `fonts-noto-color-emoji`) so pages render text and emoji.
  - `pnpm check:images` checks the pin, and the notices list Chromium's licences (F-039, milestone 7's ticket 29).
  - Record the image's size before and after under `## Comments`, for ticket 34.
- **The init** (`docker` and `kubernetes`): the bridge's browser request of ticket 03, for real.
  - Start `chromium --headless=new --remote-debugging-pipe` as the agent's user, with a fresh profile in a temporary folder, `--no-first-run`, `--no-default-browser-check`, `--disable-sync`, no extensions, and no sandbox flag beyond what the container needs. Write down what Chromium's own sandbox needs in a container, and why.
  - Hand the pipe over the bridge's own channel.
  - Report `app.browser` once per box.
  - Remove the profile when the box ends.
- **The `host` process host:**
  - find a browser in the order ADR 0068 gives: `OSTRA_RUNNER_BROWSER`, then Chrome, Chromium and Edge in each OS's usual places;
  - else download Chrome for Testing's `chrome-headless-shell` at the version pinned in the runner's release, check its SHA-256 against the pin, and keep it in the runner's data folder;
  - `OSTRA_RUNNER_BROWSER_DOWNLOAD=false` skips the download and reports no browser, with the fix in the panel's words;
  - start the browser in the task's containment unit with the same flags.
- **ostra's DevTools client** in `apps/runner/src/browser/`, ported from spike 07: it opens a target, navigates, captures, screencasts with acks, dispatches input, and closes the target, over the pipe. It has a deadline on every call and refuses a reply it can't parse (Zod, tolerant of the protocol's unknown fields, since it's Chromium's format). It never passes a page's content to a log line.
- **"No browser in this box":** an organization's own base image without Chromium, or a `host` runner with none and the download off, reports `{ available: false, reason }`. The tools return that reason, and the environment page warns (ticket 17).

## Done when

- [ ] Tests named for `F-121`: on `host` here, the browser is found (Edge), started in the task's unit, takes a screenshot of the fixture app, and leaves no profile folder after the task ends; the download path checks the SHA-256 and refuses a mismatch (break-it: accept any hash, and the case fails); with the download off and no browser, the reason is reported.
- [ ] The executor suite's browser case passes on `docker` and `kubernetes` against their fakes; the `live-docker` and `live-kind` jobs carry it, marked as waiting until they run.
- [ ] `pnpm check:images` passes with the Chromium pin and its notices.
- [ ] The whole-repo checks pass (spec section 10).
- [ ] Committed as `✨ add the box's browser`.

## Comments
