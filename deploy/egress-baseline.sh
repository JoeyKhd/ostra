#!/bin/sh
# The egress baseline for a docker pool host (ADR 0029, ADR 0031, ADR 0060, F-116): one box's
# sidecar can't reach private ranges, the metadata address, another box or the host itself, except
# the ostra server's address on its TCP port and the addresses an admin allows (OSTRA_EGRESS_ALLOW,
# on every port). Nothing on the boxes' own networks reaches the host either. Run once as root on
# the pool host, after Docker starts.
#
#   sudo ./deploy/egress-baseline.sh <egress subnet> <ostra server address> <ostra server port> [allowed address...]
#   sudo EGRESS_SUBNET_V6=fd00:ab::/64 ./deploy/egress-baseline.sh 172.30.0.0/16 172.17.0.1 8787
#   sudo OSTRA_BOX_SUBNET_POOL=10.200.0.0/20 ./deploy/egress-baseline.sh 172.30.0.0/16 172.17.0.1 8787
#
# These are exactly the rules `egressRuleSet` in
# packages/adapters/adapter-executor-docker/src/egress.ts builds, from the baseline's one list
# (EGRESS_BLOCKED_V4 and EGRESS_BLOCKED_V6 in packages/adapter-sdk/src/executor/egress-baseline.ts);
# its test runs this script and checks every rule. A rule rejects rather than drops, so a probe sees
# a block at once. A host whose DNS resolver is in a private range lists it as an allowed address.
# The agent's containers have no route out: their box network is `internal`. Docker enforces that
# on forwarded traffic only, and the box network's gateway is the host's own address, so one rule
# closes the host to every box network: an INPUT reject of the runner's subnet pool
# (OSTRA_BOX_SUBNET_POOL, the runner's setting, 10.89.0.0/16 when unset; give it the same value).
set -eu

subnet="${1:?the egress network's subnet, such as 172.30.0.0/16}"
server="${2:?the ostra server's address, as the boxes reach it}"
port="${3:?the ostra server's port there, such as 8787}"
shift 3
subnet6="${EGRESS_SUBNET_V6:-}"
# Keep the default equal to DEFAULT_BOX_SUBNET_POOL in packages/protocol/src/runner/config.ts (the test checks it).
pool="${OSTRA_BOX_SUBNET_POOL:-10.89.0.0/16}"

# The pool: an IPv4 network of /8 to /24, such as 10.89.0.0/16, nothing else. Checked before any
# rule goes in, so a wrong one leaves the host as it was.
pool_is_network() {
  case "$1" in
    *[!0-9./]* | */*/* | *.*.*.*.*) return 1 ;;
    [0-9]*.[0-9]*.[0-9]*.[0-9]*/[0-9]*) ;;
    *) return 1 ;;
  esac
  bits="${1#*/}"
  [ "${#bits}" -le 2 ] && [ "$bits" -ge 8 ] && [ "$bits" -le 24 ] || return 1
  rest="${1%/*}."
  while [ -n "$rest" ]; do
    octet="${rest%%.*}"
    rest="${rest#*.}"
    [ "${#octet}" -le 3 ] && [ "$octet" -le 255 ] || return 1
  done
}
if ! pool_is_network "$pool"; then
  echo "not an IPv4 network of /8 to /24: $pool" >&2
  exit 64
fi

# The server's port: a number from 1 to 65535, nothing else.
case "$port" in
  '' | *[!0-9]* | 0*) echo "not a port: $port" >&2; exit 64 ;;
esac
if [ "$port" -gt 65535 ]; then
  echo "not a port: $port" >&2
  exit 64
fi

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

case "$server" in
  *:*) server_program=ip6tables ;;
  *) server_program=iptables ;;
esac
server_cidr="$(cidr "$server")"

accepts_v4=""
accepts_v6=""
for address in "$@"; do
  case "$address" in
    *:*) accepts_v6="$accepts_v6 $(cidr "$address")" ;;
    *) accepts_v4="$accepts_v4 $(cidr "$address")" ;;
  esac
done

# The accepts of one chain, from position 1: the server's address on its TCP port (when it's of
# this family), then each allowed address on every port.
accept_rules() {
  chain="$1"
  position=1
  if [ "$program" = "$server_program" ]; then
    "$program" -I "$chain" "$position" -s "$from" -d "$server_cidr" -p tcp --dport "$port" -j ACCEPT
    position=$((position + 1))
  fi
  for address in $accepts; do
    "$program" -I "$chain" "$position" -s "$from" -d "$address" -j ACCEPT
    position=$((position + 1))
  done
}

# One family: in DOCKER-USER the accepts, then a reject per range; in INPUT the accepts, then a
# reject of the rest from the subnet (the host itself, the network's gateway included).
family() {
  program="$1" from="$2" reject="$3" ranges="$4" accepts="$5"
  accept_rules DOCKER-USER
  for range in $ranges; do
    "$program" -I DOCKER-USER "$position" -s "$from" -d "$range" -j REJECT --reject-with "$reject"
    position=$((position + 1))
  done
  accept_rules INPUT
  "$program" -I INPUT "$position" -s "$from" -j REJECT --reject-with "$reject"
}

family iptables "$subnet" icmp-admin-prohibited "$blocked_v4" "$accepts_v4"
# The boxes' own networks: nothing from them to the host, its gateway on each box network included,
# and no accept (the sidecar reaches the server from the egress network). Only in INPUT: an agent's
# traffic to its sidecar and services crosses DOCKER-USER on their shared bridge (Docker turns on
# br_netfilter), and a reject there would cut it.
iptables -I INPUT "$((position + 1))" -s "$pool" -j REJECT --reject-with icmp-admin-prohibited
if [ -n "$subnet6" ]; then
  family ip6tables "$subnet6" icmp6-adm-prohibited "$blocked_v6" "$accepts_v6"
fi
echo "egress baseline applied to $subnet${subnet6:+ and $subnet6}, and the host closed to $pool"
