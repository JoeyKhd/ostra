# 09: OpenCode and the catalog: a model's image input

Status: done
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

- [x] Tests named for `F-148/c5`: on the binary, a PNG reaches the Anthropic stub as an `image` block and the OpenAI-compatible stub as an `image_url`, in a prompt and in a steer; a model written as text-only gets no image part (break-it: write no `modalities`, and the image cases fail).
- [x] Tests named for `F-148/c4`: on the binary, the agent reads a file under the workspace root's `.ostra/` with its read tool, with `external_directory` asked of no person.
- [x] Tests named for `F-148/c5`: `catalogEntries` keeps `modalities.input`, drops unknown values, and gives `null` without it.
- [x] Checks for `adapter-opencode`, `adapter-model-endpoint` and `adapter-sdk` pass (spec section 10).
- [x] Committed as `✨ tell OpenCode what its model can see`.

## Comments

- 2026-11-21, adapters: built as `✨ tell OpenCode what its model can see`, on ticket 01's `InputModality` and `agent.inputModalities` and ticket 02's `PrepareLaunchInput.model.inputModalities` (`inputModalitiesOf`: absent is text only). Readings and differences:
  - **The catalog:** `inputModalitiesOf` keeps the values ostra names in `inputModalitySchema`'s order, each once; a `modalities` without a list is `null`, and a list of nothing ostra names is `[]`. The refresh script keeps `modalities.input`, and the bundled copy was refreshed with it (every model of models.dev's now has one; 6,217 list images). The refresh also brought models.dev's other changes since 2026-11-19 (58 models added, 42 gone, 141 changed); the tests that read the copy pass.
  - **The runner** passes the spec's `agent.inputModalities` to the launch (`task-run.ts`): beyond this ticket's packages, but without it the spec's inputs never reach OpenCode. The task-host harness's stub now runs in either API format.
  - **On the binary** (`opencode-images.contract.test.ts`, and through the runner `ticket-images.opencode.test.ts`, both formats): a model written as taking images gets a PNG the agent reads as an `image` block or an `image_url`; a text-only one, or one nothing was said of, gets `ERROR: Cannot read "<path>" (this model does not support image input)` and no image. With `origin/main`'s old `config.ts` the image cases failed and the error line came back: F-064's case, recorded in the README.
  - **Then** `promptImages: true` and the files cases on the binary, in `✨ show OpenCode the images in a message` (below). `core` fills `agent.inputModalities` in ticket 11; until then a task's spec says nothing, which is text only, as before.
- 2026-11-21, adapters: then `✨ show OpenCode the images in a message`, on ticket 02's driver: `promptImages: true`, OpenCode's parity row moved from the files fallback to the four cases, and the fixture's `files` probes, so `agent-files-cases.ts` runs on the pinned binary in both formats (a prompt's image, a steer's in a long shell step, the text-only fallback, and a read under `.ostra/`). Two changes to the suite: a fixture may give the cases' stub model a script (`files.brain`), since every step of a real agent is its model's; and the image cases check the user message that carries the picture, since OpenCode's own title call quotes the prompt's words without it, first.
