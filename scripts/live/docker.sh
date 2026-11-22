#!/usr/bin/env bash
# The `live-docker` proof job's steps (ticket 35, ADR 0061), on a fresh Linux machine with Docker:
# GitHub's `ubuntu-24.04` in `.github/workflows/proof.yml`, or anyone's own Linux box (run it from a
# clone, after `pnpm install --frozen-lockfile && pnpm turbo run generate`). It needs passwordless
# sudo for the steps that make an OS user, apply the egress rules or start a second Docker Engine.
# Every image it pulls is pinned by digest; no secret is used or printed. Logs go to $LIVE_OUT.
#
#   scripts/live/docker.sh
#
# Each step ends in a RESULT line (scripts/live/lib.sh). The proof files cite these logs as `live:`
# evidence once ticket 37 keeps them in `context/specs/m5-the-fleet/demo/linux/`.

cd "$(dirname "$0")/../.." || exit 1
. scripts/live/lib.sh

VERSION="$(node -p "require('./apps/runner/package.json').version")"
SERVER="ostra/server:$VERSION"
RUNNER="ostra/runner:$VERSION"
BASE="ostra/base:$VERSION"
REGISTRY_IMAGE="registry:3.0.0@sha256:6c5666b861f3505b116bb9aa9b25175e71210414bd010d92035ff64018f9457e"
DIND_IMAGE="docker:28.5.2-dind@sha256:2a232a42256f70d78e3cc5d2b5d6b3276710a0de0596c145f627ecfae90282ac"
HTPASSWD_IMAGE="httpd:2.4.65-alpine@sha256:07b2fabb7029a0b8aeb2e0fd02651c28fe22c21c5b5a59d6ff5b022791fcd89e"
NGINX_IMAGE="nginx:1.29.3@sha256:2f4e10193b0c4f61472245e9d26cea78e7df7af266c7e7cf5e67353ee2731b51"
# The live registry's test credential: made up for this run, valid only on this machine's registry.
REGISTRY_USER="ostra"
REGISTRY_TOKEN="ostra-live-registry"

say "live-docker on $(uname -srm), $(nproc) CPUs, $(free -g | awk '/Mem:/ {print $2}') GB, Docker $(docker version --format '{{.Server.Version}}'), images $VERSION"

# ---- F-039: the three images, built, sized and started ----
step images-build pnpm images:build
step image-sizes docker image ls --format '{{.Repository}}:{{.Tag}} {{.Size}}' --filter reference='ostra/*'
step runner-version docker run --rm "$RUNNER" --version
step base-opencode docker run --rm --entrypoint sh "$BASE" -c 'opencode --version && sha256sum "$(readlink -f "$(command -v opencode)")"'

# ---- F-039 (milestone 7's ticket 29): each image's THIRD_PARTY_NOTICES, written and checked in its
# build; here their package count and first entries, and the runner holding no OpenCode ----
image_notices() {
  for image in "$SERVER" "$RUNNER" "$BASE"; do
    docker run --rm --entrypoint sh "$image" -c 'f=/usr/share/doc/ostra/THIRD_PARTY_NOTICES; sed -n 8p "$f"; grep -c "^Package: " "$f"; grep -m 3 "^Package: " "$f"' || return 1
  done
}
step image-notices image_notices
step runner-no-agent docker run --rm --entrypoint sh "$RUNNER" -c '! ls /app/node_modules/.pnpm | grep "^@opencode+cli" && ! command -v opencode && echo "no OpenCode in the runner image"'

# ---- F-001 and F-039: `docker compose up` with only the required settings, the server's `all`
# healthy by its own check, and the compose file's pool runner joined with the bootstrap token ----
compose_up() {
  docker compose -f deploy/compose.yaml up -d postgres server runner || return 1
  for _ in $(seq 1 60); do
    health="$(docker inspect --format '{{.State.Health.Status}}' "$(docker compose -f deploy/compose.yaml ps -q server)")"
    echo "server health: $health"
    if [ "$health" = "healthy" ]; then break; fi
    sleep 5
  done
  [ "$health" = "healthy" ] || return 1
  curl -fsS -o /dev/null -w 'panel %{http_code}\n' http://localhost:3000/sign-in || return 1
  # The runner joins with the bootstrap join token core wrote, and connects.
  for _ in $(seq 1 36); do
    if docker compose -f deploy/compose.yaml logs server 2>/dev/null | grep -q '"msg":"gateway.peer-open"'; then
      echo "the compose file's pool runner connected"
      return 0
    fi
    sleep 5
  done
  echo "the pool runner never connected"
  return 1
}
step compose-up compose_up
docker compose -f deploy/compose.yaml logs --no-color >"$LIVE_OUT/compose-stack.log" 2>&1
docker compose -f deploy/compose.yaml down -v >/dev/null 2>&1

# ---- F-116: the egress baseline applied, so the probes from a box run against it ----
egress_baseline() {
  subnet="172.30.0.0/16"
  gateway="$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')"
  # The server's port: core's, as compose publishes it on the host (deploy/compose.yaml).
  # The rules name no "ostra": they're the ones from the egress subnet, in DOCKER-USER and INPUT.
  sudo ./deploy/egress-baseline.sh "$subnet" "$gateway" 8787 && sudo iptables -S | grep -F -- "-s $subnet"
}
step egress-baseline egress_baseline

# ---- F-120: a registry:2 with Basic auth, and a second Docker Engine to pull on ----
registry_up() {
  mkdir -p "$RUNNER_TEMP_DIR/registry-auth"
  docker run --rm --entrypoint htpasswd "$HTPASSWD_IMAGE" -Bbn "$REGISTRY_USER" "$REGISTRY_TOKEN" >"$RUNNER_TEMP_DIR/registry-auth/htpasswd" || return 1
  docker run -d --name ostra-live-registry -p 127.0.0.1:5000:5000 \
    -v "$RUNNER_TEMP_DIR/registry-auth:/auth:ro" \
    -e REGISTRY_AUTH=htpasswd -e REGISTRY_AUTH_HTPASSWD_REALM=ostra-live -e REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd \
    "$REGISTRY_IMAGE" || return 1
  # The second Engine shares this host's network, so `localhost:5000` is the same registry to it;
  # its own bridge and rules are off so they don't touch the first Engine's. With no bridge it has
  # no address for a box sidecar's `host-gateway` entry, so it's given one (the box never calls it).
  docker run -d --name ostra-live-dind --privileged --network host -e DOCKER_TLS_CERTDIR= \
    "$DIND_IMAGE" dockerd --host tcp://127.0.0.1:2375 --bridge none --iptables=false --ip6tables=false \
    --host-gateway-ip 127.0.0.1 \
    --data-root /var/lib/docker-second --exec-root /var/run/docker-second --pidfile /var/run/docker-second.pid || return 1
  for _ in $(seq 1 30); do
    if DOCKER_HOST=tcp://127.0.0.1:2375 docker version >/dev/null 2>&1; then
      echo "the second Engine answers"
      # A second pool host has the runner's image, which runs every box's sidecar: it's loaded
      # there, and only the box's own image comes from the registry.
      docker save "$RUNNER" | DOCKER_HOST=tcp://127.0.0.1:2375 docker load || return 1
      return 0
    fi
    sleep 2
  done
  docker logs ostra-live-dind 2>&1 | tail -n 30
  return 1
}
RUNNER_TEMP_DIR="${RUNNER_TEMP:-/tmp}"
step registry-and-second-engine registry_up

# ---- the docker executor's live suite: a box, its size from the cgroup and a stress held at it,
# the push and the pull by digest on the second Engine, a box that outlives its runner, every egress
# probe with its control; then the snapshot's and a service's ----
docker_live() {
  OSTRA_TEST_BASE_IMAGE="$BASE" OSTRA_TEST_RUNNER_IMAGE="$RUNNER" \
    OSTRA_TEST_REGISTRY="localhost:5000" OSTRA_TEST_REGISTRY_USER="$REGISTRY_USER" OSTRA_TEST_REGISTRY_TOKEN="$REGISTRY_TOKEN" \
    OSTRA_TEST_SECOND_DOCKER_HOST="tcp://127.0.0.1:2375" OSTRA_TEST_EGRESS_APPLIED=1 \
    pnpm --filter @ostra/adapter-executor-docker exec vitest run --reporter verbose src/docker.live.test.ts src/snapshot/snapshot.live.test.ts
}
step docker-executor-live docker_live
step docker-executor-contract pnpm --filter @ostra/adapter-executor-docker exec vitest run --reporter verbose src/docker-executor.contract.test.ts

# ---- F-121 (milestone 8's ticket 11): the executor suite's browser case in the base image, under
# the agent container's hardening and a small box's size: the real init and bridge, Debian's
# Chromium as the agent's user with its container flags (src/init/box-browser-flags.ts), a page at
# the app's localhost, a PNG, and no profile left (src/init/browser-probe.ts). Then the pinned
# Chromium and its fonts, as the image carries them ----
box_browser() {
  docker run --rm --user 0:0 --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add KILL \
    --security-opt no-new-privileges:true --init --network none --pids-limit 4096 --cpus 2 --memory 4g --memory-swap 4g \
    --entrypoint node "$BASE" /opt/ostra/app/packages/adapters/adapter-executor-docker/src/init/browser-probe-main.ts || return 1
  docker run --rm --entrypoint sh "$BASE" -c \
    'dpkg-query -W -f "\${Package} \${Version}\n" chromium chromium-common fonts-liberation fonts-noto-color-emoji && fc-list : family | grep -E "Liberation|Noto Color Emoji" | sort -u && grep -c "^Package: chromium@" /usr/share/doc/ostra/THIRD_PARTY_NOTICES && test -s /usr/share/doc/chromium/copyright'
}
step box-browser box_browser

# ---- F-014 and F-015: a `host` pool as the docs make it: the runner's user and the agent's, the
# sudoers rule for the agent's user alone, and the runner as a systemd service with Delegate=yes,
# so each task gets a cgroup of its own (scripts/live/host-pool.sh) ----
. scripts/live/host-pool.sh
step host-pool-agent-user host_pool_users
step host-pool-live host_pool_live

# ---- F-013: real nginx's defaults in front of core ----
not_run nginx-fallback "no test drives the runner's HTTP fallback through a real nginx yet: the fallback is proved against ticket 06's nginx emulation (spike 6's), and $NGINX_IMAGE is pinned here for the test that will"

# ---- F-093: the sidecar's memory, which only a real host shows (F-017's 50 boxes and its ready time are docker.live.test.ts's, in docker-executor-live) ----
not_run sidecar-memory "no live test reads the sidecar's memory under 50 boxes yet"
not_run gvisor "runsc is optional (ticket 35) and not installed on this run"

finish
