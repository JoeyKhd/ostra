#!/usr/bin/env bash
# The snapshot build on Docker, with rootless BuildKit (ADR 0038, ADR 0029).
# The runner generates the Dockerfile (src/snapshot/dockerfile.ts), stages the
# repo checkouts and the setup secrets, then runs this. No root, no Docker
# socket: `buildctl` talks to a rootless `buildkitd`.
#
# Usage:
#   deploy/snapshot/build-rootless.sh <context-dir> <image-ref>
# The context dir holds the generated Dockerfile, setup.sh and repos/<name>/.
# Setup secrets are passed by path in OSTRA_SETUP_SECRET_<ID>_FILE env vars.
# OSTRA_SNAPSHOT_OUTPUT overrides where the image goes. The default pushes it;
# the harness sets `type=oci,dest=<file>.tar` to scan every layer for the
# setup secret without a registry.
set -euo pipefail

CONTEXT="${1:?usage: build-rootless.sh <context-dir> <image-ref>}"
IMAGE="${2:?usage: build-rootless.sh <context-dir> <image-ref>}"

# A rootless daemon per build, torn down on exit; no shared state between tasks.
export BUILDKIT_HOST="${BUILDKIT_HOST:-unix:///run/user/$(id -u)/buildkit/buildkitd.sock}"
started=""
if ! buildctl --addr "$BUILDKIT_HOST" debug workers >/dev/null 2>&1; then
  rootlesskit buildkitd --oci-worker-no-process-sandbox &
  started=$!
  for _ in $(seq 1 50); do
    buildctl --addr "$BUILDKIT_HOST" debug workers >/dev/null 2>&1 && break
    sleep 0.2
  done
fi
cleanup() { [ -n "$started" ] && kill "$started" 2>/dev/null || true; }
trap cleanup EXIT

secret_args=()
while IFS='=' read -r name value; do
  case "$name" in
    OSTRA_SETUP_SECRET_*_FILE)
      id="$(printf '%s' "$name" | sed -E 's/^OSTRA_SETUP_SECRET_(.*)_FILE$/\1/' | tr 'A-Z' 'a-z')"
      secret_args+=("--secret" "id=${id},src=${value}")
      ;;
  esac
done < <(env)

buildctl --addr "$BUILDKIT_HOST" build \
  --frontend=dockerfile.v0 \
  --local context="$CONTEXT" \
  --local dockerfile="$CONTEXT" \
  "${secret_args[@]}" \
  --output "${OSTRA_SNAPSHOT_OUTPUT:-type=image,name=${IMAGE},push=true}"

echo "snapshot built: ${IMAGE}"
