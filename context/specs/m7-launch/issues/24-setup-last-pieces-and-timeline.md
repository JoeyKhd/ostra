# 24: Setup in the panel: the last pieces and its timeline

Status: resolved
Builder: api (with web for the checklist's links)
Blocked by: 36
Features: F-076
Packages: `packages/api` (`src/routers/setup.ts`), `apps/web` (the checklist), `scripts/measure-setup.ts` (new), `package.json` (`measure:setup`)
Spec: `../spec.md`, sections 4 and 10.1; ADR 0064 ("The 30-minute measure")

## What to build

- **The checklist, complete** (F-076's first condition, the parts milestone 1's proof left `partial`): Linear's step live (milestone 2's Connect Linear), optional, skippable with "Skip for now", ticked once connected, never counted against setup being done; each step's link to its page in the docs (`OSTRA_DOCS_URL`).
- **`setup.timeline`** (instance admin only): each step's completion time for the first organization, from milestone 4's audit entries (the password change, the provider saved, the App installed, the project created, the runner approved, the first task started) and the event of the first PR's opening, through the domain's `setupTimeline`.
- **`pnpm measure:setup --url <panel> --start <time>`:** signs in as the instance admin (the password from the prompt, never an argument or a log), reads the timeline, prints each step's time since `--start` and the total, and writes `timeline.json` for ticket 25's record. No secret in its output.

## Done when

- [x] Tests named for `F-076`: setup completes without Linear and ticks Linear when it's connected; the timeline's times equal the seeded audit entries' (break-it: one step's entry dropped); the script's output holds no token, password or address but the panel's.
- [x] Milestone 1's F-076 tests still pass.
- [x] Typecheck, lint and tests of the touched packages pass.
- [x] Committed as `✨ finish setup and add its timeline`.

## Comments

- 2026-11-20, api: built and proved (`context/proof/F-076.md`).
  - **The checklist:** `setup.status` gains, additively, each step's `docs` (its page under `OSTRA_DOCS_URL`, from `setupStepDocs`) and `complete` (every step done but the optional Linear). Home drops the checklist on `complete`, so an organization finishes setup with Linear connected, skipped or untouched; `next` keeps milestone 2's meaning (the first open step, Linear included). The runner's link goes to the setup guide's "Connect a runner" section, since the compose file's runner is a pool runner; the API test checks every link's page and heading exist in `apps/docs/content`.
  - **The screen that grows** (`app-targets/m2/home-first-run`, spec section 13): each row's body ends with a `--muted` "Docs" link with Lucide `book-open` 12px, opening in a new tab, on every row, done or not, for admins and members (`checklist.docs`, and `checklist.docsLabel` for its accessible name). Nothing else on the screen changes.
  - **`setup.timeline`** (instance admin only, its input the start alone) reads the first organization's earliest audit entry per mark and its first `pr.opened` event, through the domain's `setupTimeline`. The password change wrote no audit entry before (`password.changed` was in the closed list, unused): better-auth's `/change-password` now writes one in each of the account's organizations, in one transaction with clearing `mustChangePassword`.
  - **`pnpm measure:setup`** lives at `packages/api/scripts/measure-setup.ts`, not `scripts/`, so it validates the panel's answer with the API's own schema (`@ostra/api/setup-timeline`, a new export) rather than a copy; the root `package.json` runs it. It takes `--url`, `--start` (ISO 8601), `--username` (default `demo`) and `--out` (default `./timeline.json`), reads the password from a no-echo prompt or the first line of standard input, and refuses a `--password` flag. It signs out when done.
  - **Milestone 1's tests:** the API walk and `setup.test.ts` pass (the latter now checks `complete`). The browser specs `01-shell`, `02-setup` and `03-first-run` were stale since milestone 2 and are updated; `03`'s device approval reads its own status line (the shell's toast region is a status too). `02-setup`'s "Add a model provider" fails against the keys-per-project models page (its settings switch isn't found by label after saving), which isn't this ticket's; with that one step changed locally, all twelve tests of the three files passed.
