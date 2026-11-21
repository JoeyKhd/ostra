# 02: Adapter SDK: images in an agent's prompt

Status: done
Builder: adapters
Blocked by: 01
Features: F-148
Packages: `packages/adapter-sdk` (the agent base, the ACP driver, the testing kit), every agent adapter's capabilities in the same commit
Spec: `../spec.md`, sections 5.2 and 6; ADR 0070; `research/attachments-for-agents.md` §1 to §4

## What to build

- **Capability:** `promptImages: boolean` on `AgentCapabilities`, declared by every adapter in the same commit (OpenCode `true` in ticket 09; the tiny adapters `false`).
- **The prompt:** the session's `prompt` and `steer` take `AgentPromptInput` (`{ text, images }`), and every caller in `apps/runner` passes `{ text, images: [] }` until ticket 13. The driver:
  - reads `agentCapabilities.promptCapabilities.image` from `initialize`, and keeps it on the connection;
  - sends `[{ type: "text", text }, ...images as { type: "image", mimeType, data }]` in `session/prompt` and in `_session/steering`, with no `uri`;
  - refuses a non-empty `images` with `unsupported` when the adapter doesn't declare `promptImages` or the agent didn't advertise images, so the runner falls back to paths (ticket 13).
- **The launch:** `PrepareLaunchInput.model.inputModalities`, defaulting to `["text"]`.
- **The testing kit:**
  - the stub models record each request's image parts, as an Anthropic `image` block with `source.base64` and as an OpenAI `image_url` with a data URL, and the suite reads them;
  - the scripted fake agent comes with `promptCapabilities.image` and without it, and hands an image block on to the stub model as the format's image part;
  - `agent-files-cases.ts` (new): the cases of section 5.2, run for each fake and, through ticket 09, for OpenCode.
- **Parity:** `parity.ts` gains F-148's row for `promptImages`.

## Done when

- [x] Tests named for `F-148/c5`: with `promptImages`, a PNG in a prompt reaches the stub model as an image in each API format, and so does one in a mid-turn steer; without it, or with a model whose `inputModalities` lacks `image`, no image part reaches the stub model and the prompt is the text alone (break-it: always send the blocks, and the "without" case fails).
- [x] Tests named for `F-148/c4`: a file under the root's `.ostra/` is readable through the fake agent's read tool.
- [x] The parity test's new row passes.
- [x] Checks for the whole repo pass (spec section 10: what runs agent output).
- [x] Committed as `✨ add images to an agent's prompt`.

## Comments

- 2026-11-21, adapters: committed as `✨ add images to an agent's prompt`, on ticket 01's `2df67bd0` (built against 01's commit before it was pushed, then moved onto the pushed one). What it holds:
  - **The capability:** `promptImages` on `AgentCapabilities`. The rich fakes declare it and advertise `promptCapabilities.image`; the plain fakes, the tiny agent and OpenCode declare `false`. OpenCode advertises images already, but turns each into an error line until its config names the model's inputs, so it stays `false` until ticket 09 writes them and turns it on.
  - **The prompt:** `AgentPromptInput` (`{ text, images }`, each image `{ mimeType, bytes, name }` with ticket 01's `PromptImageContentType`) for `AgentAdapter.prompt` and `steer` and for `DriverConnection.prompt` and `steer`; `textPrompt(text)` makes a text-only one. Every caller passes `{ text, images: [] }`: the runner's two (`task-run.ts`) and the tests', rewritten by a one-off codemod that wrapped exactly the arguments the compiler refused.
  - **The driver** reads `agentCapabilities.promptCapabilities.image` at `initialize` (`imagesAdvertised` on the connection), sends `[{ type: "text", text }, …{ type: "image", mimeType, data }]` in `session/prompt`, `_session/steering` and a steer queued while subagents run, with no `uri`, and refuses images with `unsupported` unless both `ConnectOptions.promptImages` (the adapter's capability, passed by the base class) and the agent's advertisement say yes.
  - **Decision: the model's inputs are checked at the session too.** `StartSessionInput.modelInputModalities` (the launch's `inputModalities`; absent, text only) joins the two above in `AgentAdapter.promptsImages(session)`, and the base class refuses images that fail any of the three before `turn.started`, so a refused prompt leaves no turn in the log and the runner (ticket 13) can ask `promptsImages` first and write paths instead. `PrepareLaunchInput.model.inputModalities` is ticket 01's `InputModality[]`; `inputModalitiesOf` reads it with `["text"]` as the default.
  - **The testing kit:** the stub models record each message's image parts (`NormalizedMessage.images`, `StubImage`) from an Anthropic `image` block's `source.base64`, an OpenAI `image_url`'s data URL, and a tool result's images. The fake agent reads its model's format and inputs from its config, as OpenCode reads its catalog, and gains `model-turn`, `model-steerable` (each sends the prompt's or the steer's images on as the format's image part, only to a model that takes images), `read-file` (an ACP `read` call) and `say-images`. `agent-files-cases.ts` runs four cases on every fixture with `files` probes, each against stub models of its own in both formats: `F-148/c5` in a prompt, `F-148/c5` in a mid-turn steer, `F-148/c5` without (a text-only model on every agent, and an agent without `promptImages`: refused before the turn, nothing at the stub, then the path in the text arriving as the text alone), and `F-148/c4` (a file under the root's `.ostra/attachments/` read with the agent's own read tool). The driver's own tests cover the blocks' order and data, a steer's images, and each refusal.
  - **Parity:** the row `F-148 Images and files in a prompt`, with `promptImages`' `on` and `off` cases: the rich fakes prove all four cases, the plain fakes and OpenCode the fallback (images as files, and the file read from disk). The parity test checks the row per fake and that a fallback alone fails a fake that declares the capability. The adapter guide's capabilities sample declares `promptImages`, and its agent section says how images travel.
  - No break-it pass, under the maintainer's 2026-11-21 change. Checks, under the lead's rules (2026-11-20: touched packages and their consumers): typecheck of `packages/adapter-sdk` and every package that depends on it (`e2e/dev-tools` fails on `main` already, on `InvitationMailInput.address`, untouched here); lint of `adapter-sdk`, `adapter-opencode`, `apps/runner`, `task-view` and `e2e/m2-failure-suite`; tests of `adapter-sdk`, `adapter-opencode` and `task-view`, and the runner's `steering` and `approvals` tests, which drive prompts and steers through `task-run.ts`. GitHub CI runs the rest.
