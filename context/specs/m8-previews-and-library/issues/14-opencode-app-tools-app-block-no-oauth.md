# 14: OpenCode adapter: the app tools, the app's block, and servers without sign-in

Status: ready-for-agent
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

- [ ] Tests named for `F-140`: the block's content for a task with processes, and none without.
- [ ] Tests named for `F-121`: the tools listed for a task with `"app"` and absent without.
- [ ] Tests named for `F-145`: every proxied server has `oauth: false` (break-it: drop it, and the case fails).
- [ ] The agent contract suite passes on OpenCode with the stub model.
- [ ] The whole-repo checks pass, since this touches what runs agent output (spec section 10).
- [ ] Committed as `✨ give OpenCode the app tools and app block`.

## Comments
