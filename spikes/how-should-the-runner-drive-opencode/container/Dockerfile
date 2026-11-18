# Spike 1 on Linux in a container: the B1 "Linux in a container" run, T1's
# packet capture behind an egress firewall, and the /proc/<pid>/environ checks
# of T3 and B4. Build from the spike's directory:
#
#   docker build -t ostra-spike1 -f container/Dockerfile .
#   docker run --rm --cap-add NET_ADMIN --cap-add NET_RAW \
#     --env-file ~/.config/ostra-dev/model.env ostra-spike1
#
# NET_ADMIN sets the egress firewall (iptables), NET_RAW lets tcpdump capture.
# The model endpoint is optional: without it the endpoint checks are SKIPPED.

FROM node:24.14.0-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git procps lsof tcpdump iptables ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@11.28.2 --activate

WORKDIR /spike
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN chmod +x container/run.sh

ENV OSTRA_SPIKE_CONTAINER=1
ENTRYPOINT ["container/run.sh"]
