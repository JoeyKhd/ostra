#!/bin/sh
# The server image's entrypoint (ADR 0046): `web`, `core` or `all`. `all` runs the migrations, then
# both processes, and stops when either stops. Arguments are fixed words, never interpolated.
set -eu

cd /app

migrate() {
  node packages/db/scripts/migrate.ts
}

case "${1:-all}" in
  web)
    exec pnpm --filter @ostra/web start
    ;;
  core)
    migrate
    exec node apps/core/src/main.ts
    ;;
  all)
    migrate
    node apps/core/src/main.ts &
    core=$!
    pnpm --filter @ostra/web start &
    web=$!
    trap 'kill "$core" "$web" 2>/dev/null' INT TERM
    # Either one ending ends the container, so the orchestrator restarts both.
    while kill -0 "$core" 2>/dev/null && kill -0 "$web" 2>/dev/null; do
      sleep 2
    done
    kill "$core" "$web" 2>/dev/null || true
    wait
    exit 1
    ;;
  *)
    echo "ostra-server: use web, core or all" >&2
    exit 2
    ;;
esac
