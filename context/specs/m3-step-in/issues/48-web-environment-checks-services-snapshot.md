# 48: Web: the environment's checks, services and snapshot

Status: done
Builder: web
Blocked by: 40, 41
Features: F-054, F-094, F-051
Packages: `apps/web` (`components/projects/environment-view.tsx`, `components/projects/environment-services.tsx` (new))
Spec: `../spec.md`, section 12 (`environment-services`; and `m1/environment` growing)

## What to build

- **Checks** in the environment (`environment-services`): the list with order, command, repo and timeout; add, edit, reorder, delete.
- **Services:** the list with image, port, variables (secrets as "set"), health check and health on the last box; add, edit, delete; the note that `host` runners start no services, and the warning when no runner that can is online.
- **The snapshot:** on `docker`, the state, when and where it was built, the last failure's reason, "Rebuild"; on `host`, "worktree and dependency cache".
- A task's dispatch note ("needs a runner that can start services") on the task page, from milestone 1's dispatch note field.

## Done when

- [x] The screens match their targets, checked by eye, with the differences recorded here.
- [x] Playwright: a check and a service saved, the "no runner can start services" warning with only a `host` runner online, a task in that project waiting with the note.
- [x] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `web`.
- [x] Committed as `✨ add the environment's services and checks`.

## Comments

- 2026-11-19, web: done in `✨ add the environment's services and checks`, after the fix `🐛 keep koffi out of the panel's bundle` (the adapter SDK's Windows process lister imports `koffi`, a native addon Turbopack can't bundle, so `next build` failed on main; it's now in `serverExternalPackages`). **The page** (`apps/web/src/components/projects/environment-view.tsx`): two underline tabs, `Setup` (milestone 1's page) and `Services and checks` (`?tab=services`, kept with `?created=1`); `Save environment` only on `Setup`, whose unsaved edits stay in memory across tabs. **The tab** (`components/projects/environment-services.tsx`, words in `environment-services-words.ts`): services by name with image, port, variables (`3 · 1 secret`), health check and health on the last box (`healthy 4s`, `failed` with the reason in the tooltip and atop the sheet, `started no check`, `not run yet`); their sheet (name, image, port, plain and secret variables, a stored secret reading `set` with `Set: type to replace it`, health check, `Saving rebuilds the snapshot. Running tasks keep theirs.`); the runner note, or the red `Tasks of this project are waiting.` block in its two forms (none online, or every pool runner on `host`); checks in order with handle, number, name, command, repo or `workspace root`, timeout (`10 min`, `90 s`), their sheet (repo `Select` with `Workspace root`, timeout with a `min`/`s` unit), reorder by native drag or `Alt+↑`/`Alt+↓` with an announcement, saved at once and put back on a failure; removal behind an `AlertDialog`; read-only for members. **The panel:** the Snapshot group on both tabs (Ready, Queued, Building `since`, Failed with reason and detail, None yet; `In use`; Rebuild for admins, `Queued` while pending; a `host`-only project shows `Kind · Worktree and dependency cache`), and on this tab `On host runners` and `Where tasks run`. **The task page** shows `Waiting for a runner that can start services. Online now: <runner> (host).` for a `needs-services-runner` wait. **Tests:** `apps/web/e2e/08-environment-services.spec.ts` on desktop and phone (a check and a service saved and read back after a reload, the secret never on the page, the blocker with only a `host` runner, the waiting task's note; seeded by `e2e/seed-services.ts`), and `environment-services-words.test.ts`, seven cases. Break-it checks: seven, each failing its test (the service sheet and the check sheet saving nothing, the blocker hidden, the task note shown for another wait code; `runnerNote` inverted, a failed service's dot grey, minutes read on 30 s, the rebuilder's name dropped). The upstream specs `01-shell`, `02-setup`, `03-first-run` and `07-prompt-task` fail on main for reasons outside this ticket (milestone 2's checklist), so the run used a local config that runs `phone` after `desktop` without the dependency gate. Proof: `context/proof/F-094.md` (first row `proved`), `F-054.md` (first row `proved`), `F-051.md` (a note).
- **Checked by eye** against `app-targets/m3/environment-services.webp`: `context/specs/m3-step-in/evidence/environment-services-built.png`, taken at 1440×956 by the spec's second test (`OSTRA_E2E_SCREENSHOTS=1`, seeded with the target's data). The differences: services list by name (the API's order), so `mailpit` comes before `redis`; the properties panel is 380px, the shared `wideProperties` width milestone 1's environment page uses, not the 340px the target names; `Executors` reads `docker, host` because the first test's `host` runner shares the default pool, the state the target describes for a second executor online; the sidebar, organization, project and repo names are the shared shell and the e2e stack's (`Demo`, `fake-org/test1`); under 900px the Variables, Health check and Repo columns hide, and on a phone the drag grip goes, so the page has no horizontal scroll.
