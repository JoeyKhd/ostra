#!/usr/bin/env bash
# Checks the live proof logs for anything that looks like a secret before they're kept in the repo
# (ticket 35, ADR 0061): a join token, a private key, a GitHub or model token, a registry
# credential in a URL. The jobs use no secret, so a hit is a bug: the script names the file and
# line, never the match, and exits 1.
#
#   scripts/live/check-logs.sh <folder>
set -euo pipefail

dir="${1:?the folder of logs}"
patterns=(
  'ostra-join-[A-Za-z0-9_-]{20,}'
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  'gh[pousr]_[A-Za-z0-9]{30,}'
  'github_pat_[A-Za-z0-9_]{30,}'
  'sk-(ant-)?[A-Za-z0-9_-]{30,}'
  'lin_(api|oauth)_[A-Za-z0-9]{30,}'
  '://[^/ :@]+:[^/ @]+@'
  'Authorization: (Bearer|Basic) [A-Za-z0-9._~+/=-]{16,}'
)
found=0
for pattern in "${patterns[@]}"; do
  while IFS= read -r hit; do
    echo "a secret-like string in ${hit%%:*} (line $(echo "$hit" | cut -d: -f2)), pattern: $pattern"
    found=1
  done < <(grep -rEn --binary-files=without-match -e "$pattern" "$dir" | cut -d: -f1,2 || true)
done
if [ "$found" -ne 0 ]; then exit 1; fi
echo "no secret-like string in $dir"
