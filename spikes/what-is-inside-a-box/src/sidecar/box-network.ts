// Address checks for the sidecar's own ports: which connections come from
// inside the box (the agent's container or a service) and must be refused on
// the handoff and control ports.
//
// - Docker: the agent and the services share the box network with the
//   sidecar. Anything from the box network's CIDR is inside.
// - Kubernetes: the whole pod shares one network namespace. Anything from
//   loopback or from one of the pod's own addresses is inside.

import { networkInterfaces } from "node:os";

export type BoxNetwork = {
  /** CIDRs of the box network (Docker). */
  readonly boxCidrs: readonly string[];
  /** The agent shares this network namespace (a Kubernetes pod). */
  readonly sharedNetns: boolean;
};

type Parsed = { readonly family: 4 | 6; readonly value: bigint };

const parseV4 = (text: string): bigint | undefined => {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const n = Number(part);
    if (n > 255) return undefined;
    value = (value << 8n) | BigInt(n);
  }
  return value;
};

const parseV6 = (text: string): bigint | undefined => {
  const zoneless = text.split("%")[0] ?? "";
  let head = zoneless;
  let tailV4: bigint | undefined;
  const lastColon = zoneless.lastIndexOf(":");
  if (zoneless.includes(".") && lastColon !== -1) {
    tailV4 = parseV4(zoneless.slice(lastColon + 1));
    if (tailV4 === undefined) return undefined;
    head = `${zoneless.slice(0, lastColon)}:0:0`;
  }
  const halves = head.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] === "" || halves[0] === undefined ? [] : halves[0].split(":");
  const right = halves.length === 2 && halves[1] !== "" && halves[1] !== undefined ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return undefined;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined;
    value = (value << 16n) | BigInt(Number.parseInt(group, 16));
  }
  if (tailV4 !== undefined) value = (value & ~0xffffffffn) | tailV4;
  return value;
};

/** Parses an address; an IPv4-mapped IPv6 address becomes IPv4. */
export const parseAddress = (text: string): Parsed | undefined => {
  const v4 = parseV4(text);
  if (v4 !== undefined) return { family: 4, value: v4 };
  const v6 = parseV6(text);
  if (v6 === undefined) return undefined;
  if (v6 >> 32n === 0xffffn) return { family: 4, value: v6 & 0xffffffffn };
  return { family: 6, value: v6 };
};

export const inCidr = (address: string, cidr: string): boolean => {
  const [base = "", bitsText = ""] = cidr.split("/");
  const a = parseAddress(address);
  const b = parseAddress(base);
  if (a === undefined || b === undefined) return false;
  if (a.family !== b.family) return false;
  const width = a.family === 4 ? 32n : 128n;
  const bits = BigInt(bitsText === "" ? Number(width) : Number(bitsText));
  if (bits < 0n || bits > width) return false;
  const shift = width - bits;
  return a.value >> shift === b.value >> shift;
};

/** The ranges the egress baseline closes: private, shared, link-local (metadata), loopback and other special ranges. */
export const BLOCKED_V4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "224.0.0.0/4",
  "240.0.0.0/4",
] as const;

export const BLOCKED_V6 = ["::1/128", "::/128", "fc00::/7", "fe80::/10", "ff00::/8", "64:ff9b:1::/48"] as const;

export const isBlockedDestination = (address: string): boolean =>
  [...BLOCKED_V4, ...BLOCKED_V6].some((cidr) => inCidr(address, cidr));

const localAddresses = (): string[] =>
  Object.values(networkInterfaces())
    .flatMap((list) => list ?? [])
    .map((entry) => entry.address);

export const isInsideBox = (remote: string, network: BoxNetwork): boolean => {
  if (network.boxCidrs.some((cidr) => inCidr(remote, cidr))) return true;
  if (!network.sharedNetns) return false;
  if (inCidr(remote, "127.0.0.0/8") || inCidr(remote, "::1/128")) return true;
  const parsed = parseAddress(remote);
  return localAddresses().some((local) => {
    const own = parseAddress(local);
    if (own === undefined || parsed === undefined) return false;
    return own.family === parsed.family && own.value === parsed.value;
  });
};
