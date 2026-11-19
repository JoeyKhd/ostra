// The egress baseline's one list (F-116, ADR 0031, ADR 0060, ADR 0029 as amended; milestone 5's
// ticket 24): every range a box never reaches, in IPv4 and IPv6. The `docker` executor's host rules
// (`egressRuleSet`), the `kubernetes` executor's NetworkPolicy (`baselineEgressPolicy`, which the
// runner chart renders) and the probes that check them (`@ostra/adapter-sdk/testing`) are all built
// from it, so a range added here is closed everywhere at once. The ranges are spike 3's NetworkPolicy
// (`spikes/what-is-inside-a-box/deploy/k8s/egress-baseline.networkpolicy.yaml`): the private ranges,
// carrier-grade NAT, link-local with the cloud metadata address, loopback, and the reserved blocks a
// pod or a container could route.

/** IPv4: RFC 1918, carrier-grade NAT, link-local (the metadata address), loopback, IETF protocol assignments, benchmarking, multicast. */
export const EGRESS_BLOCKED_V4 = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "192.0.0.0/24",
  "198.18.0.0/15",
  "224.0.0.0/4",
] as const;

/** IPv6: unique-local, link-local, loopback, multicast. */
export const EGRESS_BLOCKED_V6 = ["fc00::/7", "fe80::/10", "::1/128", "ff00::/8"] as const;

/** The cloud metadata address, inside `169.254.0.0/16`. */
export const METADATA_ADDRESS = "169.254.169.254";

/** Whether an address or a CIDR is IPv6. */
export const isIpv6 = (address: string): boolean => address.includes(":");

/** An address as a CIDR of one host; a CIDR as it is. */
export const hostCidr = (address: string): string => (address.includes("/") ? address : isIpv6(address) ? `${address}/128` : `${address}/32`);

type Parsed = { readonly family: 4 | 6; readonly value: bigint };

const parseV4 = (text: string): bigint | undefined => {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return undefined;
    value = (value << 8n) | BigInt(Number(part));
  }
  return value;
};

const parseV6 = (text: string): bigint | undefined => {
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ?? "";
  const tail = halves[1] ?? "";
  const left = head === "" ? [] : head.split(":");
  const right = halves.length === 2 && tail !== "" ? tail.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return undefined;
  let value = 0n;
  for (const group of [...left, ...Array.from({ length: missing }, () => "0"), ...right]) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined;
    value = (value << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return value;
};

const parse = (address: string): Parsed | undefined => {
  const v4 = parseV4(address);
  if (v4 !== undefined) return { family: 4, value: v4 };
  const v6 = parseV6(address);
  return v6 === undefined ? undefined : { family: 6, value: v6 };
};

/** Whether an address is inside a CIDR of the same family (ported from spike 3's `box-network.ts`). */
export const inCidr = (address: string, cidr: string): boolean => {
  const [base = "", bitsText = ""] = cidr.split("/");
  const a = parse(address);
  const b = parse(base);
  if (a === undefined || b === undefined) return false;
  if (a.family !== b.family) return false;
  const width = a.family === 4 ? 32n : 128n;
  const bits = BigInt(bitsText === "" ? Number(width) : Number(bitsText));
  if (bits < 0n || bits > width) return false;
  const shift = width - bits;
  return a.value >> shift === b.value >> shift;
};

/** Whether the baseline closes an address: it's inside one of the list's ranges. */
export const isBlockedByBaseline = (address: string): boolean =>
  (isIpv6(address) ? EGRESS_BLOCKED_V6 : EGRESS_BLOCKED_V4).some((range) => inCidr(address, range));
