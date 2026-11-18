# 28: The model catalog and model-list jobs

Status: ready-for-agent
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

- [ ] Tests with a fake catalog server: a fetch stores and matches; a failed fetch keeps the old copy; with the fetch off, no request is made (checked by the fake) and the bundled copy is served.
- [ ] Both settings' lines are in `docs/configuration.md`.
- [ ] Package checks pass.
- [ ] Committed as `✨ add the model catalog jobs`.

## Comments
