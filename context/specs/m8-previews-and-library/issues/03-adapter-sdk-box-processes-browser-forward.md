# 03: Adapter SDK: the box's processes, browser and forward, and the suites' cases

Status: ready-for-agent
Builder: adapters
Blocked by: 01
Features: F-121, F-140, F-141, F-143
Packages: `packages/adapter-sdk`, `packages/adapters/adapter-executor-docker`, `packages/adapters/adapter-executor-kubernetes`, `packages/adapters/adapter-executor-host`
Spec: `../spec.md`, sections 5.2 and 6; ADR 0068 ("The box's browser", "The preview connection")

## What to build

The interfaces and the fakes that tickets 11, 12, 13, 18 and 22 build on. The init is the same program on `docker` and `kubernetes`, and the `host` executor's process host offers the same operations in the runner's own process.

- **The init's bridge protocol** (`adapter-executor-docker/src/bridge/`, shared with `kubernetes`), new requests:
  - **A process with a log:** start a long-running process from an argument array in a folder, with variables, its stdout and stderr to a log file in the task's config folder; report its exit with the code; stop it. It runs as the agent's user, as every process the init starts.
  - **The browser:** start Chromium with `--remote-debugging-pipe`, `--headless=new`, a fresh profile in a temporary folder, and no first-run or sync, and hand the caller the pipe as its own channel on the bridge, so frames never wait behind control. Report `{ name, version }`, or `{ available: false, reason }` when the image has none.
  - **A forward** (`docker`): listen on the box network at a port the init picks, accept only the sidecar's address, and dial `127.0.0.1:<port>` for each connection.
- **The `host` executor's process host:** the same three. Processes run in the task's containment unit (ADR 0029), and the browser is a process there too. `host` doesn't forward: the runner reaches `127.0.0.1` itself.
- **`ExecutorAdapter` capabilities, new:** `boxBrowser: "image" | "machine"` and `appReach: "forwarder" | "loopback"`. `docker` declares `image` and `forwarder`, `kubernetes` `image` and `loopback`, and `host` `machine` and `loopback`.
- **The fakes:** the fake Docker engine and the fake Kubernetes API (milestone 5) answer the new bridge requests with a fake process, a fake browser that speaks enough of the DevTools protocol over the pipe (`Target.createTarget`, `Page.navigate`, `Page.captureScreenshot`, `Page.startScreencast` with acks, `Input.*`), and a forward to a fake listener.
- **The fixture app** every later ticket tests against, `e2e/m8-previews-and-library/fixtures/test-web/` (spec section 9): a Vite and React frontend whose `server.proxy` sends `/api` to a small Node API on 3001, a docs page on 4000, a page that sends `X-Frame-Options: DENY`, a page that builds a URL from `Host`, a WebSocket echo, and a counter button. It's a private workspace package that uses only versions already in `pnpm-lock.yaml` (Vite through Vitest, React from `apps/web`). If it needs anything new, stop and ask first, with its ADR 0007 line drafted. A Next.js 16 page for the native preview's tests sits beside it, on the `next` already in the lock.
- **The executor contract suite** gains, on each executor:
  - a process started, ready, logged and stopped with the box;
  - a crashed process reported with its exit code;
  - the browser started, a page loaded at the app's `localhost` and a screenshot taken;
  - a forward to an app port (`docker`), and one to a reserved port refused;
  - the browser's profile folder gone after the box ends.

  It runs against the fakes here, live on `host`, and live in the `live-docker` and `live-kind` jobs when they run.
- **The agent contract suite:**
  - the `app` tools listed for a task whose spec has `"app"`, and absent otherwise;
  - a scripted fake that calls `take_screenshot` gets the tool's result;
  - a new scripted fake without `mcp`, whose task still gets the after-turn screenshots.
- **The parity test** gains the rows of spec section 6's first table.

## Done when

- [ ] Tests named for `F-140` (processes), `F-121` (the browser and a screenshot) and `F-143` (the forward), passing on every executor's fake and live on `host`. The reserved-port refusal has a break-it (allow any port, and the case fails).
- [ ] The parity test names a case or a declared fallback for every new row.
- [ ] The whole-repo checks pass (spec section 10).
- [ ] Committed as `✨ add box processes, browser and forward`.

## Comments
