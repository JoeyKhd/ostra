# 22: Docs: install, setup and runners, with checked commands

Status: ready-for-agent
Builder: core
Blocked by: 21
Features: F-058, F-076
Packages: `apps/docs/content/` (start, install, runners), `scripts/check-docs-commands.ts` (new), `.github/workflows/proof.yml` (one job step)
Spec: `../spec.md`, sections 2 and 3; ADR 0063 (sections 1 to 3 of "What the site holds")

## What to build

- **Start:** what ostra is, in the README's words ("source-available", never "open source"); "Before you start" (a Linux machine with Docker, a GitHub organization you administer, a model provider's base URL and token); the 30-minute path.
- **Install:** the compose file and its required settings; the first sign-in and its forced password change; setup in the panel, one section per checklist step in the checklist's order, with what each screen asks and why; Linear, optional and last; Helm; upgrading; the Docker socket warning (F-001, Q97).
- **Runners:** pools and join tokens, the three executors and what each isolates (ADR 0029's allowed differences, "not isolated" for `host`), personal runners with `ostra runner`, the egress baseline, the HTTP fallback, agents on runners (`ostra agents`, Claude Code's one-time preparation).
- **Run from source**, for contributors and for this machine's demo: `pnpm install`, `pnpm dev`, the embedded Postgres.
- **The checked commands:** every fenced `sh` block marked `run` in these pages is extracted by `scripts/check-docs-commands.ts`; the Linux proof job runs them in order on a fresh `ubuntu-24.04` against the release candidate's images and the stub model, and fails on the first that fails. No secret.

## Done when

- [ ] Tests named for `F-058`: the extractor finds the marked blocks and only those; a page's broken command fails the job's script (break-it).
- [ ] The Linux proof job ran the install guide's commands to a healthy stack, its log kept in `context/specs/m7-launch/demo/` as live evidence.
- [ ] Ticket 25's rehearsal found nothing missing from these pages, or what it found is fixed and recorded under `## Comments`.
- [ ] Committed as `📝 write the install and runner guides`.

## Comments
