#!/usr/bin/env bash
# F-076 (ticket 22): milestone 1's setup specs (01-shell, 02-setup, 03-first-run) against a fresh
# `docker compose up` of the install guide's compose file, on Linux with Docker. proof.yml's
# docs-commands job runs it after the guide's own commands; anyone can run it on their own machine.
#
#   bash apps/web/e2e/compose-e2e.sh <folder holding the guide's compose.yaml>
#
# The images must exist already (`docker compose -f deploy/compose.yaml --profile images build`).
# The stack is taken down with its volumes first, so the specs meet a fresh install, and again at
# the end. The fakes (`fakes.ts`) run beside it on loopback; `compose.e2e.yaml` says what the
# overlay changes. No secret is used.
set -euo pipefail

stack_dir=$(cd "${1:?usage: compose-e2e.sh <folder holding compose.yaml>}" && pwd)
web_dir=$(cd "$(dirname "$0")/.." && pwd)
overlay="$web_dir/e2e/compose.e2e.yaml"
fakes_env="$web_dir/e2e/.fakes.env"
compose=(docker compose --project-directory "$stack_dir" -f "$stack_dir/compose.yaml" -f "$overlay")

fakes_pid=""
finish() {
  status=$?
  if [ "$status" -ne 0 ]; then
    "${compose[@]}" ps -a || true
    "${compose[@]}" logs --no-color --tail 200 server || true
  fi
  if [ -n "$fakes_pid" ]; then kill "$fakes_pid" 2>/dev/null || true; fi
  "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "$fakes_env"
  exit "$status"
}
trap finish EXIT

echo "== a fresh install: the guide's stack down, with its volumes"
docker compose --project-directory "$stack_dir" -f "$stack_dir/compose.yaml" down -v --remove-orphans

echo "== the fakes: the fake GitHub and the stub model endpoints, on loopback"
rm -f "$fakes_env"
(cd "$web_dir" && exec node e2e/fakes.ts) &
fakes_pid=$!
for _ in $(seq 1 60); do
  if [ -s "$fakes_env" ]; then break; fi
  if ! kill -0 "$fakes_pid" 2>/dev/null; then echo "the fakes exited before they were up" >&2; exit 1; fi
  sleep 1
done
if [ ! -s "$fakes_env" ]; then echo "the fakes weren't up in 60 s" >&2; exit 1; fi
set -a
# shellcheck source=/dev/null
. "$fakes_env"
set +a

echo "== docker compose up, with the overlay"
"${compose[@]}" up -d
"${compose[@]}" ps
curl -fsS --retry 60 --retry-delay 2 --retry-all-errors http://127.0.0.1:8787/healthz
echo
curl -fsS -o /dev/null --retry 60 --retry-delay 2 --retry-all-errors http://localhost:3000/sign-in
echo "the stack is up"

echo "== the setup specs, on the compose stack"
cd "$web_dir"
OSTRA_E2E_PANEL_URL=http://localhost:3000 OSTRA_E2E_CORE_URL=http://127.0.0.1:8787 \
  pnpm exec playwright test --project=desktop e2e/01-shell.spec.ts e2e/02-setup.spec.ts e2e/03-first-run.spec.ts
