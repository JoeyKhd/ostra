# A `host` pool on this machine, made as the docs' "A pool on the host executor" says
# (apps/docs/content/runners/pools.mdx), and the `host` executor's live suite run as that pool's
# runner user (packages/adapters/adapter-executor-host/src/host-executor.live.test.ts): ticket 35's
# Linux and macOS jobs, milestone 2's ticket 42. Sourced by docker.sh and macos.sh, after lib.sh.
#
# The job's own user can sudo to anyone (GitHub's runners do), which a pool runner's user must not:
# the runner refuses to start when sudo lets it act as root. So the suite runs as `ostra-runner`,
# whose only sudoers rule is the docs' one for `ostra-agent`. On Linux it runs as a systemd service
# with `Delegate=yes` and `User=ostra-runner`, as the docs' unit file starts the runner, so the
# runner has a cgroup of its own and each task gets one under it. No secret is used or printed: the
# users' passwords are random and never shown, and nobody signs in as them.

HOST_POOL_RUNNER="ostra-runner"
HOST_POOL_AGENT="ostra-agent"
if [ "$(uname -s)" = "Darwin" ]; then
  HOST_POOL_DATA="/usr/local/var/ostra-runner"
else
  HOST_POOL_DATA="/var/lib/ostra-runner"
fi

# host_pool_users: the docs' steps, as written there: the two users, the agent's group with the
# runner's user in it, the data folder, and the sudoers rule (with milestone 8's
# `closefrom_override`, for the box's browser's pipe).
host_pool_users() {
  if [ "$(uname -s)" = "Darwin" ]; then
    sudo dseditgroup -o create "$HOST_POOL_AGENT" || return 1
    sudo sysadminctl -addUser "$HOST_POOL_AGENT" -fullName "ostra agent" -password "$(openssl rand -base64 24)" >/dev/null 2>&1 || return 1
    sudo dscl . -create "/Users/$HOST_POOL_AGENT" PrimaryGroupID "$(dscl . -read "/Groups/$HOST_POOL_AGENT" PrimaryGroupID | awk '{print $2}')" || return 1
    sudo sysadminctl -addUser "$HOST_POOL_RUNNER" -fullName "ostra runner" -password "$(openssl rand -base64 24)" >/dev/null 2>&1 || return 1
    sudo dseditgroup -o edit -a "$HOST_POOL_RUNNER" -t user "$HOST_POOL_AGENT" || return 1
    sudo dscacheutil -flushcache
  else
    sudo useradd --create-home --shell /bin/bash "$HOST_POOL_RUNNER" || return 1
    sudo useradd --create-home --shell /bin/bash "$HOST_POOL_AGENT" || return 1
    sudo usermod -aG "$HOST_POOL_AGENT" "$HOST_POOL_RUNNER" || return 1
  fi
  sudo install -d -o "$HOST_POOL_RUNNER" -m 0711 "$HOST_POOL_DATA" || return 1
  printf '%s ALL=(%s) NOPASSWD:SETENV: ALL\nDefaults>%s umask=0007, umask_override, closefrom_override\n' "$HOST_POOL_RUNNER" "$HOST_POOL_AGENT" "$HOST_POOL_AGENT" | sudo tee /etc/sudoers.d/ostra-runner >/dev/null || return 1
  sudo chmod 0440 /etc/sudoers.d/ostra-runner || return 1
  sudo visudo -cf /etc/sudoers.d/ostra-runner || return 1
  # What the log shows: both users and their groups, the data folder, and what sudo lets the
  # runner's user do (the agent's user, nobody else).
  id "$HOST_POOL_RUNNER" && id "$HOST_POOL_AGENT" && ls -ld "$HOST_POOL_DATA" && sudo -l -U "$HOST_POOL_RUNNER"
}

# host_pool_live: the live suite as the runner's user. The checkout and Node stay where the job put
# them, so each folder above them that the job's user owns lets other users through (a home folder
# is closed to them on Ubuntu); nothing in them is made writable.
host_pool_live() {
  node="$(command -v node)" || return 1
  package="$PWD/packages/adapters/adapter-executor-host"
  for start in "$package" "$(dirname "$node")"; do
    dir="$start"
    while [ "$dir" != "/" ]; do
      if [ -O "$dir" ]; then chmod o+x "$dir" || return 1; fi
      dir="$(dirname "$dir")"
    done
  done
  path="$(dirname "$node"):/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  # Node reads the Vitest config itself: Vite's default loader writes it out beside the config first,
  # in a folder this user can't write. Vitest's own caches are best-effort and skip when they can't.
  set -- run --configLoader native --reporter verbose src/host-executor.live.test.ts
  if [ "$(uname -s)" = "Darwin" ]; then
    (cd "$package" && sudo -u "$HOST_POOL_RUNNER" -H env PATH="$path" TMPDIR=/tmp \
      OSTRA_TEST_HOST_POOL_AGENT_USER="$HOST_POOL_AGENT" OSTRA_TEST_HOST_POOL_DATA_ROOT="$HOST_POOL_DATA" \
      "$node" node_modules/vitest/vitest.mjs "$@")
  else
    sudo systemd-run --wait --pipe --collect \
      -p User="$HOST_POOL_RUNNER" -p Delegate=yes -p WorkingDirectory="$package" \
      --setenv=PATH="$path" --setenv=TMPDIR=/tmp \
      --setenv=OSTRA_TEST_HOST_POOL_AGENT_USER="$HOST_POOL_AGENT" --setenv=OSTRA_TEST_HOST_POOL_DATA_ROOT="$HOST_POOL_DATA" \
      "$node" node_modules/vitest/vitest.mjs "$@"
  fi
}
