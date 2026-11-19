# 28: The model catalog and model-list jobs

Status: resolved
Builder: core
Blocked by: 12, 23
Features: F-088
Packages: `apps/core` (`src/catalog/`), `docs/configuration.md`
Spec: `../spec.md`, section 2

## What to build

- **`catalog.refresh`,** daily: fetch the models.dev catalog with a plain GET that carries no install data, parse it with ticket 12's loose schema, store it, and download the logos it names into `OSTRA_DATA_DIR` so the panel serves them itself. `OSTRA_CATALOG_FETCH=off` turns the fetch off, and the bundled copy is used (ADR 0021, ADR 0033). A failed fetch keeps the last good copy.
- **`provider.refresh-models`,** daily per provider: list the endpoint's models and match them to the catalog.
- **Logo route:** core serves `/assets/models/<logo>` from the stored files with a long cache header, and web proxies or links it (decide with ticket 31; browsers never call models.dev).

## Done when

- [x] Tests with a fake catalog server: a fetch stores and matches; a failed fetch keeps the old copy; with the fetch off, no request is made (checked by the fake) and the bundled copy is served.
- [x] Both settings' lines are in `docs/configuration.md`.
- [x] Package checks pass.
- [x] Committed as `✨ add the model catalog jobs`.

## Comments

- 2026-11-18, core: done in the commit that carries this line (`✨ add the model catalog jobs`). `apps/core/src/catalog/catalog.ts`: `catalog.refresh` fetches models.dev with a plain GET (only `accept`), parses it with ticket 12's schema, keeps the last good copy in `OSTRA_DATA_DIR/catalog/models-dev.json` (written through a rename, a bad or failed fetch leaves it alone and the job retries), and downloads the logos of the providers ostra's models matched into `OSTRA_DATA_DIR/model-logos/`. **The logo route, decided with ticket 31:** the panel already serves `/model-logos/<id>.svg` from that folder (`apps/web/src/app/model-logos/[file]/route.ts`, the path `logoPathFor` names), so core writes there and serves no route of its own. `provider.refresh-models` runs ticket 31's `syncProviderModels` against core's catalog source (the stored copy, or the bundled one with the fetch off), and unschedules a provider that's gone. Schedules: `catalog.refresh` daily unless `OSTRA_CATALOG_FETCH` is off, and one per provider, kept in step every 10 minutes. The two settings are `OSTRA_CATALOG_FETCH` and `OSTRA_DATA_DIR`; `docs/configuration.md` names the two new files. One overlap for the web builder to settle: the panel's catalog source still fetches models.dev itself (`apps/web/src/server/deps.ts`), and could read core's stored copy instead. 4 tests with a fake catalog server. Whole-repo checks green.
