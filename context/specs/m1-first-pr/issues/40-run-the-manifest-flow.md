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
4. With `tunnel.env`'s public URL set as `OSTRA_PUBLIC_URL`, repeat once and check the App gets its webhook and events.
5. Delete both Apps from `ostra-test` afterwards, so the test org keeps only App 5821041.

## Done when

- [ ] Both runs are recorded under `## Comments` with the date, and F-006's row can be set `done` by ticket 39.

## Comments
