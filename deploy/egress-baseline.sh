#!/bin/sh
# The egress baseline for a docker pool host (ADR 0029, ADR 0031, ADR 0060, F-116): one box's
# sidecar can't reach private ranges, the metadata address, another box or the host itself, except
# the ostra server's address and the addresses an admin allows (OSTRA_EGRESS_ALLOW). Run once as
# root on the pool host, after Docker starts.
#
#   sudo ./deploy/egress-baseline.sh <egress subnet> <ostra server address> [allowed address...]
#   sudo EGRESS_SUBNET_V6=fd00:ab::/64 ./deploy/egress-baseline.sh 172.30.0.0/16 172.17.0.1
#
# These are exactly the rules `egressRuleSet` in
# packages/adapters/adapter-executor-docker/src/egress.ts builds, from the baseline's one list
# (EGRESS_BLOCKED_V4 and EGRESS_BLOCKED_V6 in packages/adapter-sdk/src/executor/egress-baseline.ts);
# its test runs this script and checks every rule. A rule rejects rather than drops, so a probe sees
# a block at once. A host whose DNS resolver is in a private range lists it as an allowed address.
# The agent's containers need no rule: their network is `internal`, with no route out at all.
set -eu

subnet="${1:?the egress network's subnet, such as 172.30.0.0/16}"
server="${2:?the ostra server's address, as the boxes reach it}"
shift 2
subnet6="${EGRESS_SUBNET_V6:-}"

# The baseline's one list: keep it equal to egress-baseline.ts (the test checks it).
blocked_v4="10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 127.0.0.0/8 192.0.0.0/24 198.18.0.0/15 224.0.0.0/4"
blocked_v6="fc00::/7 fe80::/10 ::1/128 ff00::/8"

# An address or a CIDR, nothing else: each becomes one argument, never a shell word of its own.
for address in "$subnet" "$server" "$@" ${subnet6:+"$subnet6"}; do
  case "$address" in
    '' | *[!0-9A-Fa-f.:/]*) echo "not an address: $address" >&2; exit 64 ;;
  esac
done

cidr() {
  case "$1" in
    */*) echo "$1" ;;
    *:*) echo "$1/128" ;;
    *) echo "$1/32" ;;
  esac
}

accepts_v4=""
accepts_v6=""
for address in "$server" "$@"; do
  case "$address" in
    *:*) accepts_v6="$accepts_v6 $(cidr "$address")" ;;
    *) accepts_v4="$accepts_v4 $(cidr "$address")" ;;
  esac
done

# One family: in DOCKER-USER the accepts, then a reject per range; in INPUT the accepts, then a
# reject of the rest from the subnet (the host itself, the network's gateway included).
family() {
  program="$1" from="$2" reject="$3" ranges="$4" accepts="$5"
  position=1
  for address in $accepts; do
    "$program" -I DOCKER-USER "$position" -s "$from" -d "$address" -j ACCEPT
    position=$((position + 1))
  done
  for range in $ranges; do
    "$program" -I DOCKER-USER "$position" -s "$from" -d "$range" -j REJECT --reject-with "$reject"
    position=$((position + 1))
  done
  position=1
  for address in $accepts; do
    "$program" -I INPUT "$position" -s "$from" -d "$address" -j ACCEPT
    position=$((position + 1))
  done
  "$program" -I INPUT "$position" -s "$from" -j REJECT --reject-with "$reject"
}

family iptables "$subnet" icmp-admin-prohibited "$blocked_v4" "$accepts_v4"
if [ -n "$subnet6" ]; then
  family ip6tables "$subnet6" icmp6-adm-prohibited "$blocked_v6" "$accepts_v6"
fi
echo "egress baseline applied to $subnet${subnet6:+ and $subnet6}"
