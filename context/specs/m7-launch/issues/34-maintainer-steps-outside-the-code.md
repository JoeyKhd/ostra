# 34: The maintainer's steps outside the code

Status: ready-for-human
Builder: maintainer
Blocked by: none for the decisions; 32 for the review of the run
Features: F-058, F-076, F-117, F-039, and the screens of ticket 12
Packages: none (decisions, accounts and settings outside the repo, recorded here)
Spec: `../spec.md`, sections 3, 12 and 13; ADR 0063, 0064
Note: changed 2026-11-19. Claude Code (F-018) moved after v1, so step 1 is withdrawn and steps 2, 3 and 12 lose their Claude Code parts. The steps keep their numbers, which other files cite.

## Why a person

Each step needs an account, a machine, a person, a legal decision or a yes that an agent doesn't have.

1. *Withdrawn 2026-11-19 with F-018:* **the Anthropic-format endpoint** (Q253) was for Claude Code. Nothing to do for v1.
2. **Two dependencies, to review** (ADR 0007, "Milestone 7"): Fumadocs for the docs site and Changesets for versions. The lead confirmed them on 2026-11-19 under the maintainer's permission for that session's dependencies. Withdrawing one is still possible: each has its fallback. The third, Claude Code's ACP adapter with Anthropic's Agent SDK, was withdrawn on 2026-11-19 with F-018.
3. **The legal items** (ADR 0048): nothing to do. Q109 and Q110 were settled on 2026-11-19, on your word that this needs no lawyer. The contributor agreement is in `CONTRIBUTING.md`, and a check on every pull request asks for its box. The licensor line stays as it is, and no legal name enters the repo. Two things are yours only when they come up: before you give someone else write access, ask them for one pull request with the box ticked; and if you form a company, say which of ADR 0048's two ways you pick. Whether Anthropic's terms let ostra's public images include Claude Code (Q266) waits with F-018 since 2026-11-19, so it isn't yours to answer for v1.
4. **The names** (Q80, Q82): register the npm scope and the CLI's package name, and the image namespace (GitHub's container registry under your account or an organization, by default), and, if you want one, the docs' domain (`build-order.md`'s name check lists what was free on 2026-11-17).
5. **GitHub settings on the public repo:** turn on Pages (source: GitHub Actions), private vulnerability reporting, and npm's trusted publishing for each package once its name exists (npm's side, pointing at `release.yml`).
6. **Part B of the demo:** on your Linux machine with Docker, copy the test workspaces' env files into `~/.config/ostra-dev/`, and run part B (ticket 32), or let the lead run it there.
7. **The load test's machine:** a Linux machine of at least 16 vCPUs and 32 GB with a real Postgres on its own disk, for ticket 26's run that counts.
8. **Two people new to ostra** for the measure (ticket 25), and a Linux machine with Docker for each run that has never run ostra.
9. **The go** (ticket 33), after reading the gates' evidence.
10. **Approve the milestone 7 screen targets** (ticket 12), recorded there with the date.
11. **Read and sign the security review** (ticket 27). An outside penetration test is your choice.
12. **Review spec section 12's choices that still apply** (Q254 to Q263 in `context/open-questions.md`), all settled on the delegation of 2026-11-19, and move back to the open list any you disagree with. The other seven (Q250 to Q253, Q264, Q265 and Q267), with Q266 and the default `OSTRA_AGENT_PREPARE=auto`, were Claude Code's and are postponed with F-018 (2026-11-19).

## Done when

- [ ] Each step is done or answered, with the date, under `## Comments`.

## Comments
