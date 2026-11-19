import dns from "node:dns/promises";
import net from "node:net";

import { adapterError, ok } from "@ostra/adapter-sdk";
import type { AdapterResult } from "@ostra/adapter-sdk";

// The SSRF guard of the model provider adapter. A base URL is admin-supplied, and the server calls
// it with a bearer token, so without a check it reaches any host the server can: cloud metadata
// services, core and Postgres on loopback, the internal network. The check resolves the host,
// refuses every private, loopback, link-local and metadata address, and returns the one address it
// vetted, so the connection can be pinned to it (a second lookup could answer differently: DNS
// rebinding). `allowPrivate` opts in to private targets, for a model server on the same network.

const REFUSED = "private address refused: the endpoint is on a private, loopback, link-local or metadata address; an admin can allow private networks with OSTRA_MODEL_ENDPOINT_ALLOW_PRIVATE=true";

/** Names that mean the machine itself or its cloud's metadata service, whatever they resolve to. */
const refusedName = (host: string): boolean =>
  host === "localhost" || host.endsWith(".localhost") || host === "metadata.google.internal";

const ipv4Value = (address: string): number | undefined => {
  const parts = address.split(".").map(Number);
  const [a, b, c, d] = parts;
  if (parts.length !== 4 || a === undefined || b === undefined || c === undefined || d === undefined) {
    return undefined;
  }
  return ((a * 256 + b) * 256 + c) * 256 + d;
};

/** First address and prefix length of each IPv4 range that is not a public unicast address. */
const privateV4Ranges: readonly (readonly [string, number])[] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
];

const isPrivateV4 = (address: string): boolean => {
  const value = ipv4Value(address);
  if (value === undefined) {
    return true;
  }
  return privateV4Ranges.some(([base, prefix]) => {
    const start = ipv4Value(base);
    return start !== undefined && Math.floor(value / 2 ** (32 - prefix)) === Math.floor(start / 2 ** (32 - prefix));
  });
};

/** The eight 16-bit groups of an IPv6 address, or `undefined` when it isn't one. */
const ipv6Groups = (address: string): readonly number[] | undefined => {
  let text = address.toLowerCase();
  const zone = text.indexOf("%");
  if (zone !== -1) {
    text = text.slice(0, zone);
  }
  // A dotted IPv4 tail (::ffff:1.2.3.4) is two groups.
  const tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail?.[1] !== undefined && tail[2] !== undefined) {
    const value = ipv4Value(tail[2]);
    if (value === undefined) {
      return undefined;
    }
    text = `${tail[1]}${Math.floor(value / 65_536).toString(16)}:${(value % 65_536).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) {
    return undefined;
  }
  const head = (halves[0] ?? "") === "" ? [] : (halves[0] ?? "").split(":");
  const rest = (halves[1] ?? "") === "" ? [] : (halves[1] ?? "").split(":");
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) {
    return undefined;
  }
  const groups = [...head, ...Array.from({ length: halves.length === 1 ? 0 : missing }, () => "0"), ...rest].map((group) =>
    Number.parseInt(group, 16),
  );
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : undefined;
};

const isPrivateV6 = (address: string): boolean => {
  const groups = ipv6Groups(address);
  if (groups === undefined) {
    return true;
  }
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const embedded = `${String(g6 >> 8)}.${String(g6 & 0xff)}.${String(g7 >> 8)}.${String(g7 & 0xff)}`;
  const zeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  // ::, ::1, IPv4-compatible (::a.b.c.d) and IPv4-mapped (::ffff:a.b.c.d): judged by the IPv4 inside.
  if (zeroPrefix && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) {
    return true;
  }
  if (zeroPrefix && (g5 === 0 || g5 === 0xffff)) {
    return isPrivateV4(embedded);
  }
  // NAT64 (64:ff9b::/96) carries an IPv4 address in its last 32 bits.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPrivateV4(embedded);
  }
  // 6to4 (2002::/16) carries one right after the prefix.
  if (g0 === 0x2002) {
    return isPrivateV4(`${String(g1 >> 8)}.${String(g1 & 0xff)}.${String(g2 >> 8)}.${String(g2 & 0xff)}`);
  }
  return (
    (g0 & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (g0 & 0xffc0) === 0xfec0 || // site-local fec0::/10 (deprecated)
    (g0 & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (g0 & 0xff00) === 0xff00 // multicast ff00::/8
  );
};

/** Whether an IP address is one a public endpoint never has. An address that isn't one counts as private. */
export const isPrivateAddress = (address: string): boolean => {
  const family = net.isIP(address);
  if (family === 4) {
    return isPrivateV4(address);
  }
  return family === 6 ? isPrivateV6(address) : true;
};

export type VettedAddress = { readonly address: string; readonly family: 4 | 6 };

export type Resolver = (hostname: string) => Promise<readonly VettedAddress[]>;

const systemResolver: Resolver = async (hostname) => {
  const found = await dns.lookup(hostname, { all: true, order: "verbatim" });
  return found.flatMap((entry) => (entry.family === 4 || entry.family === 6 ? [{ address: entry.address, family: entry.family }] : []));
};

export type GuardOptions = {
  /** Allow private, loopback and link-local targets (OSTRA_MODEL_ENDPOINT_ALLOW_PRIVATE). */
  readonly allowPrivate: boolean;
  /** Replaces the system resolver; for tests. */
  readonly resolve?: Resolver;
};

/**
 * Resolves the URL's host and refuses it when any address is private or the name is one of the
 * refused ones. Returns the address to connect to: the caller connects to exactly that one.
 * A host that resolves to a public and a private address is refused, as the connection could pick either.
 */
export const assertPublicEndpoint = async (url: URL, options: GuardOptions): Promise<AdapterResult<VettedAddress>> => {
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (host === "") {
    return adapterError("invalid-input", "the base URL has no host");
  }
  if (!options.allowPrivate && refusedName(host)) {
    return adapterError("invalid-input", REFUSED);
  }
  const literal = net.isIP(host);
  let addresses: readonly VettedAddress[];
  if (literal === 4 || literal === 6) {
    addresses = [{ address: host, family: literal }];
  } else {
    try {
      addresses = await (options.resolve ?? systemResolver)(host);
    } catch {
      return adapterError("unavailable", "the endpoint could not be reached: its host name did not resolve");
    }
  }
  const first = addresses[0];
  if (first === undefined) {
    return adapterError("unavailable", "the endpoint could not be reached: its host name did not resolve");
  }
  if (!options.allowPrivate && addresses.some((entry) => isPrivateAddress(entry.address))) {
    return adapterError("invalid-input", REFUSED);
  }
  return ok(first);
};
