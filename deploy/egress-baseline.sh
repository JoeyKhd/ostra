#!/bin/sh
# The egress baseline for a docker pool host (ADR 0029, ADR 0031, F-116): one box's sidecar can't
# reach private ranges, the metadata address or another box. Run once as root on the pool host,
# after Docker starts. The rules are the ones `egressRules` in
# packages/adapters/adapter-executor-docker/src/egress.ts builds, and its test checks them.
#
#   sudo ./deploy/egress-baseline.sh 172.30.0.0/16 <ostra server address>...
#
# The agent's containers need no rule: their network is `internal`, with no route out at all.
# Unverified until the live run on Linux: F-116 stays planned.
set -eu

subnet="${1:?the egress network's subnet, such as 172.30.0.0/16}"
shift

position=1
insert() {
  iptables -I DOCKER-USER "$position" -s "$subnet" "$@"
  position=$((position + 1))
}

for allowed in "$@"; do
  insert -d "$allowed" -j ACCEPT
done
insert -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
insert -d 169.254.169.254 -j DROP
for range in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16; do
  insert -d "$range" -j DROP
done
echo "egress baseline applied to $subnet"
