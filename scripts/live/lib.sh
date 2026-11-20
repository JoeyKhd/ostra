# Shared by the live proof scripts (ticket 35, ADR 0061): each step runs with its output in its own
# log under $LIVE_OUT, and ends in one RESULT line: `pass`, `fail`, or `not-run` with the reason a
# hosted runner can't do it. A script exits non-zero when any step failed; a step that didn't run
# leaves its condition `partial` in the proof files, and says so here and in the log.
#
# Source it: `. scripts/live/lib.sh`. Nothing here prints a secret: the jobs use none, and
# `scripts/live/check-logs.sh` checks the logs for anything that looks like one before they're kept.

set -u

LIVE_OUT="${LIVE_OUT:-$PWD/live-logs}"
mkdir -p "$LIVE_OUT"
LIVE_RESULTS="$LIVE_OUT/results.txt"
: >>"$LIVE_RESULTS"
LIVE_FAILED=0

# say <text>: one line of the job's own narration, with the time.
say() {
  printf '%s %s\n' "$(date -u +%H:%M:%SZ)" "$*" | tee -a "$LIVE_OUT/steps.log"
}

# result <step> <pass|fail|not-run> <detail>
result() {
  printf 'RESULT %s %s: %s\n' "$1" "$2" "$3" | tee -a "$LIVE_RESULTS" "$LIVE_OUT/steps.log"
  if [ "$2" = "fail" ]; then LIVE_FAILED=1; fi
}

# step <name> <command...>: runs the command with its output in $LIVE_OUT/<name>.log, and records
# pass or fail with its time.
step() {
  name="$1"
  shift
  say "step $name: $*"
  started=$(date +%s)
  if "$@" >"$LIVE_OUT/$name.log" 2>&1; then
    result "$name" pass "$(($(date +%s) - started)) s, log $name.log"
  else
    code=$?
    result "$name" fail "exit $code after $(($(date +%s) - started)) s, log $name.log"
    tail -n 40 "$LIVE_OUT/$name.log" | sed 's/^/    /'
  fi
}

# not_run <name> <why>: a step this machine can't do, said in the log.
not_run() {
  result "$1" not-run "$2"
}

# fetch_checked <url> <sha256> <file>: a tool's release, refused unless its SHA-256 matches.
fetch_checked() {
  curl -fsSL --retry 3 -o "$3" "$1" || return 1
  echo "$2  $3" | sha256sum -c - || {
    echo "the SHA-256 of $1 isn't the pinned one" >&2
    return 1
  }
}

# finish: the summary of results, and the script's exit code.
finish() {
  say "summary:"
  sed 's/^/  /' "$LIVE_RESULTS" | tee -a "$LIVE_OUT/steps.log"
  exit "$LIVE_FAILED"
}
