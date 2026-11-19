# 22: Docs: install, setup and runners, with checked commands

Status: ready-for-agent
Builder: core
Blocked by: 21
Features: F-058, F-076
Packages: `apps/docs/content/` (start, install, runners), `scripts/check-docs-commands.ts` (new), `.github/workflows/proof.yml` (one job step)
Spec: `../spec.md`, sections 2 and 3; ADR 0063 (sections 1 to 3 of "What the site holds")
Note: changed 2026-11-19. Claude Code (F-018) moved after v1, so the runner guide has no section on preparing agents on runners; it's in this file's history for F-018.

## What to build

- **Start:** what ostra is, in the README's words ("source-available", never "open source"); "Before you start" (a Linux machine with Docker, a GitHub organization you administer, a model provider's base URL and token); the 30-minute path.
- **Install:** the compose file and its required settings; the first sign-in and its forced password change; setup in the panel, one section per checklist step in the checklist's order, with what each screen asks and why; Linear, optional and last; Helm; upgrading; the Docker socket warning (F-001, Q97).
- **Runners:** pools and join tokens, the three executors and what each isolates (ADR 0029's allowed differences, "not isolated" for `host`), personal runners with `ostra runner`, the egress baseline, the HTTP fallback.
- **Run from source**, for contributors and for this machine's demo: `pnpm install`, `pnpm dev`, the embedded Postgres.
- **The checked commands:** every fenced `sh` block marked `run` in these pages is extracted by `scripts/check-docs-commands.ts`; the Linux proof job runs them in order on a fresh `ubuntu-24.04` against the release candidate's images and the stub model, and fails on the first that fails. No secret.

## Done when

- [x] Tests named for `F-058`: the extractor finds the marked blocks and only those; a page's broken command fails the job's script (break-it).
- [ ] The Linux proof job ran the install guide's commands to a healthy stack, its log kept in `context/specs/m7-launch/demo/` as live evidence.
- [ ] In the same job, against that `docker compose up` stack with the stub model, milestone 1's `apps/web/e2e/02-setup.spec.ts` and `03-first-run.spec.ts` pass, which is what `context/proof/F-076.md` says would prove its first condition's "after `docker compose up`"; the log is cited there.
- [ ] Ticket 25's rehearsal found nothing missing from these pages, or what it found is fixed and recorded under `## Comments`.
- [x] Committed as `📝 write the install and runner guides`.

## Comments
- 2026-11-19: Written: Start (what ostra is, before you start, the 30-minute path), Install (Docker Compose, first sign-in, setup in the checklist's order, Linear, Helm, upgrading, and a new "Run from source" page last in the section) and Runners (pools and join tokens, executors with ADR 0029's four allowed differences, personal runners, the egress baseline, the HTTP fallback). Every page that names the `host` executor carries the same "Not isolated" callout.
- 2026-11-19: `scripts/check-docs-commands.ts` reads every `sh` block of `apps/docs/content/`, in `meta.json`'s order, and runs the ones marked `run` in one `bash` (from a script file, never stdin, so a command that reads stdin can't swallow the next block) with `set -eo pipefail`, naming the block it stopped in. `--release-assets` points the guide's `releases/latest/download/` link at a release candidate's assets; before ticket 33 publishes a release, the job points it at the commit's own `deploy/` and builds the images from it. Its tests, in `scripts/check-docs-commands.test.ts`, run in `ci.yml` with the root's tests; the blocks themselves run only in `proof.yml`'s new `docs-commands` job (manual). Blocks that need the reader's own values (a join token, a server address) aren't marked `run`; a test checks that each names only settings in `docs/configuration.md`, flags `ostra runner` has and root `pnpm` scripts. Run locally with `--release-assets file:///…/deploy/`: the download block passed and `docker compose up -d` failed for want of Docker on this machine, as it should.
- 2026-11-19: Install with Docker Compose has a step the target doesn't, "3. Check that it's up" (`curl` with retries on core's `/healthz` and the panel's `/sign-in`), so the checked run ends at a healthy stack rather than at `docker compose ps`; "Open the panel" is step 4. The download link stays on `releases/latest/download/` instead of a version the build stamps in, so the page is never stale.
- 2026-11-19: Found while writing, for ticket 24 or 25: the panel's checklist shows Linear fourth, after GitHub (`setupStepIds`), while F-076 puts it last; the setup page follows the panel and says to skip it. `deploy/compose.yaml`'s header still names Q117's setup token, which the seeded first admin replaced. Helm (F-118), the `kubernetes` executor, the HTTP fallback and the egress baseline's live check are milestone 5 work, so those pages say what v1 has and carry a note where a piece isn't built yet. No `members` page exists yet for invitations (F-002), so the first sign-in page says "from the organization's settings".
- 2026-11-19: Still open: the `docs-commands` job's first run to a healthy stack and its log in `context/specs/m7-launch/demo/` (it hasn't been dispatched), milestone 1's `02-setup` and `03-first-run` specs against that compose stack (the e2e harness starts its own stack today, so it needs a way to point at an external one), and ticket 25's rehearsal.
