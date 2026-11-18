// The egress baseline on Docker (ADR 0029, ADR 0031, F-116): a box can't reach private address
// ranges, the cloud metadata address or another box. The agent's container is on an `internal`
// network, with no route out at all: it reaches only its sidecar. Each sidecar is on the shared
// egress network, with inter-container traffic off, and these host rules stop it reaching private
// ranges and the metadata address, except the ostra server and anything the admin allows.
//
// They go in Docker's `DOCKER-USER` chain, which Docker leaves to the host. Applying them needs
// root on the host, so it's a step of installing a pool runner (`deploy/egress-baseline.sh`), not
// something the runner does. Unverified until the live run on Linux (F-116 stays planned).

/** The ranges a box never reaches: RFC 1918, carrier-grade NAT, link-local (the metadata address), and IPv6's. */
export const BLOCKED_V4 = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16"] as const;
export const BLOCKED_V6 = ["fc00::/7", "fe80::/10"] as const;
export const METADATA_ADDRESS = "169.254.169.254";

export type EgressInput = {
  /** The egress network's subnet, such as `172.30.0.0/16`. */
  readonly egressSubnet: string;
  /** Addresses the sidecars may reach in the blocked ranges: the ostra server, a registry. */
  readonly allow: readonly string[];
};

/**
 * `iptables` argument arrays, in order: the allows, replies, then the drops, each inserted at its
 * position, ahead of the `RETURN` Docker keeps at the chain's end. Never a shell line.
 */
export const egressRules = (input: EgressInput): readonly (readonly string[])[] => {
  const bodies: string[][] = [
    ...input.allow.map((address) => ["-s", input.egressSubnet, "-d", address, "-j", "ACCEPT"]),
    // Replies to connections the sidecar opened.
    ["-s", input.egressSubnet, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"],
    ["-s", input.egressSubnet, "-d", METADATA_ADDRESS, "-j", "DROP"],
    ...BLOCKED_V4.map((range) => ["-s", input.egressSubnet, "-d", range, "-j", "DROP"]),
  ];
  return bodies.map((body, index) => ["-I", "DOCKER-USER", String(index + 1), ...body]);
};
