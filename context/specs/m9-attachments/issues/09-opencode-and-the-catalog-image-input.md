# 09: OpenCode and the catalog: a model's image input

Status: ready-for-agent
Builder: adapters
Blocked by: 01, 02
Features: F-148
Packages: `packages/adapters/adapter-opencode`, `packages/adapters/adapter-model-endpoint`, `packages/adapter-sdk/src/model-provider/` (`CatalogEntry`)
Spec: `../spec.md`, sections 4, 5.2 and 6; ADR 0070; `research/attachments-for-agents.md` §1 and §3

## What to build

- **The catalog:** `CatalogEntry.inputModalities` (`readonly InputModality[] | null`), read loosely from models.dev's `modalities.input` (unknown values dropped; no `modalities` is `null`), in `catalogEntries`. The bundled catalog's refresh script keeps the field.
- **OpenCode's config and catalog file:** `buildModelsCatalog` writes `modalities: { input, output: ["text"] }` for the task's model from `PrepareLaunchInput.model.inputModalities` (only `text`, `image`, `pdf`, `audio`, `video`; `text` always first), and `buildOpenCodeConfig` writes the same list as the model's `capabilities.input`, so the two agree (OpenCode's config wins over its catalog, research §1). OpenCode's own image limits (`media.image`) are left at its defaults.
- **`promptImages: true`** on the OpenCode adapter, and the agent suite's `agent-files-cases.ts` run against the pinned binary with the stub models, in both API formats.
- **The README's table** (`packages/adapters/adapter-opencode/README.md`) gains a "Milestone 9" section: what was read in 2.3.2's source (the research's citations) and what the binary showed.
- **Confirm on the binary** (record in the README): an image in `session/prompt` reaches the stub model as an image in each format; one in `_session/steering` too; a model written as text-only gets the error line and no image; the read tool returns a PNG under the root's `.ostra/` to a vision model; and, before the change, F-064's case: a ticket image read with the old catalog reached the model as the error line.

## Done when

- [ ] Tests named for `F-148/c5`: on the binary, a PNG reaches the Anthropic stub as an `image` block and the OpenAI-compatible stub as an `image_url`, in a prompt and in a steer; a model written as text-only gets no image part (break-it: write no `modalities`, and the image cases fail).
- [ ] Tests named for `F-148/c4`: on the binary, the agent reads a file under the workspace root's `.ostra/` with its read tool, with `external_directory` asked of no person.
- [ ] Tests named for `F-148/c5`: `catalogEntries` keeps `modalities.input`, drops unknown values, and gives `null` without it.
- [ ] Checks for `adapter-opencode`, `adapter-model-endpoint` and `adapter-sdk` pass (spec section 10).
- [ ] Committed as `✨ tell OpenCode what its model can see`.

## Comments
