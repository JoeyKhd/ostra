#!/bin/sh
# The server image's entrypoint, `ostra-server` (ADR 0046): `web`, `core` or `all`, and `health`
# for the image's HEALTHCHECK. `core` and `all` run the migrations first. `all` runs both processes
# and stops when either stops. Arguments are fixed words, never interpolated into a command.
set -eu

cd /app

# The process this container runs, for `health`. On a read-only root filesystem (the Helm chart)
# it isn't written: the chart probes its own addresses.
ROLE_FILE=/tmp/ostra-server-role

migrate() {
  node packages/db/scripts/migrate.ts
}

start_web() {
  cd /app/apps/web
  exec node node_modules/next/dist/bin/next start --port "${OSTRA_WEB_PORT:-3000}"
}

case "${1:-all}" in
  web)
    echo web > "$ROLE_FILE" 2>/dev/null || true
    start_web
    ;;
  core)
    echo core > "$ROLE_FILE" 2>/dev/null || true
    migrate
    exec node apps/core/src/main.ts
    ;;
  all)
    echo all > "$ROLE_FILE" 2>/dev/null || true
    migrate
    node apps/core/src/main.ts &
    core=$!
    (start_web) &
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
  health)
    role=$(cat "$ROLE_FILE" 2>/dev/null || echo all)
    # core answers /healthz; the panel answers its sign-in redirect. Anything under 500 is up.
    exec node -e '
      const role = process.argv[1];
      const core = `http://127.0.0.1:${process.env.OSTRA_CORE_PORT ?? "8787"}/healthz`;
      const web = `http://127.0.0.1:${process.env.OSTRA_WEB_PORT ?? "3000"}/`;
      const urls = role === "core" ? [core] : role === "web" ? [web] : [core, web];
      const up = async (url) => (await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(4000) })).status < 500;
      Promise.all(urls.map(up)).then((all) => process.exit(all.every(Boolean) ? 0 : 1), () => process.exit(1));
    ' "$role"
    ;;
  *)
    echo "ostra-server: use web, core, all or health" >&2
    exit 2
    ;;
esac
