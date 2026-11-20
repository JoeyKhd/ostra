#!/usr/bin/env bash
# The `live-macos` proof job's steps (ticket 35, ADR 0061, ADR 0029), on a fresh Mac: GitHub's
# `macos-15` in `.github/workflows/proof.yml`, or anyone's own Mac with passwordless sudo (run it
# from a clone after `pnpm install --frozen-lockfile`). It makes a `host` pool's separate agent
# user, its group and the sudoers rule for it alone, then runs the `host` executor's live suite:
# the agent runs as that user and reads nothing of the runner's, and the marker sweep ends a
# detached helper that kept the marker, while one that cleared its environment is the gap ADR 0029
# names. No secret is used or printed; the agent user's password is random and never shown.
#
#   scripts/live/macos.sh

cd "$(dirname "$0")/../.." || exit 1
. scripts/live/lib.sh

AGENT_USER="ostra-agent"
say "live-macos on $(sw_vers -productName) $(sw_vers -productVersion) ($(uname -m)), $(sysctl -n hw.ncpu) CPUs"

agent_user() {
  sudo dseditgroup -o create -r "ostra agent" "$AGENT_USER" || return 1
  password="$(openssl rand -base64 24)"
  sudo sysadminctl -addUser "$AGENT_USER" -fullName "ostra agent" -password "$password" >/dev/null 2>&1 || return 1
  unset password
  sudo dseditgroup -o edit -a "$AGENT_USER" -t user "$AGENT_USER" || return 1
  sudo dseditgroup -o edit -a "$(id -un)" -t user "$AGENT_USER" || return 1
  printf '%s ALL=(%s) NOPASSWD:SETENV: ALL\nDefaults>%s umask=0007, umask_override\n' "$(id -un)" "$AGENT_USER" "$AGENT_USER" | sudo tee /etc/sudoers.d/ostra-agent >/dev/null
  sudo chmod 0440 /etc/sudoers.d/ostra-agent && sudo visudo -cf /etc/sudoers.d/ostra-agent || return 1
  sudo dscacheutil -flushcache
  id "$AGENT_USER" && dseditgroup -o checkmember -m "$(id -un)" "$AGENT_USER"
}
step host-pool-agent-user agent_user

host_live() {
  OSTRA_TEST_HOST_POOL_AGENT_USER="$AGENT_USER" pnpm --filter @ostra/adapter-executor-host exec vitest run --reporter verbose src/host-executor.live.test.ts
}
step host-pool-live host_live
step host-executor-contract pnpm --filter @ostra/adapter-executor-host exec vitest run --reporter verbose src/host-executor.contract.test.ts

finish
