# One CLI and three images; signed binaries come after v1

**Status:** accepted (2026-11-18, from the delegated answers in `context/history/answers-2026-11-18.md`). Settles Q80 and Q82. **Supersedes ADR 0023.** Ledger: F-013, F-039, F-103, and F-085, which moves after v1. **Amended 2026-11-19 for milestone 5's spec**, on the maintainer's delegation: how the images are built and checked before they're published (Q244; "Milestone 5: building the images" below). **Amended again 2026-11-19 for milestone 7's spec** (Q252, ADR 0062): no published image holds an Anthropic file until the maintainer records that Anthropic's terms allow it; a runner builds a local agent image for Claude Code instead ("Milestone 7: agents ostra doesn't redistribute" below).

ostra ships as one command-line program and three Docker images.

## The CLI

One Apache-2.0 program, `ostra`, built from `apps/runner` (ADR 0045). It runs on Node LTS and is published to npm. **Its minimum Node is 24.5 or later (22.21 or later on the 22 line)**, set in the CLI's `engines`, because the runner gets through a CONNECT proxy with Node's own `https.Agent` and `proxyEnv` option, which spike 6 showed is enough and which arrived in those releases (ADR 0034). The repo root's `>=24.2` is lower and doesn't bind the CLI.

| Command | What it does |
|---|---|
| `ostra runner` | Starts a runner. A pool runner starts with the pool's join token. A personal runner signs in with a device code that the member approves in the browser (ADR 0029, F-013) |
| `ostra login` | Signs in to a server from a terminal |
| `ostra checkout CALC-161` | Puts the task's branches on the developer's machine, so a hand edit starts from what the agent did (Q74, F-103) |

- **The sidecar is the same binary, in an internal mode.** It isn't a command for people. One binary is one thing to version and document, and the same task code runs in every executor (ADR 0029).
- **The name `ostra-runner` is retired: as a command, as a docs name and as a package name.** F-013 now says `ostra runner`.
- **The command is always `ostra`.** The npm package's name depends on which names are free. npm's `ostra` is taken and abandoned since 2023 (`build-order.md`), so the maintainer checks and registers a name before milestone 7. The package's `bin` is `ostra` whatever the package is called.
- **It talks to the server only through the schemas in `protocol`,** which keeps it clear of the Sustainable Use code (ADR 0045).
- **Its version is ostra's release version.** A runner is pinned to its server's version when it joins, and the server accepts one minor version older or newer (ADR 0022, F-061).

## The images

| Image | What's in it | Used for |
|---|---|---|
| **Server** | `ostra-server` with one entrypoint: `web`, `core` or `all`. Built with `turbo prune --docker` | A compose install runs `all` in one container. A Kubernetes install runs `web` and `core` as separate deployments of the same image, with any number of replicas of each (ADR 0016) |
| **Runner** | The `ostra` CLI: the pool runner and the sidecar | Pool hosts, and the sidecar container of every box |
| **Base** | The tools, every v1 agent (pinned) and a small init program | The agent's container in every box, and the default base image of an environment (Q33) |

- **The base image pins every v1 agent.** OpenCode's version is fixed there and its checksum is verified, as `research/rivet.md` asks. The mechanism, from spike 1: the image installs `@opencode/cli` (the V2 line, not the `opencode-ai` package, whose default is the 1.x line that tried the network during a turn) at an exact version with install scripts off, and checks the SHA-256 of the platform binary. The expected SHA-256 is pinned in the repo and is never taken from the same download the build fetched, because a checksum derived from the thing it checks proves nothing (spike 3's draft did that unless told otherwise). The model catalog goes in as a file, with the fetch off (ADR 0032, ADR 0033). From milestone 7, Claude Code's ACP adapter is pinned the same way, once its redistribution terms are checked (ADR 0032). Nothing is downloaded when a box starts.
- **The runner image and the base image are separate** because a box splits the sidecar, which holds the credentials, from the agent's container, which never does (ADR 0029, ADR 0030).
- **Tags follow the release.** Images are tagged per release (ADR 0022).
- **Where they're published** is the maintainer's choice of registry and namespace, made before milestone 7.

## Signed binaries come after v1

ADR 0023 planned signed native binaries, compiled with Bun, before launch. That moves after v1 (F-085).

- An unsigned binary is blocked by macOS's Gatekeeper and flagged by Windows SmartScreen. That reason stands, and it's why binaries wait until they can be signed.
- **v1 doesn't need them.** Laptops use the npm CLI, since members' machines usually have Node. Servers use the images. Neither path meets a signing warning.
- **No Bun in v1.** The runner is tested on Node on Windows 11, macOS and Linux. Dropping Bun halves the runner's test matrix.
- **No signing certificates are needed before launch.** The Apple Developer Program membership and the Windows code-signing certificate that ADR 0023 accepted are due when F-085 starts.

## Considered options

- **Signed Bun binaries before launch (ADR 0023).** Rejected for v1: every v1 install path is clean without them, and they double the test matrix. They come right after v1.
- **Unsigned binaries from the start.** Rejected: ADR 0023's reason holds.
- **Homebrew, Scoop and winget.** Rejected for v1, as in ADR 0023. They can come beside the signed binaries.
- **A separate `ostra-runner` program beside the CLI.** Rejected: two programs to version, sign and document, and the sidecar would be a third.
- **One image each for `web` and `core`.** Rejected: one image keeps a compose install and a Kubernetes install on the same build. The entrypoint picks the process.
- **One runner image that also carries the agent.** Rejected: the agent's container must hold no credential, and the sidecar must not carry the agent's tools.
- **Installing the agent when a box starts.** Rejected: a pinned, checksum-verified image is what lets a box start in seconds and lets a pin be audited.

## Consequences

- ADR 0008 is amended: the runner ships as an npm CLI and in images, and Bun is not required in v1. Spikes 3 and 6 run on Node only.
- The self-hosting docs say that `NODE_EXTRA_CA_CERTS` is read when the runner starts and not later (ADR 0034).
- A fresh install works with the compose file and the images alone. It needs no download of a binary (F-001, F-039).
- If no reasonable npm name is free, the CLI ships in the runner image and as a download.
- If the base image grows too large, it splits by language.
- Milestone 7 publishes the CLI and the images (ADR 0045). Until then, they're built from source.

## Milestone 5: building the images

Added 2026-11-19 (Q244), for `specs/m5-the-fleet/spec.md`.

- **`pnpm images:build`** builds the three images from source on a Linux machine with Docker, tags them with the release version and prints their sizes. It runs in the manual proof job on `ubuntu-24.04` (ADR 0061) and on the maintainer's machine. Nothing is pushed anywhere public before milestone 7.
- **`pnpm check:images`** runs everywhere, in CI too: every `FROM` pinned by digest, OpenCode's checksum taken from the repo's pin (`pinnedChecksums`) and never from the download, no secret-shaped `ARG`, `ENV` or `RUN`, and the compose file running the images the build tags.
- **A built image is checked by starting it:** the server's `all` answers its health check, `ostra --version` prints the release in the runner image, and the base image's OpenCode reports the pinned version with the pinned checksum. F-039 stays `building` until the images are published.

## Milestone 7: agents ostra doesn't redistribute

Added 2026-11-19 for milestone 7's spec (Q252, ADR 0062).

- **The published base image pins OpenCode only** until the maintainer answers Q266 and records here that Anthropic's terms allow ostra to redistribute Claude Code. `pnpm check:images` fails when a published image holds a file from an `@anthropic-ai/*` package.
- **An agent image** is how a `docker` or `kubernetes` runner gets an agent the base image lacks: `FROM` the base image's digest, with the agent's pinned install (`npm install --ignore-scripts` at the exact version) and its checksum checked, built by the runner through the snapshot builder (a Docker build, or BuildKit and the organization's registry on `kubernetes`), once per base digest and agent version. A project's snapshot builds on it. It's never pushed anywhere but the organization's own registry.
- **On `host`**, the runner installs the agent's pinned package into its data folder on first need (or with `ostra agents install <agent>`), and checks the checksum before every launch.
- **"Nothing is downloaded when a box starts" still holds:** the download happens when the agent image is built or the `host` install runs, never in a box.
- **If the terms allow it,** the base image gains the pinned install and the agent image is skipped for that agent. The mechanism stays for agents whose terms don't.
