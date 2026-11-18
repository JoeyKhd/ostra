# 12: The model endpoint adapter, the catalog and stub models

Status: resolved
Builder: adapters
Blocked by: 04
Features: F-088, F-089 (usage parsing)
Packages: `packages/adapters/adapter-model-endpoint` (new, Apache-2.0); `packages/adapter-sdk` (`src/model/usage.ts`, `src/testing/stub-models/`)
Spec: `../spec.md`, sections 2 and 8

## What to build

- **Stub model servers** in `@ostra/adapter-sdk/testing`: an OpenAI-compatible one and an Anthropic Messages one, each streaming scripted responses with usage fields, a rate-limit answer with `Retry-After`, an error body, and a mode with no usage in the stream.
- **Usage parsing** in `src/model/usage.ts`: read token counts from a stream in either format, byte for byte as it passes (the key proxy calls it), and estimate when the stream reports none, marked `estimated`.
- **`ModelEndpointAdapter extends ModelProviderAdapter`:**
  - `testConnection(baseUrl, token, authScheme)`: calls `GET /v1/models`, detects the format from the answer's shape and headers, and returns the format and the models, or a typed failure (unreachable, 401/403, not an API).
  - `listModels`, and `matchCatalog(models, catalog)`: each ID matched to the models.dev catalog for name, logo, limits and prices; no match is a custom model.
  - The catalog's Zod schema, loose (models.dev owns it). A bundled copy of the catalog in the package (`catalog/models-dev.json`, with its fetch date), and a parser for a fetched one.
- The model provider contract suite, against both stubs.

## Port from

`spikes/how-should-the-runner-drive-opencode/src/lib/stub-models/`, `usage.ts`, `src/harness/catalog.ts`.

## Done when

- [x] The suite passes for both formats; format detection is right for each stub; a 401 gives the typed failure.
- [x] Usage parsing matches the stubs' counts exactly, and marks the no-usage stream as estimated.
- [x] With `model.env` loaded, `testConnection` detects the endpoint's format and lists `OSTRA_DEV_MODEL_ID` (a gated test that prints neither the URL nor the token).
- [x] Package checks and `pnpm check:licenses` pass.
- [x] Committed as `✨ add the model endpoint adapter`.

## Comments

- 2026-11-18, adapters: done in 324dcae (`✨ add usage parsing and stub model servers`, in `adapter-sdk`: `src/model/` and `src/testing/stub-models/`) and bdd71ea (`✨ add the model endpoint adapter`, `packages/adapters/adapter-model-endpoint`). One adapter handles both formats, as the ticket says: it detects the format from the answer's shape (then its `anthropic-*` headers) and the auth scheme from what works (bearer, then `x-api-key`). The stubs now speak ostra's `ApiFormat`, report a rate limit with `Retry-After`, and have a no-usage mode; the Anthropic stub takes `x-api-key` only, like the real API. `resolveUsage` estimates (about 4 bytes a token) and marks it `estimated`.
  - The bundled catalog is `catalog/models-dev.json` (321 providers, 8,972 tool-calling models, 1.5 MB, with `fetchedAt`); `pnpm catalog:refresh` rebuilds it. A model matches by ID, then without a `:tag`, a `vendor/` prefix and a date suffix; the first-party provider wins when several carry a model. Logos are named `/model-logos/<provider>.svg`: ticket 28 serves them from ostra's own server.
  - The gated live test detects the dev endpoint's format and finds `OSTRA_DEV_MODEL_ID`, printing neither the URL nor the token.
