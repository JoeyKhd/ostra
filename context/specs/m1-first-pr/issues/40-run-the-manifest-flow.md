# 40: Run the manifest flow once in a browser

Status: ready-for-human
Builder: maintainer
Blocked by: 31, 37
Features: F-006
Packages: none (a run, recorded here)
Spec: `../spec.md`, sections 2 and 11 (item 3)

## Why a person

GitHub's "create an App from a manifest" page needs a signed-in GitHub account to click Create. The demo connects the existing test App instead, so F-006's "one flow" is checked here, once.

## Steps

1. On a dev stack (`pnpm dev`), signed in as the admin, open Connect GitHub → "Create a new App".
2. On GitHub, create it in the `ostra-test` org, and install it on `test2` only.
3. Back in the panel, check that the App appears with its slug and permissions, that it lists `test2`, and that the panel says it has no events when there's no public address.
4. With `tunnel.env`'s public URL set as `OSTRA_CORE_PUBLIC_URL`, repeat once and check on GitHub (the App's Advanced tab) that the App has a webhook pointing at `<that URL>/webhooks/github`, active, with its events, and that the panel no longer says it has no events. **Do not check deliveries:** core doesn't route `/webhooks/github` yet, because the webhook inbox is milestone 2 (spec section 1; `verifyWebhook` is a milestone 2 method). A delivery gets a 404 from core until then, and that's expected. The milestone 2 ticket for the inbox owns the route and its signature check, and checks a live delivery then.
5. Delete both Apps from `ostra-test` afterwards, so the test org keeps only App 5821041.

## Done when

- [ ] Both runs are recorded under `## Comments` with the date, and F-006's row can be set `done` by ticket 39. Until then F-006 stays `building`: it isn't set `done` without the run.
- [ ] The second run checks the webhook and its events on GitHub's side only; a live delivery waits for milestone 2's webhook inbox.

## Comments

- 2026-11-19 (review): step 4 named `OSTRA_PUBLIC_URL`, but the manifest's webhook address is built from `OSTRA_CORE_PUBLIC_URL` (`github.startManifest`), so the step now names that one. Core doesn't route `/webhooks/github` (ticket 31 calls the path a placeholder), and the inbox with its per-connection signature check is milestone 2 work, so step 4 no longer asks for a delivery.
