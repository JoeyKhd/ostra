# 14: OpenCode adapter: the app tools, the app's block, and servers without sign-in

Status: done
Builder: adapters
Blocked by: 01
Features: F-121, F-140, F-145
Packages: `packages/adapters/adapter-opencode`
Spec: `../spec.md`, sections 5.1 and 6; ADR 0068 ("One origin is the convention"); ADR 0069 ("Delivery: unchanged")

## What to build

- **The app tools in the MCP list.** For a task whose spec has `"app"`, the four tools appear among ostra's server's tools in OpenCode's config, as `submit_draft` and its siblings do (milestone 6's ticket 09). They're absent otherwise. "Reaching the network" (ADR 0049) doesn't ask before them: they reach only the box.
- **The app's block in the instructions.** The fixed words of ticket 01 (`prompts.ts`), beside the profile's instructions and the repo's `AGENTS.md`:
  - each process's label and in-box address;
  - that ostra runs the processes (`start_app`), and that a dev server the agent starts itself is shown with `show_preview`;
  - that the browser stays on the primary's origin with the API behind the frontend's dev-server proxy;
  - where the logs are.

  A task with no app processes gets no block.
- **`oauth: false` on every proxied remote server** (research §7.2, fix 3), so OpenCode never starts a sign-in inside the box. This covers a profile's own HTTP servers and the library's alike.
- **The agent contract suite on OpenCode:** the app tools listed and absent; the block present and absent; a proxied server written with `oauth: false`.

## Done when

- [x] Tests named for `F-140`: the block's content for a task with processes, and none without.
- [x] Tests named for `F-121`: the tools listed for a task with `"app"` and absent without.
- [x] Tests named for `F-145`: every proxied server has `oauth: false` (break-it: drop it, and the case fails).
- [x] The agent contract suite passes on OpenCode with the stub model.
- [x] The whole-repo checks pass, since this touches what runs agent output (spec section 10).
- [x] Committed as `✨ give OpenCode the app tools and app block`.

## Comments

- 2026-11-21, adapters: committed as `✨ give OpenCode the app tools and app block`, on ticket 03's contract commit (`de0427d7`), which carries the SDK's half: `LaunchApp`, `PrepareLaunchInput.app`, the block in `composeLaunchInstructions`, the suite's `agent-app-cases.ts` and the fake core's app tools. What this ticket adds:
  - **OpenCode's config** (`packages/adapters/adapter-opencode`): the four app tools are denied unless the task's tool sets hold `app` (`appTools` beside milestone 6's in `toolFilterPermissions`); with no sets at all, as from a runner before minor 5, nothing is filtered, as before. They sit under no approval rule, so "Reaching the network" and a rule on MCP tools ask before none of them, and the plan agent's denies leave them alone. The instructions file takes the app's block when the launch's `app` has a process, after the profile's instructions and the memory block and before the repos' `AGENTS.md`, naming the app tools only when the task has them. Every remote server, ostra's own included, is written with `oauth: false` (`REMOTE_MCP_OAUTH`).
  - **The runner** (`apps/runner`, `task-host/app-block.ts`): the launch's `app` from the spec's `environment.appProcesses` and its services with a port, at their in-box address on the executor (by name on `docker`, `localhost` on `kubernetes`, none on `host`, ADR 0029's first difference). The runner can't import the domain's `appAddresses` (the license line), so `inBoxServiceAddress` holds the same rule on the runner's side; ticket 12 can use it for the `OSTRA_SERVICE_*_URL` variables.
  - **OpenCode's fixture** gains the `app` probe, so the suite's four app cases run on OpenCode in both formats (the one for an agent without MCP skips, as OpenCode has it).
  - **The parity table** gains spec section 6's four agent rows: the app tools, the app's block, the library's skills and the library's MCP servers. OpenCode's name its cases; the scripted fakes' app rows wait for their app probes (ticket 03), and their library rows are the profile's case, since a library item reaches an agent as a profile's does.
  - **`oauth: false` on OpenCode 2.3.2,** read from the pinned binary's source: `Mcp.RemoteConfig.oauth` is an OAuth config or `false`, and only a remote server whose `oauth` isn't `false` gets an OAuth integration, through which `opencode mcp auth <server>` (the agent's own shell could run it) starts a sign-in with a callback listener on `127.0.0.1:19876`. On connect, OpenCode fetches no OAuth metadata either way, so the live case (a server that answers every call with an OAuth challenge) shows the pinned binary takes the key, calls the server once, fetches nothing else and lists none of its tools; the config case (`F-145/c12: every remote MCP server in OpenCode's config says oauth: false …`) is the one that fails with the key dropped. No break-it pass ran, under the maintainer's 2026-11-21 change.
  - **Not run in tests:** `opencode mcp list` and `opencode mcp auth` start OpenCode's managed service on a fixed port (28894) and leave it running after they exit.
  - **Tests:** `F-121/c1`, `F-140/c4,c9`, `F-140/c10` and `F-145/c12` in the adapter's unit tests (`permissions.test.ts`) and on the pinned OpenCode with the stub model (`opencode-adapter.contract.test.ts`, its new milestone 8 cases and the suite's app cases); `F-140/c10` in the runner, as a unit test of the launch's app and a real OpenCode run through the task host (`app-block.opencode.test.ts`). The keys count the sentences of each row's "done when".
  - **Checks:** the whole repo's typecheck; lint and tests of `packages/adapter-sdk`, `packages/adapters/adapter-opencode`, `apps/runner` and `apps/docs`, on the lead's rules of 2026-11-20.
  - **Docs:** the adapter's README and the OpenCode page say that OpenCode never signs in to an MCP server. The app tools and the block wait for ticket 32's pages, since the sidecar doesn't serve the tools yet (ticket 13) and core sends no app process yet (ticket 15).
