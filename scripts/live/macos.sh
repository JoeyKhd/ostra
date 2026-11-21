#!/usr/bin/env bash
# The `live-macos` proof job's steps (ticket 35, ADR 0061, ADR 0029), on a fresh Mac: GitHub's
# `macos-15` in `.github/workflows/proof.yml`, or anyone's own Mac with passwordless sudo (run it
# from a clone after `pnpm install --frozen-lockfile`). It makes a `host` pool as the docs say (the
# runner's user, the agent's user with a group of its own, the data folder and the sudoers rule for
# the agent's user alone: scripts/live/host-pool.sh), then runs the `host` executor's live suite as
# the runner's user: the agent runs as its own user and reads nothing of the runner's, and the
# marker sweep ends a detached helper that kept the marker, while one that cleared its environment
# is the gap ADR 0029 names. No secret is used or printed; the users' passwords are random and
# never shown.
#
#   scripts/live/macos.sh

cd "$(dirname "$0")/../.." || exit 1
. scripts/live/lib.sh
. scripts/live/host-pool.sh

say "live-macos on $(sw_vers -productName) $(sw_vers -productVersion) ($(uname -m)), $(sysctl -n hw.ncpu) CPUs"

step host-pool-agent-user host_pool_users
step host-pool-live host_pool_live
step host-executor-contract pnpm --filter @ostra/adapter-executor-host exec vitest run --reporter verbose src/host-executor.contract.test.ts

finish
