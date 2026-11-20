# The launch gates, and how v1 is released

**Status:** accepted (2026-11-19, on the maintainer's delegation for milestone 7's spec). Settles Q256, Q257, Q258 and Q259. Amends ADR 0045 (publishing in practice) and ADR 0061 (the load test as the gate). Covers F-076's measure, F-117's gate, the security review of the box, and publishing. **It answers none of the maintainer's legal items** (Q109, Q110 and the legal review of ADR 0048): it plans around them, and the release waits for them. **Amended 2026-11-19:** Q109 and Q110 were settled the same day (ADR 0048) with no lawyer's review, so the legal gate below is now the repo's own state, and the release waits for nothing legal. **Amended again 2026-11-19:** Claude Code (F-018) moved after v1 on the maintainer's word, so the agent gate is OpenCode's suite, the load test's mix stays milestone 5's, and the security review covers one agent.

v1 is public when every gate below holds and the maintainer says go. Each gate leaves evidence in the repo, and none passes on a fake.

## The gates

| Gate | Holds when | Evidence |
|---|---|---|
| **The ledger** | `pnpm check:proof` passes, and every v1 row is `done`, or `building` with a dated note the maintainer accepted as a known limit of v1 (a row waiting on a Mac, say) | `context/features.md`, `context/proof/` |
| **The agent** | The agent contract suite passes on OpenCode and on the scripted fakes, on the release candidate. *Changed 2026-11-19: it was "two agents", with Claude Code, which is after v1* | The suite's run log (`packages/adapters/adapter-opencode/evidence/`) |
| **The 30-minute measure** (F-076) | Two people new to ostra each go from the install guide's first command to their first agent-made PR in under 30 minutes, following only the docs site | `context/specs/m7-launch/measure/` |
| **The load test** (F-117) | ADR 0061's run that counts passes on the release candidate | `context/specs/m7-launch/load/` |
| **The security review of the box** | The review is written, its adversarial run passed, and no finding rated critical or high is open | `context/specs/m7-launch/security-review.md` |
| **The legal items** | Q109 and Q110 are settled (ADR 0048, 2026-11-19), so this gate is the repo's own state: the contributor agreement and its pull request check are in place, and the licensor line is the same in every `LICENSE`, `NOTICE` and published package. A lawyer's review is the maintainer's choice and a paid service, so it isn't a gate | `CONTRIBUTING.md`, `.github/workflows/contributor-agreement.yml`, and the licensor-line test of milestone 7's ticket 30 |
| **The names** | The maintainer has registered the npm scope, the CLI's package name and the image namespace (Q80, Q82), and, if wanted, the docs' domain | The same ticket |
| **The go** | The maintainer says go, after reading the gates' evidence | The same ticket, dated |

Until the names and the go, everything else is built, run and dry-run, so the release is one workflow run once they're in.

## The 30-minute measure (Q256)

- **Who:** two people the maintainer picks who have never installed ostra, one at a time. A person who helped build it doesn't count. An agent session following only the docs in a browser rehearses it first; the rehearsal finds gaps and never counts.
- **What they have before the clock starts,** as the docs' "Before you start" page lists it: a Linux machine with Docker, admin rights in a GitHub organization (the test org `ostra-test`, for the measure), a model provider's base URL and token, and the docs' address. Nothing else, and nobody to ask.
- **The clock** starts at the install guide's first command and stops when the first agent-made PR is open on GitHub. Reading the guide is inside the clock.
- **ostra records the times itself.** Each setup step's completion is already an audited action (milestone 4's audit log: the password change, the provider, the App, the project, the runner's approval, the first task's start) and the PR's opening is an event. `pnpm measure:setup`, signed in as the instance admin, reads them from the panel's new `setup.timeline` procedure and writes a table of each step's time from the first command. The person writes down the first command's time and where they got stuck.
- **Kept in the repo:** each run's timeline, the person's notes (no names unless they agree), the PR's link, and screenshots with addresses masked. A run over 30 minutes is kept too, with what was fixed in the docs before the next one.
- **F-076 is `done`** when both runs are under 30 minutes on the release candidate's images.

## The load test as the gate (Q257)

ADR 0061's run that counts, unchanged in its bars: 1,000 tasks on three core replicas and one Postgres, on Linux, with a real Postgres on its own disk, on a machine of at least 16 vCPUs and 32 GB, the maintainer's. Milestone 7 adds:

- **It runs on the release candidate**, so a regression since milestone 5 shows.
- *Withdrawn 2026-11-19 with F-018:* the event mix was to gain Claude Code's rates. It stays milestone 5's, on OpenCode's.
- **This machine's ramp is re-run** on the release candidate too, and recorded as the largest step that held, as milestone 5's was. It never stands in for the Linux run.
- **Launch waits** for the Linux run to pass. A failure is a bug to fix, not a bar to move; moving a bar is a change to F-117's row, which the maintainer agrees to.

## The security review of the box (Q258)

**What's reviewed** is the boundary F-017, F-093 and ADR 0030 promise, on the release candidate:

1. **No credential in the agent's container,** on `docker` and `kubernetes`: the model key, the git token, the App's key, the task token, registry credentials and every secret of the environment, searched for by value in the agent's environment, files, process list and network, while a task runs, for OpenCode.
2. **The sidecar's proxies:** the key proxy accepts only its task's placeholder; the git proxy accepts only the task's refs, and only fetches for refine and review tasks; the MCP proxy adds its secret and serves only the task's tools.
3. **The egress baseline:** private ranges, the metadata address and other boxes unreachable from the agent's shell, with the positive control (F-116).
4. **What the agent can reach on the host:** no Docker socket, no host mounts but the workspace, a non-root user, the container's capabilities and seccomp profile, `automountServiceAccountToken: false` on a pod.
5. **Untrusted text:** ticket text, PR comments, review comments, CI logs and agent output never reach a shell line, a SQL string or a log line (`AGENTS.md`'s boundaries), checked by grep and by the fixtures that hold shell syntax.
6. **Each agent's own config from a repo:** OpenCode's repo files that could run commands or add MCP servers don't win over the profile (ADR 0049), the `.claude/` files OpenCode must not pick up stay unread, and a hostile repo's hooks never run. *(Claude Code's half, ADR 0062, waits with F-018.)*
7. **Network from the agent itself:** with the stub model, a turn of OpenCode opens connections only to the sidecar.
8. **The runner protocol and the task token:** a token for one task opens nothing of another's; a revoked runner and an expired token are refused.
9. **The images:** pins and checksums, no secret in a layer, the runner and base images run as non-root.
10. **`host`:** that the panel and the docs say it isn't isolated, and what it does contain (ADR 0029, ADR 0031).

**How:** a threat model per boundary (the agent's container, the sidecar, the runner, the server, the browser), then a checklist with each check's evidence: a test that already proves it (cited, as a proof file does), a log from the Linux proof job, or a finding. Then an **adversarial run** in the proof job, with no secret: a hostile repo fixture (a `.claude/settings.json` hook and an `opencode.json` command that try to run, an `.mcp.json` server, a `postinstall` that reads the environment) and a hostile ticket (instructions to print the key, curl the metadata address, push to `main`, call another task's tools), worked by OpenCode on the stub model that obeys every instruction. It passes when every attempt is refused or reaches nothing, and each attempt's outcome is in its log.

**By whom:** an independent review, written by an agent session that built none of the box's code, with the `security-review` skill and this checklist, and then read and signed by the maintainer. A human penetration test by an outside firm is the maintainer's choice and a paid service, so it isn't a gate; if the maintainer orders one, its report joins the record.

**What it leaves:** `context/specs/m7-launch/security-review.md` (the threat model, the checklist with evidence, every finding with its severity, its fix's commit or its reason to stay open, and what wasn't tested and why), the adversarial run's logs in `context/specs/m7-launch/demo/`, `SECURITY.md` at the repo's root (how to report a vulnerability, through GitHub's private reporting), and the docs' security page, which states the open mediums and lows. A critical or high finding is fixed before launch, and the run is repeated.

## The release (Q259)

**What's published** stays ADR 0045's: the `ostra` CLI, `protocol`, `adapter-sdk` and the adapters on npm; the server, runner and base images (ADR 0046); the docs site (ADR 0063). The server packages stay private.

- **Versions:** Changesets (`@changesets/cli`, already named in ADR 0045, pending the maintainer's yes) bumps every published package together. v1 is `1.0.0`. Release candidates are `1.0.0-rc.N`, published only to a local registry in the proof job. *Built 2026-11-20 (milestone 7's ticket 30) with the fallback ADR 0007 names, `scripts/version.ts`, until the maintainer's own yes to Changesets (ticket 34, step 2): the release's version is the workflow's `version` input, which the script sets on every `package.json`. A candidate is published under npm's `next` tag. The real run needs the repository variables `OSTRA_CLI_PACKAGE` and `OSTRA_IMAGE_NAMESPACE` (the names, Q80, Q82), and the tag it creates points at the commit it ran on; the version bump isn't committed back. docs.yml is called as a reusable workflow, since a release made with the workflow's own token starts no other workflow by its event.*
- **One manual workflow,** `release.yml`, started with `gh workflow run Release` by the maintainer, never on push:
  1. checks out the tagged commit, installs with `--frozen-lockfile`, runs every check;
  2. builds the three images on `ubuntu-24.04`, runs `pnpm check:images`, and pushes them to the namespace the maintainer registered (GitHub's container registry by default, under the maintainer's account or organization), each by digest, with the release's tags;
  3. publishes the npm packages through npm's trusted publishing from GitHub Actions, with provenance: no long-lived npm token exists anywhere;
  4. creates the GitHub release with the changelog, the images' digests and the packages' versions;
  5. starts `docs.yml`.
- **Before the go, the same workflow runs with `--dry-run`:** `npm publish --dry-run` for every package, the images pushed to a `registry:2` inside the job, the release notes written to the job's log. Its log is kept as evidence that the real run is one step.
- **What every artifact carries:** each package its own `LICENSE`; the root `NOTICE`; each image a generated `THIRD_PARTY_NOTICES` of every package it bundles with its license, and no file whose license the license check doesn't know.
- **Afterwards:** the README's status says v1 is out, with the install guide's link, in the same commit as the ledger's last rows.

## Considered options

- **The measure by the maintainer, or by an agent.** Rejected: the row says "a team new to ostra", and both know too much. The agent's run rehearses.
- **The measure on this machine.** Rejected: it has no Docker, and `docker compose up` is the row's first words.
- **A load test bar relaxed to what this machine holds.** Rejected (ADR 0061): the bar is about a server, not a laptop.
- **The security review as a checklist alone,** or **by the agents that built it.** Rejected: a checklist without an adversarial run proves what we thought of, and a builder reviews their own assumptions.
- **An outside penetration test as a gate.** Not a gate: a paid service the maintainer hasn't chosen.
- **Publishing on a tag push.** Rejected: a release is the maintainer's act, and the CI scope keeps heavy jobs manual.
- **An npm token in the repo's secrets.** Rejected: trusted publishing needs none.

## Consequences

- Launch can't happen before the names and the maintainer's go, however finished the code is (the legal items were settled on 2026-11-19, ADR 0048). The spec says so plainly, and the README never says "released" before the workflow has run.
- The hardware the gates need (a Linux machine with Docker for the measure and the load test, a 16-vCPU machine for the load test) is the maintainer's, as ADR 0061 already planned.
- A failed gate is recorded with its evidence, fixed, and run again; it never turns into a note that moves the bar without the maintainer.
- ADR 0045's "Publishing starts at the v1 launch" now has its mechanism.
