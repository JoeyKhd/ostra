# Target: the setup checklist's "Connect a tracker"

- **Pictures:** `setup-checklist` and `setup-checklist-light` (Home for a new organization, step 4 next); the step's other states on `trackers-states` ("Home's step, by state").
- **Sources:** `html/home.html`; `html/states.html?sheet=trackers`.
- **Route (existing):** `/` → `components/home/setup-checklist.tsx`, `setup-steps.tsx`.
- **Builds on:** `../m2/home-first-run.md` (approved), in milestone 8's shell. Only step 4 changes.
- **Feature:** F-076. **Status: a proposal** (`README.md`).

## What changes

Step 4, `Connect Linear`, becomes **`Connect a tracker`**, for either kind; its id `linear` becomes `tracker`, and it's done when any tracker connection is `active`. It stays skippable, as today.

| State | Body (13.5px `--muted`) | Actions |
|---|---|---|
| **Open** (the picture) | the Linear mark 14px + `Linear` or the Jira mark 14px + `Jira` (`--text-2`), then `: tickets become tasks, and ostra keeps their status in step. Skip it to run on prompts alone.` + `Docs` | teal `Skip for now`; `Connect a tracker →` (primary when it's the next step) to `/organization/trackers`, whose empty state is the picker |
| **Pending** | `Started Globex Jira: add the webhook in Jira to finish.` (Linear: `Started Acme Linear: paste the app's values and authorize to finish.`) | `Continue →` to that connection's page |
| **Failed** | red `triangle-alert` 13px, `Jira refused Globex Jira's token. Replace it to finish.` (Linear: today's `Linear refused the token. Authorize the app again.`) | `Replace the token →` / `Authorize again →`, outline |
| **Done** | `Connected` + the mark 14px + the connection's name | none |
| **Skipped** | `Skipped. Tasks start from prompts until you connect one.` | teal `Connect a tracker` |

With several connections, pending or failed name the most recent; done needs one active.

## Sizes

Unchanged: rows 52px min, the 22px circles, the action on the right. The marks sit on the text's baseline (`vertical-align: -2px`).

## Copy (keys under `checklist.tracker.*`)

`title` `Connect a tracker` · `body` `{linear} or {jira}: tickets become tasks, and ostra keeps their status in step. Skip it to run on prompts alone.` · `action` `Connect a tracker` · `skip` `Skip for now` · `skipping` `Skipping…` · `skipped` `Skipped. Tasks start from prompts until you connect one.` · `pending.jira` `Started {name}: add the webhook in Jira to finish.` · `pending.linear` `Started {name}: paste the app's values and authorize to finish.` · `continue` `Continue` · `failed.jira` `Jira refused {name}'s token. Replace it to finish.` · `failed.linear` today's `checklist.linear.failed` · `replace` `Replace the token` · `done` `Connected {name}.`

## Data

`setup.status`'s step `tracker`: `state` and, when pending, failed or done, the connection's `id`, `kind` and `name`. `setup.skip({ step: "tracker" })`. An organization that skipped `linear` keeps it skipped as `tracker` (a data migration that renames the step).
