import { inCidr, isIpv6 } from "@ostra/adapter-sdk";
import { BOX_SUBNET_PREFIX } from "@ostra/protocol";
import type { BoxSubnetPool } from "@ostra/protocol";

// The `docker` executor owns its boxes' subnets (ADR 0029, Q154, F-017). Docker's default address
// pools hold at most 31 networks (moby's `ipamutils`: 15 of /16 and 16 of /20), and every box has a
// network of its own, so 50 boxes on one host would run them out. The pool runner carves each box's
// network out of a pool it manages instead: a /24 it names in the create call's `IPAM`, never one
// Docker picks. The pool is `OSTRA_BOX_SUBNET_POOL` (spike 3's `10.89.0.0/16` by default, clear of
// Docker's own pools); a /24 another network on the host holds, a box's or anything else's, is
// skipped. The boxes share one egress network, which Docker's pools give its subnet as before.
// The pool's shape (an IPv4 network of /8 to /24, no host bits) is the setting's own rule,
// `parseBoxSubnetPool` in `@ostra/protocol`, which the config schema checks it with too.

const toAddress = (value: number): string => [24, 16, 8, 0].map((shift) => String(Math.floor(value / 2 ** shift) % 256)).join(".");

/** Whether two IPv4 CIDRs share an address: one holds the other's network address. */
export const subnetsOverlap = (one: string, other: string): boolean => {
  const [oneBase = ""] = one.split("/");
  const [otherBase = ""] = other.split("/");
  return inCidr(oneBase, other) || inCidr(otherBase, one);
};

/**
 * The pool's first /24 that overlaps none of the subnets the host's networks hold, or `null` when
 * the pool has none left. IPv6 subnets can't overlap it and are passed over.
 */
export const freeSubnet = (pool: BoxSubnetPool, taken: readonly string[]): string | null => {
  const held = taken.filter((subnet) => !isIpv6(subnet));
  for (let index = 0; index < pool.size; index += 1) {
    const candidate = `${toAddress(pool.first + index * 2 ** (32 - BOX_SUBNET_PREFIX))}/${String(BOX_SUBNET_PREFIX)}`;
    if (!held.some((subnet) => subnetsOverlap(candidate, subnet))) {
      return candidate;
    }
  }
  return null;
};
