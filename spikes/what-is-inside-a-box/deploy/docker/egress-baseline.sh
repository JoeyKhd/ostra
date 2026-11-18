#!/usr/bin/env bash
# The egress baseline on Docker (ADR 0031, F-116): host rules that stop a box
# reaching private address ranges, the cloud metadata address, or another box.
# Allowlists per environment (F-052) come later and sit on top of this.
#
# Two halves make the baseline on Docker:
#   1. The agent's container is on an `internal: true` network (compose.box.yaml),
#      so it has no route off the host at all. Its only exit is the sidecar's
#      proxies. That is the strong half.
#   2. These host rules apply to the sidecar's egress network, the one part of
#      the box with a route off the host. The sidecar runs ostra's own code,
#      not agent output, but the baseline still denies it the ranges a task has
#      no business reaching, so a bug can't become an SSRF pivot.
#
# Docker filters container egress in the DOCKER-USER chain, which Docker leaves
# untouched. Rules here are evaluated before Docker's own ACCEPTs.
#
# Usage:  sudo deploy/docker/egress-baseline.sh <box-egress-subnet-cidr>
#   e.g.  sudo deploy/docker/egress-baseline.sh 172.20.0.0/16
#
# It is idempotent: it flushes an ostra chain and rebuilds it.

set -euo pipefail

SUBNET="${1:?usage: egress-baseline.sh <box-egress-subnet-cidr>}"
CHAIN="OSTRA-EGRESS"

# Ranges a box must never reach: cloud metadata, link-local, private (RFC1918),
# carrier-grade NAT, loopback, and the benchmarking/special ranges.
BLOCKED=(
  169.254.0.0/16   # link-local, incl. 169.254.169.254 metadata
  10.0.0.0/8       # private
  172.16.0.0/12    # private (Docker's own bridges live here: this blocks box-to-box)
  192.168.0.0/16   # private
  100.64.0.0/10    # carrier-grade NAT
  127.0.0.0/8      # loopback
  192.0.0.0/24
  198.18.0.0/15
)

iptables -N "$CHAIN" 2>/dev/null || iptables -F "$CHAIN"

# Allow replies to connections the sidecar opened.
iptables -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
# Allow DNS to the host resolver only (Docker's embedded DNS at 127.0.0.11 is
# handled inside the netns; external DNS goes to the configured resolver).
# Deny every blocked range for traffic from the box egress subnet.
for cidr in "${BLOCKED[@]}"; do
  iptables -A "$CHAIN" -s "$SUBNET" -d "$cidr" -j DROP
done
# Everything else (the public internet: the model provider, GitHub) is allowed
# by Docker's own rules after this chain RETURNs.
iptables -A "$CHAIN" -j RETURN

# Hook the chain into DOCKER-USER once.
if ! iptables -C DOCKER-USER -j "$CHAIN" 2>/dev/null; then
  iptables -I DOCKER-USER -j "$CHAIN"
fi

echo "egress baseline applied for ${SUBNET}: blocked $(IFS=, ; echo "${BLOCKED[*]}")"
