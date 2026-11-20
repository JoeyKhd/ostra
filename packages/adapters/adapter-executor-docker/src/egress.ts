import { EGRESS_BLOCKED_V4, EGRESS_BLOCKED_V6, hostCidr, isIpv6, METADATA_ADDRESS } from "@ostra/adapter-sdk";

// The egress baseline on Docker (ADR 0029, ADR 0031, ADR 0060, F-116; milestone 5's ticket 24): a
// box can't reach private address ranges, the cloud metadata address, another box or the host. The
// agent's container is on an `internal` network, with no route out at all: it reaches only its
// sidecar. Each sidecar is on the shared egress network, with inter-container traffic off, and
// these host rules stop it reaching the baseline's ranges (`EGRESS_BLOCKED_V4`, `EGRESS_BLOCKED_V6`,
// the one list the `kubernetes` NetworkPolicy is built from too) and the host itself, except the
// ostra server's address on its port (TCP only, as `kubernetes`' policy has it: on compose that
// address is the Docker host's gateway, and any other port on it is the pool host's own services)
// and `OSTRA_EGRESS_ALLOW` (addresses, on every port), the only accepts.
//
// - `DOCKER-USER` (traffic the host forwards): the accepts, then a reject for each range.
// - `INPUT` (traffic to the host itself, which is how a container reaches its network's gateway and
//   anything listening on the host): the accepts, then a reject of the rest from the egress subnet.
//
// A rule rejects rather than drops (`icmp-admin-prohibited`), so a probe sees a block at once and a
// timeout stays inconclusive. A host whose DNS resolver is in a private range lists it in
// `OSTRA_EGRESS_ALLOW`. The rules go in Docker's own chains, which Docker leaves to the host;
// applying them needs root on the host, so it's a step of installing a pool runner
// (`deploy/egress-baseline.sh`, which applies exactly these), not something the runner does.

/** The ranges a box never reaches (the baseline's one list), kept under their milestone 1 names. */
export const BLOCKED_V4: readonly string[] = EGRESS_BLOCKED_V4;
export const BLOCKED_V6: readonly string[] = EGRESS_BLOCKED_V6;
export { METADATA_ADDRESS };

export type EgressInput = {
  /** The egress network's IPv4 subnet, such as `172.30.0.0/16`. */
  readonly egressSubnet: string;
  /** Its IPv6 subnet, when the network has one: the `ip6tables` rules are only made with it. */
  readonly egressSubnetV6?: string;
  /** The ostra server's address as the sidecars reach it: the baseline's one exception, on `serverPort` only. */
  readonly server: string;
  /** The server's TCP port there (core's, such as compose's `8787`): the only port the server's address is open on. */
  readonly serverPort: number;
  /** `OSTRA_EGRESS_ALLOW`: addresses or CIDRs in the blocked ranges an admin allows, such as a private model endpoint. */
  readonly allow: readonly string[];
};

/** One rule: the program and its arguments, an array, never a shell line. */
export type EgressRule = { readonly program: "iptables" | "ip6tables"; readonly args: readonly string[] };

const REJECT = { iptables: "icmp-admin-prohibited", ip6tables: "icmp6-adm-prohibited" } as const;

/** An accept: the server's address on its TCP port, or an allowed address on every port. */
type Accept = { readonly address: string; readonly tcpPort?: number };

const acceptBody = (subnet: string, accept: Accept): string[] => [
  "-s",
  subnet,
  "-d",
  hostCidr(accept.address),
  ...(accept.tcpPort === undefined ? [] : ["-p", "tcp", "--dport", String(accept.tcpPort)]),
  "-j",
  "ACCEPT",
];

/** One family's rules, each inserted at its position, ahead of what Docker and the host keep after them. */
const family = (program: EgressRule["program"], subnet: string, accepts: readonly Accept[], ranges: readonly string[]): readonly EgressRule[] => {
  const forward: string[][] = [
    ...accepts.map((accept) => acceptBody(subnet, accept)),
    ...ranges.map((range) => ["-s", subnet, "-d", range, "-j", "REJECT", "--reject-with", REJECT[program]]),
  ];
  const input: string[][] = [...accepts.map((accept) => acceptBody(subnet, accept)), ["-s", subnet, "-j", "REJECT", "--reject-with", REJECT[program]]];
  return [
    ...forward.map((body, index) => ({ program, args: ["-I", "DOCKER-USER", String(index + 1), ...body] })),
    ...input.map((body, index) => ({ program, args: ["-I", "INPUT", String(index + 1), ...body] })),
  ];
};

/** Every rule of the baseline, `iptables` then `ip6tables`, in the order `deploy/egress-baseline.sh` applies them. */
export const egressRuleSet = (input: EgressInput): readonly EgressRule[] => {
  const accepts: readonly Accept[] = [{ address: input.server, tcpPort: input.serverPort }, ...input.allow.map((address) => ({ address }))];
  return [
    ...family("iptables", input.egressSubnet, accepts.filter((accept) => !isIpv6(accept.address)), EGRESS_BLOCKED_V4),
    ...(input.egressSubnetV6 === undefined ? [] : family("ip6tables", input.egressSubnetV6, accepts.filter((accept) => isIpv6(accept.address)), EGRESS_BLOCKED_V6)),
  ];
};

/** The `iptables` rules' arguments alone (milestone 1's shape). */
export const egressRules = (input: EgressInput): readonly (readonly string[])[] =>
  egressRuleSet(input)
    .filter((rule) => rule.program === "iptables")
    .map((rule) => rule.args);
