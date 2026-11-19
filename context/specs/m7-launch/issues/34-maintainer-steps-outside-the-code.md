# 34: The maintainer's steps outside the code

Status: ready-for-human
Builder: maintainer
Blocked by: none for the decisions; 32 for the review of the run
Features: F-018, F-058, F-076, F-117, F-039, and the screens of ticket 12
Packages: none (decisions, accounts and settings outside the repo, recorded here)
Spec: `../spec.md`, sections 3, 12 and 13; ADR 0062, 0063, 0064

## Why a person

Each step needs an account, a machine, a person, a legal decision or a yes that an agent doesn't have.

1. **The Anthropic-format endpoint** (Q253): nothing to do if the script's test of `model.env`'s provider in Anthropic's format passes (ticket 32 says so here). If it doesn't, add an endpoint that speaks Anthropic's Messages API, from any provider or gateway, as `OSTRA_DEV_ANTHROPIC_BASE_URL`, `OSTRA_DEV_ANTHROPIC_API_KEY` and `OSTRA_DEV_ANTHROPIC_MODEL_ID` in `~/.config/ostra-dev/model.env`. Without one, F-018 stays `building`.
2. **Three dependencies, yes or no** (ADR 0007, "Waiting for the maintainer's yes"): Fumadocs for the docs site, Changesets for versions, and Claude Code's ACP adapter with Anthropic's Agent SDK, installed at run time. Each no has its fallback, except the last, which F-018 needs.
3. **The legal items** (ADR 0048): settle Q110 (the licensor) first, then Q109 (the CLA), and have a lawyer review the license, the licensor line and the CLA. **And whether Anthropic's terms let ostra's public images include Claude Code** (Q266, ADR 0062, ADR 0046); until you record a yes in ADR 0046, no published image holds it. None of this is answered by an agent.
4. **The names** (Q80, Q82): register the npm scope and the CLI's package name, and the image namespace (GitHub's container registry under your account or an organization, by default), and, if you want one, the docs' domain (`build-order.md`'s name check lists what was free on 2026-11-17).
5. **GitHub settings on the public repo:** turn on Pages (source: GitHub Actions), private vulnerability reporting, and npm's trusted publishing for each package once its name exists (npm's side, pointing at `release.yml`).
6. **Part B of the demo:** on your Linux machine with Docker, copy the test workspaces' env files into `~/.config/ostra-dev/`, and run part B (ticket 32), or let the lead run it there.
7. **The load test's machine:** a Linux machine of at least 16 vCPUs and 32 GB with a real Postgres on its own disk, for ticket 26's run that counts.
8. **Two people new to ostra** for the measure (ticket 25), and a Linux machine with Docker for each run that has never run ostra.
9. **The go** (ticket 33), after reading the gates' evidence.
10. **Approve the milestone 7 screen targets** (ticket 12), recorded there with the date.
11. **Read and sign the security review** (ticket 27). An outside penetration test is your choice.
12. **Review spec section 12's seventeen choices** (Q250 to Q265 and Q267 in `context/open-questions.md`), all settled on the delegation of 2026-11-19, and move back to the open list any you disagree with. Two the review added deserve a look: Q267 (a `host` machine with a managed Claude Code policy can't run Claude Code), and the default `OSTRA_AGENT_PREPARE=auto`, under which a personal runner downloads Claude Code (about 371 MB, under Anthropic's terms) to a member's machine the first time a task needs it, saying so in its terminal; `manual` is the alternative.

## Done when

- [ ] Each step is done or answered, with the date, under `## Comments`.

## Comments
