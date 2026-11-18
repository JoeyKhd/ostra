#!/usr/bin/env bash
# Runs `pnpm spike` inside the spike's container (container/Dockerfile), behind
# an egress firewall: loopback and replies only, plus the model endpoint's
# addresses when OSTRA_DEV_MODEL_BASE_URL is set. T1 captures its own turn
# with tcpdump and asserts the capture holds nothing outside loopback.
# Arguments go to the harness (e.g. --only=T1,T3 or --allow-skipped).
set -euo pipefail
cd /spike

# The models.dev catalog for T3 (b)/(c), fetched before the firewall goes up,
# the way ostra's server would fetch it (ADR 0033).
if [ -z "${SPIKE_MODELS_JSON:-}" ] && [ ! -f .runs/catalog/models.json ]; then
  mkdir -p .runs/catalog
  curl -fsS --max-time 30 https://models.dev/api.json -o .runs/catalog/models.json \
    || echo "models.dev unreachable: T3 (b) and (c) will be SKIPPED"
fi

# The model endpoint's addresses, resolved before the firewall goes up.
endpoint_ips=""
endpoint_port="443"
if [ -n "${OSTRA_DEV_MODEL_BASE_URL:-}" ]; then
  host="$(node -e 'console.log(new URL(process.argv[1]).hostname)' "$OSTRA_DEV_MODEL_BASE_URL")"
  endpoint_port="$(node -e 'const u=new URL(process.argv[1]);console.log(u.port||(u.protocol==="http:"?"80":"443"))' "$OSTRA_DEV_MODEL_BASE_URL")"
  endpoint_ips="$(getent ahostsv4 "$host" | awk '{print $1}' | sort -u || true)"
fi

# Egress firewall: drop everything outbound except loopback (the key proxy,
# the stubs, Docker's DNS at 127.0.0.11) and replies.
for table in iptables ip6tables; do
  "$table" -P OUTPUT DROP
  "$table" -A OUTPUT -o lo -j ACCEPT
  "$table" -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
done
for ip in $endpoint_ips; do
  iptables -A OUTPUT -d "$ip" -p tcp --dport "$endpoint_port" -j ACCEPT
done
echo "egress firewall up: loopback only$([ -n "$endpoint_ips" ] && echo ", plus the model endpoint on port $endpoint_port")"

exec node src/harness/spike.ts "$@"
