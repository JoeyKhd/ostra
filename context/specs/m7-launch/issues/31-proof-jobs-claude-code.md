# 31: Proof jobs: Claude Code on Linux, kind and macOS

Status: ready-for-agent
Builder: runner
Blocked by: 07, 08, 35
Features: F-018, F-017, F-093, F-014 (their Claude Code halves)
Packages: `.github/workflows/proof.yml` (steps in its existing jobs), `scripts/live/`
Spec: `../spec.md`, section 1 ("On this machine"); ADR 0061

## What to build

In milestone 5's manual `proof.yml` jobs, by hand only, with the stub model and no secret:
- **`ubuntu-24.04`:** the agent image for Claude Code built from the base image; the agent suite (ticket 07) run in a `docker` box on it; a Claude Code task end to end on the fake GitHub; the network case (only connections to the sidecar from the agent container).
- **kind:** the agent image through BuildKit into the job's registry, and a Claude Code task in a pod.
- **`macos-15`:** `ostra agents install claude-code` and the agent suite on a `host` runner.

Each job's log goes to `context/specs/m7-launch/demo/`, checked for secrets, and is cited as `live:` evidence.

## Done when

- [ ] The three runs passed by hand, their logs kept and cited in `context/proof/F-018.md`.
- [ ] `ci.yml` is unchanged.
- [ ] Committed as `✅ prove Claude Code on Linux, kind and macOS`.

## Comments
