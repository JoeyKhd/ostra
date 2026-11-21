# 02: Adapter SDK: images in an agent's prompt

Status: ready-for-agent
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

- [ ] Tests named for `F-148/c5`: with `promptImages`, a PNG in a prompt reaches the stub model as an image in each API format, and so does one in a mid-turn steer; without it, or with a model whose `inputModalities` lacks `image`, no image part reaches the stub model and the prompt is the text alone (break-it: always send the blocks, and the "without" case fails).
- [ ] Tests named for `F-148/c4`: a file under the root's `.ostra/` is readable through the fake agent's read tool.
- [ ] The parity test's new row passes.
- [ ] Checks for the whole repo pass (spec section 10: what runs agent output).
- [ ] Committed as `✨ add images to an agent's prompt`.

## Comments
